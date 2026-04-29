import fs from 'node:fs';
import path from 'node:path';

import {
  buildAgentDefinition,
  buildChannelDefinition,
  buildConnectorDefinition,
  getAgent,
  getProjectLayout,
  loadConfig,
  resolveProjectPath,
  saveConfig,
  validateConfigReferences,
} from './store.js';
import {
  assert,
  ensureDir,
  isPlainObject,
  readJson,
  timestamp,
} from './utils.js';

const TOPOLOGY_SPEC_VERSION = 1;
const ENTITY_KINDS = ['agents', 'connectors', 'channels'];
const SECRET_FIELDS = new Set([
  'discordToken',
  'telegramBotToken',
  'kakaoRelayToken',
  'kakaoSessionToken',
]);
const SECRET_REF_FIELDS = {
  discordTokenEnv: 'discordToken',
  telegramBotTokenEnv: 'telegramBotToken',
  kakaoRelayTokenEnv: 'kakaoRelayToken',
  kakaoSessionTokenEnv: 'kakaoSessionToken',
};
const UPSERT_ACTION_BY_KIND = {
  agents: 'agent:upsert',
  connectors: 'connector:upsert',
  channels: 'channel:upsert',
};

export function loadTopologySpec(filePath) {
  assert(filePath, 'Usage: hkclaw-lite topology <plan|apply> --file <file>');
  const resolvedPath = path.resolve(filePath);
  assert(fs.existsSync(resolvedPath), `Topology file does not exist: ${resolvedPath}`);
  const spec = readJson(resolvedPath);
  assert(isPlainObject(spec), 'Topology file must contain a JSON object.');
  return spec;
}

export function exportTopology(projectRoot) {
  const config = loadConfig(projectRoot);
  return {
    version: TOPOLOGY_SPEC_VERSION,
    agents: recordsToTopologyEntries(config.agents),
    connectors: recordsToTopologyEntries(config.connectors),
    channels: recordsToTopologyEntries(config.channels),
  };
}

export function planTopology(
  projectRoot,
  spec,
  {
    actorName = process.env.HKCLAW_LITE_AGENT_NAME,
    env = process.env,
    operation = 'plan',
  } = {},
) {
  const currentConfig = loadConfig(projectRoot);
  const actor = resolveTopologyActor(currentConfig, actorName);
  const normalized = normalizeTopologySpec(spec, { env });
  const { futureConfig, changes } = buildFutureConfig(projectRoot, currentConfig, normalized);
  const blockers = [...normalized.blockers];

  try {
    validateConfigReferences(projectRoot, futureConfig);
  } catch (error) {
    blockers.push(error.message);
  }

  enforceTopologyActorPolicy(projectRoot, {
    operation,
    actor,
    changes,
    blockers,
  });

  const changedCount = changes.filter((change) => change.action !== 'noop').length;
  return {
    actor,
    blockers,
    changes,
    changedCount,
    futureConfig,
    spec: normalized.spec,
  };
}

export function applyTopology(
  projectRoot,
  spec,
  {
    actorName = process.env.HKCLAW_LITE_AGENT_NAME,
    env = process.env,
  } = {},
) {
  return withTopologyLock(projectRoot, () => {
    const plan = planTopology(projectRoot, spec, {
      actorName,
      env,
      operation: 'apply',
    });
    assert(
      plan.blockers.length === 0,
      `Topology apply is blocked: ${plan.blockers.join(' | ')}`,
    );

    if (plan.changedCount > 0) {
      saveConfig(projectRoot, plan.futureConfig);
    }
    writeTopologyAudit(projectRoot, plan);
    return plan;
  });
}

export function formatTopologyPlan(plan, { applied = false } = {}) {
  const lines = [];
  const actorText = plan.actor.type === 'agent' ? `agent:${plan.actor.name}` : 'operator';
  lines.push(
    `${applied ? 'Topology apply' : 'Topology plan'}: changes=${plan.changedCount} actor=${actorText}`,
  );

  if (plan.blockers.length > 0) {
    lines.push('Blockers:');
    for (const blocker of plan.blockers) {
      lines.push(`  - ${blocker}`);
    }
  }

  if (plan.changes.length === 0) {
    lines.push('No topology entries requested.');
    return lines.join('\n');
  }

  lines.push('Changes:');
  for (const change of plan.changes) {
    lines.push(`  - ${change.action} ${singularKind(change.kind)} "${change.name}"`);
    const fieldChanges = changedFields(change.before, change.after);
    if (fieldChanges.length > 0 && change.action !== 'create') {
      lines.push(`    fields: ${fieldChanges.join(', ')}`);
    }
  }

  return lines.join('\n');
}

export function serializeTopologyPlan(plan) {
  return {
    actor:
      plan.actor.type === 'agent'
        ? { type: 'agent', name: plan.actor.name }
        : { type: 'operator', name: null },
    blockers: [...plan.blockers],
    changedCount: plan.changedCount,
    changes: plan.changes.map((change) => ({
      action: change.action,
      kind: singularKind(change.kind),
      name: change.name,
      before: redactTopologyValue(change.before),
      after: redactTopologyValue(change.after),
      fields: changedFields(change.before, change.after),
    })),
  };
}

export function redactTopologyValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactTopologyValue(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      SECRET_FIELDS.has(key) && entryValue !== undefined
        ? '***'
        : redactTopologyValue(entryValue),
    ]),
  );
}

function normalizeTopologySpec(spec, { env }) {
  assert(isPlainObject(spec), 'Topology spec must be a JSON object.');
  const version = spec.version ?? TOPOLOGY_SPEC_VERSION;
  assert(
    version === TOPOLOGY_SPEC_VERSION,
    `Unsupported topology spec version "${version}".`,
  );

  const blockers = [];
  const normalizedSpec = {
    version: TOPOLOGY_SPEC_VERSION,
    intent: typeof spec.intent === 'string' ? spec.intent.trim() : undefined,
    agents: normalizeTopologyEntries('agents', spec.agents, { env, blockers }),
    connectors: normalizeTopologyEntries('connectors', spec.connectors, {
      env,
      blockers,
    }),
    channels: normalizeTopologyEntries('channels', spec.channels, { env, blockers }),
  };

  return {
    blockers,
    spec: normalizedSpec,
  };
}

function normalizeTopologyEntries(kind, entries, { env, blockers }) {
  if (entries === undefined || entries === null) {
    return [];
  }
  assert(Array.isArray(entries), `Topology ${kind} must be an array.`);
  const seenNames = new Set();
  return entries.map((entry, index) => {
    assert(isPlainObject(entry), `Topology ${kind}[${index}] must be an object.`);
    const name = String(entry.name || '').trim();
    assert(name, `Topology ${kind}[${index}].name is required.`);
    assert(!seenNames.has(name), `Topology ${kind} contains duplicate name "${name}".`);
    seenNames.add(name);
    assertNoInlineSecrets(entry, `${kind}[${index}]`);
    return resolveSecretRefs(entry, `${kind}[${index}]`, { env, blockers });
  });
}

function assertNoInlineSecrets(entry, label) {
  for (const fieldName of SECRET_FIELDS) {
    if (entry[fieldName] !== undefined) {
      throw new Error(
        `Inline secret field ${label}.${fieldName} is not allowed; use secretRefs.${fieldName}Env.`,
      );
    }
  }
}

function resolveSecretRefs(entry, label, { env, blockers }) {
  const next = { ...entry };
  const refs = entry.secretRefs;
  delete next.secretRefs;
  if (refs === undefined || refs === null) {
    return next;
  }
  assert(isPlainObject(refs), `${label}.secretRefs must be an object.`);

  for (const [refName, envNameValue] of Object.entries(refs)) {
    const targetField = SECRET_REF_FIELDS[refName];
    assert(targetField, `Unsupported secret ref ${label}.secretRefs.${refName}.`);
    const envName = String(envNameValue || '').trim();
    assert(envName, `${label}.secretRefs.${refName} must name an environment variable.`);
    const secretValue = env?.[envName];
    if (typeof secretValue === 'string' && secretValue.trim()) {
      next[targetField] = secretValue;
    } else {
      blockers.push(`${label}.${targetField} requires missing environment variable ${envName}.`);
    }
  }

  return next;
}

function buildFutureConfig(projectRoot, currentConfig, normalized) {
  const futureConfig = cloneJson(currentConfig);
  const changes = [];

  for (const agent of normalized.spec.agents) {
    const name = agent.name;
    const before = futureConfig.agents?.[name] || null;
    futureConfig.agents[name] = buildAgentDefinition(
      projectRoot,
      name,
      agent,
      before || {},
    );
    changes.push(buildChange('agents', name, before, futureConfig.agents[name]));
  }

  futureConfig.connectors = futureConfig.connectors || {};
  for (const connector of normalized.spec.connectors) {
    const name = connector.name;
    const before = futureConfig.connectors?.[name] || null;
    futureConfig.connectors[name] = buildConnectorDefinition(
      name,
      connector,
      before || {},
    );
    changes.push(buildChange('connectors', name, before, futureConfig.connectors[name]));
  }

  for (const channel of normalized.spec.channels) {
    const name = channel.name;
    const before = futureConfig.channels?.[name] || null;
    futureConfig.channels[name] = buildChannelDefinition(
      projectRoot,
      futureConfig,
      name,
      channel,
      before || {},
    );
    changes.push(buildChange('channels', name, before, futureConfig.channels[name]));
  }

  return { futureConfig, changes };
}

function buildChange(kind, name, before, after) {
  return {
    kind,
    name,
    action: before ? (stableEqual(before, after) ? 'noop' : 'update') : 'create',
    before,
    after,
  };
}

function resolveTopologyActor(config, actorName) {
  const name = String(actorName || '').trim();
  if (!name) {
    return { type: 'operator', name: null, agent: null };
  }
  return {
    type: 'agent',
    name,
    agent: getAgent(config, name),
  };
}

function enforceTopologyActorPolicy(projectRoot, { operation, actor, changes, blockers }) {
  if (actor.type !== 'agent') {
    return;
  }

  const policy = actor.agent.managementPolicy || {};
  if (operation === 'plan') {
    if (!policy.canPlan && !policy.canApply) {
      blockers.push(
        `Agent "${actor.name}" is not allowed to plan topology changes.`,
      );
    }
    return;
  }

  if (!policy.canApply) {
    blockers.push(
      `Agent "${actor.name}" is not allowed to apply topology changes.`,
    );
    return;
  }

  const changed = changes.filter((change) => change.action !== 'noop');
  const maxChanges = policy.maxChangesPerApply;
  if (!Number.isInteger(maxChanges) || maxChanges <= 0) {
    blockers.push(
      `Agent "${actor.name}" managementPolicy.maxChangesPerApply is required for apply.`,
    );
  } else if (changed.length > maxChanges) {
    blockers.push(
      `Agent "${actor.name}" requested ${changed.length} changes, above maxChangesPerApply=${maxChanges}.`,
    );
  }

  for (const change of changed) {
    enforceActionPolicy(policy, change, blockers, actor.name);
    enforceNamePolicy(policy, change, blockers, actor.name);
    enforcePlatformPolicy(policy, change, blockers, actor.name);
    enforceWorkspacePolicy(projectRoot, policy, change, blockers, actor.name);
  }
}

function enforceActionPolicy(policy, change, blockers, actorName) {
  const allowedActions = policy.allowedActions || [];
  const action = UPSERT_ACTION_BY_KIND[change.kind];
  if (!allowedActions.includes(action)) {
    blockers.push(`Agent "${actorName}" is not allowed to perform ${action}.`);
  }
}

function enforceNamePolicy(policy, change, blockers, actorName) {
  const prefixes = policy.allowedNamePrefixes || [];
  if (prefixes.length === 0) {
    return;
  }
  if (!prefixes.some((prefix) => change.name.startsWith(prefix))) {
    blockers.push(
      `Agent "${actorName}" cannot manage ${singularKind(change.kind)} "${change.name}" outside allowed name prefixes.`,
    );
  }
}

function enforcePlatformPolicy(policy, change, blockers, actorName) {
  const allowedPlatforms = policy.allowedPlatforms || [];
  if (allowedPlatforms.length === 0) {
    return;
  }
  const platform = change.after.platform || change.after.type;
  if (platform && !allowedPlatforms.includes(platform)) {
    blockers.push(
      `Agent "${actorName}" cannot manage ${singularKind(change.kind)} "${change.name}" on platform "${platform}".`,
    );
  }
}

function enforceWorkspacePolicy(projectRoot, policy, change, blockers, actorName) {
  if (change.kind !== 'channels') {
    return;
  }
  const allowedWorkspaces = policy.allowedWorkspaces || [];
  if (allowedWorkspaces.length === 0) {
    return;
  }
  const allowedPaths = allowedWorkspaces.map((entry) => resolveProjectPath(projectRoot, entry));
  const workspaceFields = [
    ['workspace', change.after.workspace],
    ['ownerWorkspace', change.after.ownerWorkspace],
    ['reviewerWorkspace', change.after.reviewerWorkspace],
    ['arbiterWorkspace', change.after.arbiterWorkspace],
  ].filter(([, value]) => value);

  for (const [fieldName, value] of workspaceFields) {
    const resolved = resolveProjectPath(projectRoot, value);
    if (!allowedPaths.some((allowed) => isPathInside(resolved, allowed))) {
      blockers.push(
        `Agent "${actorName}" cannot set channel "${change.name}" ${fieldName} outside allowed workspaces.`,
      );
    }
  }
}

function recordsToTopologyEntries(records) {
  return Object.entries(records || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => redactTopologyValue({ name, ...value }));
}

function changedFields(before, after) {
  if (!before || !after) {
    return [];
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((key) => !stableEqual(before[key], after[key]));
}

function withTopologyLock(projectRoot, callback) {
  const layout = getProjectLayout(projectRoot);
  const topologyRoot = path.join(layout.toolRoot, 'topology');
  ensureDir(topologyRoot);
  const lockPath = path.join(topologyRoot, 'apply.lock');
  let fd = null;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: timestamp() }));
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Another topology apply is already running (${lockPath}).`);
    }
    throw error;
  }

  try {
    return callback();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
    fs.rmSync(lockPath, { force: true });
  }
}

function writeTopologyAudit(projectRoot, plan) {
  const layout = getProjectLayout(projectRoot);
  const topologyRoot = path.join(layout.toolRoot, 'topology');
  ensureDir(topologyRoot);
  const auditPath = path.join(topologyRoot, 'audit.ndjson');
  const entry = {
    at: timestamp(),
    actor: plan.actor.type === 'agent' ? plan.actor.name : 'operator',
    changedCount: plan.changedCount,
    changes: plan.changes
      .filter((change) => change.action !== 'noop')
      .map((change) => ({
        action: change.action,
        kind: singularKind(change.kind),
        name: change.name,
      })),
  };
  fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`);
}

function singularKind(kind) {
  return kind.endsWith('s') ? kind.slice(0, -1) : kind;
}

function stableEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isPathInside(candidate, parent) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedParent = path.resolve(parent);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`)
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export const TOPOLOGY_ENTITY_KINDS = ENTITY_KINDS;
