import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHANNEL_MODE_CHOICES,
  CONFIG_FILENAME,
  CURRENT_CONFIG_VERSION,
  DASHBOARD_ALL_AGENTS,
  DEFAULT_DASHBOARD_REFRESH_MS,
  DEFAULT_CHANNEL_WORKSPACE,
  SUPPORTED_AGENTS,
  TOOL_DIRNAME,
} from './constants.js';
import { resolveAgentEffortChoices } from './model-catalog.js';
import {
  assert,
  ensureDir,
  isPlainObject,
  parseCommaSeparatedList,
  parseInteger,
  parseOptionalInteger,
  readJson,
  writeJson,
} from './utils.js';

export function getProjectLayout(projectRoot) {
  const toolRoot = path.join(projectRoot, TOOL_DIRNAME);
  return {
    projectRoot,
    toolRoot,
    configPath: path.join(toolRoot, CONFIG_FILENAME),
    watchersRoot: path.join(toolRoot, 'watchers'),
  };
}

export function findProjectRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    const configPath = getProjectLayout(current).configPath;
    if (fs.existsSync(configPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveProjectRoot(startDir, explicitRoot) {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  const discovered = findProjectRoot(startDir);
  assert(
    discovered,
    'No hkclaw-lite project found. Run "hkclaw-lite init" first or pass --root.',
  );
  return discovered;
}

export function initProject(projectRoot, { force = false } = {}) {
  const layout = getProjectLayout(projectRoot);
  if (fs.existsSync(layout.configPath) && !force) {
    throw new Error(
      `Project is already initialized at ${layout.configPath}. Use --force to overwrite.`,
    );
  }
  ensureDir(layout.toolRoot);
  ensureDir(layout.watchersRoot);
  writeJson(layout.configPath, createDefaultConfig());
  return layout;
}

export function createDefaultConfig() {
  return {
    version: CURRENT_CONFIG_VERSION,
    defaults: {
      dashboardRefreshMs: DEFAULT_DASHBOARD_REFRESH_MS,
    },
    sharedEnv: {},
    agents: {},
    channels: {},
    dashboards: {},
  };
}

export function loadConfig(projectRoot) {
  const layout = getProjectLayout(projectRoot);
  const rawConfig = readJson(layout.configPath);
  const config = normalizeConfig(rawConfig);

  assert(
    isPlainObject(config),
    `Invalid config file at ${layout.configPath}. Expected a JSON object.`,
  );
  assert(
    config.version === CURRENT_CONFIG_VERSION,
    `Unsupported config version "${config.version}".`,
  );
  assert(isPlainObject(config.defaults), 'Config defaults must be an object.');
  assert(isPlainObject(config.sharedEnv), 'Config sharedEnv must be an object.');
  assert(isPlainObject(config.agents), 'Config agents must be an object.');
  assert(isPlainObject(config.channels), 'Config channels must be an object.');
  assert(isPlainObject(config.dashboards), 'Config dashboards must be an object.');
  validateConfigReferences(projectRoot, config);

  return config;
}

function normalizeConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    return rawConfig;
  }

  if (rawConfig.version === CURRENT_CONFIG_VERSION) {
    const rawAgents = rawConfig.agents ?? {};
    return {
      ...rawConfig,
      defaults: {
        dashboardRefreshMs:
          rawConfig.defaults?.dashboardRefreshMs ?? DEFAULT_DASHBOARD_REFRESH_MS,
      },
      sharedEnv: rawConfig.sharedEnv ?? {},
      agents: normalizeLegacyAgentRecords(rawAgents),
      channels: normalizeLegacyChannelRecords(rawConfig.channels ?? {}, rawAgents),
      dashboards: normalizeLegacyDashboardRecords(rawConfig.dashboards ?? {}),
    };
  }

  if (rawConfig.version === 2 && isPlainObject(rawConfig.agents)) {
    const rawAgents = rawConfig.agents ?? {};
    return {
      version: CURRENT_CONFIG_VERSION,
      defaults: {
        dashboardRefreshMs:
          rawConfig.defaults?.dashboardRefreshMs ?? DEFAULT_DASHBOARD_REFRESH_MS,
      },
      sharedEnv: rawConfig.sharedEnv ?? {},
      agents: normalizeLegacyAgentRecords(rawAgents),
      channels: normalizeLegacyChannelRecords(rawConfig.channels ?? {}, rawAgents),
      dashboards: normalizeLegacyDashboardRecords(rawConfig.dashboards ?? {}),
    };
  }

  if (rawConfig.version === 1 && isPlainObject(rawConfig.services)) {
    const rawAgents = rawConfig.services;
    return {
      version: CURRENT_CONFIG_VERSION,
      defaults: {
        dashboardRefreshMs: DEFAULT_DASHBOARD_REFRESH_MS,
      },
      sharedEnv: rawConfig.sharedEnv ?? {},
      agents: normalizeLegacyAgentRecords(rawAgents),
      channels: {},
      dashboards: {},
    };
  }

  return rawConfig;
}

function validateConfigReferences(projectRoot, config) {
  validateEnvObject(config.sharedEnv, 'sharedEnv');

  for (const [name, agent] of Object.entries(config.agents)) {
    validateAgentDefinition(projectRoot, { name, ...agent });
    if (agent.fallbackAgent) {
      assert(
        config.agents[agent.fallbackAgent],
        `Agent "${name}" references unknown fallback agent "${agent.fallbackAgent}".`,
      );
    }
  }

  for (const channel of Object.values(config.channels)) {
    validateChannelDefinition(projectRoot, config, channel);
  }

  for (const dashboard of Object.values(config.dashboards)) {
    validateDashboardDefinition(config, dashboard);
  }
}

export function saveConfig(projectRoot, config) {
  const layout = getProjectLayout(projectRoot);
  writeJson(layout.configPath, config);
}

export function listAgents(config) {
  return Object.entries(config.agents)
    .map(([name, agent]) => ({ name, ...agent }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getAgent(config, name) {
  const agent = config.agents[name];
  assert(agent, `Unknown agent "${name}".`);
  return { name, ...agent };
}

export function removeAgent(config, name) {
  assert(config.agents[name], `Unknown agent "${name}".`);
  delete config.agents[name];
}

export function listDashboards(config) {
  return Object.entries(config.dashboards)
    .map(([name, dashboard]) => ({ name, ...dashboard }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getDashboard(config, name) {
  const dashboard = config.dashboards[name];
  assert(dashboard, `Unknown dashboard "${name}".`);
  return { name, ...dashboard };
}

export function removeDashboard(config, name) {
  assert(config.dashboards[name], `Unknown dashboard "${name}".`);
  delete config.dashboards[name];
}

export function listChannels(config) {
  return Object.entries(config.channels)
    .map(([name, channel]) => ({ name, ...channel }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getChannel(config, name) {
  const channel = config.channels[name];
  assert(channel, `Unknown channel "${name}".`);
  return { name, ...channel };
}

export function removeChannel(config, name) {
  assert(config.channels[name], `Unknown channel "${name}".`);
  delete config.channels[name];
}

export function buildAgentDefinition(projectRoot, name, input, existing = {}) {
  assert(name, 'Agent name is required.');
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Agent name may only contain letters, numbers, dot, underscore, and dash.',
  );

  const merged = {
    ...stripManagedFields(existing),
    agent: getRequiredString(input.agent ?? existing.agent, 'agent'),
    fallbackAgent: normalizeOptionalString(
      input.fallbackAgent ?? input['fallback-agent'] ?? existing.fallbackAgent,
    ),
    model: normalizeOptionalString(input.model ?? existing.model),
    effort: normalizeOptionalString(input.effort ?? existing.effort),
    systemPrompt: normalizeOptionalString(
      input.systemPrompt ?? input.system ?? existing.systemPrompt,
    ),
    systemPromptFile: normalizeOptionalString(
      input.systemPromptFile ?? input['system-file'] ?? existing.systemPromptFile,
    ),
    timeoutMs: input.timeoutMs ?? input['timeout-ms'] ?? existing.timeoutMs,
    sandbox: normalizeOptionalString(input.sandbox ?? existing.sandbox),
    permissionMode: normalizeOptionalString(
      input.permissionMode ?? input['permission-mode'] ?? existing.permissionMode,
    ),
    dangerous: resolveBooleanValue(input.dangerous, existing.dangerous ?? false),
    baseUrl: normalizeOptionalString(input.baseUrl ?? input['base-url'] ?? existing.baseUrl),
    command: normalizeOptionalString(input.command ?? existing.command),
    skills: normalizePathEntries(
      input.skills ?? input['skill-file'] ?? existing.skills,
    ),
    contextFiles: normalizePathEntries(
      input.contextFiles ?? input['context-file'] ?? existing.contextFiles,
    ),
    env: input.env ?? existing.env ?? {},
  };

  if (merged.timeoutMs !== undefined) {
    merged.timeoutMs = parseOptionalInteger(merged.timeoutMs, 'timeoutMs');
  }
  if (merged.agent !== 'codex') {
    merged.sandbox = undefined;
  }
  if (merged.agent === 'codex' && merged.sandbox !== 'danger-full-access') {
    merged.dangerous = undefined;
  }
  if (merged.agent !== 'claude-code') {
    merged.permissionMode = undefined;
  }
  if (!['codex', 'claude-code'].includes(merged.agent)) {
    merged.dangerous = undefined;
  }
  if (merged.agent !== 'local-llm') {
    merged.baseUrl = undefined;
  }
  if (merged.agent !== 'command') {
    merged.command = undefined;
  }

  validateAgentDefinition(projectRoot, merged);
  return sortObjectKeys(merged);
}

export function buildChannelDefinition(projectRoot, config, name, input, existing = {}) {
  assert(name, 'Channel name is required.');
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Channel name may only contain letters, numbers, dot, underscore, and dash.',
  );

  const merged = {
    ...stripManagedFields(existing),
    mode: normalizeOptionalString(
      input.mode ??
        input['mode'] ??
        input.channelMode ??
        input['channel-mode'] ??
        existing.mode ??
        (input.reviewer || input.arbiter || existing.reviewer || existing.arbiter
          ? 'tribunal'
          : 'single'),
    ),
    discordChannelId: getRequiredString(
      input.discordChannelId ?? input['discord-channel-id'] ?? existing.discordChannelId,
      'discordChannelId',
    ),
    guildId: normalizeOptionalString(input.guildId ?? input['guild-id'] ?? existing.guildId),
    workspace: normalizeOptionalString(
      input.workspace ??
        input['workspace'] ??
        input.workdir ??
        input['workdir'] ??
        existing.workspace ??
        existing.workdir ??
        DEFAULT_CHANNEL_WORKSPACE,
    ),
    agent: getRequiredString(input.agent ?? existing.agent, 'agent'),
    reviewer: normalizeOptionalString(input.reviewer ?? existing.reviewer),
    arbiter: normalizeOptionalString(input.arbiter ?? existing.arbiter),
    reviewRounds:
      input.reviewRounds ?? input['review-rounds'] ?? existing.reviewRounds,
    description: normalizeOptionalString(input.description ?? existing.description),
  };

  if (merged.mode !== 'tribunal') {
    merged.reviewer = undefined;
    merged.arbiter = undefined;
    merged.reviewRounds = undefined;
  }
  if (merged.reviewRounds !== undefined) {
    merged.reviewRounds = parseOptionalInteger(merged.reviewRounds, 'reviewRounds');
  }
  validateChannelDefinition(projectRoot, config, merged);
  return sortObjectKeys(merged);
}

export function buildDashboardDefinition(
  projectRoot,
  name,
  input,
  config,
  existing = {},
) {
  assert(name, 'Dashboard name is required.');
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Dashboard name may only contain letters, numbers, dot, underscore, and dash.',
  );

  const merged = {
    ...stripManagedFields(existing),
    monitors: normalizeDashboardMonitors(input.monitors ?? existing.monitors ?? [DASHBOARD_ALL_AGENTS]),
    refreshMs:
      input.refreshMs ??
      input['refresh-ms'] ??
      existing.refreshMs ??
      config.defaults.dashboardRefreshMs ??
      DEFAULT_DASHBOARD_REFRESH_MS,
    showDetails: resolveBooleanValue(
      input.showDetails ?? input['show-details'],
      existing.showDetails ?? true,
    ),
  };

  merged.refreshMs = parseInteger(merged.refreshMs, 'refreshMs');
  validateDashboardDefinition(config, merged);
  return sortObjectKeys(merged);
}

function validateAgentDefinition(projectRoot, agent) {
  assert(
    SUPPORTED_AGENTS.includes(agent.agent),
    `Unsupported agent "${agent.agent}". Supported: ${SUPPORTED_AGENTS.join(', ')}.`,
  );

  if (agent.fallbackAgent) {
    assert(agent.fallbackAgent !== agent.name, 'fallbackAgent must be different from the agent.');
  }

  if (agent.systemPromptFile) {
    const resolvedPromptFile = resolveProjectPath(projectRoot, agent.systemPromptFile);
    assert(
      fs.existsSync(resolvedPromptFile),
      `System prompt file does not exist: ${resolvedPromptFile}`,
    );
  }

  for (const skillPath of agent.skills ?? []) {
    const resolvedSkillPath = resolveProjectPath(projectRoot, skillPath);
    assert(fs.existsSync(resolvedSkillPath), `Skill path does not exist: ${resolvedSkillPath}`);
    if (fs.statSync(resolvedSkillPath).isDirectory()) {
      const skillFilePath = path.join(resolvedSkillPath, 'SKILL.md');
      assert(
        fs.existsSync(skillFilePath),
        `Skill directory does not contain SKILL.md: ${skillFilePath}`,
      );
    }
  }

  for (const contextFile of agent.contextFiles ?? []) {
    const resolvedContextFile = resolveProjectPath(projectRoot, contextFile);
    assert(
      fs.existsSync(resolvedContextFile),
      `Context file does not exist: ${resolvedContextFile}`,
    );
    assert(
      !fs.statSync(resolvedContextFile).isDirectory(),
      `Context file must be a file: ${resolvedContextFile}`,
    );
  }

  if (agent.timeoutMs !== undefined) {
    assert(
      Number.isInteger(agent.timeoutMs) && agent.timeoutMs > 0,
      'timeoutMs must be a positive integer.',
    );
  }

  if (agent.effort) {
    const supportedEfforts = resolveAgentEffortChoices(agent.agent, agent.model);
    assert(
      supportedEfforts.length === 0 || supportedEfforts.includes(agent.effort),
      `Unsupported effort "${agent.effort}" for agent "${agent.agent}" model "${agent.model || '(default)'}".`,
    );
  }

  if (agent.agent === 'local-llm') {
    assert(
      typeof agent.model === 'string' && agent.model.trim().length > 0,
      'local-llm agents require a model.',
    );
  }

  if (agent.agent === 'command') {
    assert(
      typeof agent.command === 'string' && agent.command.trim().length > 0,
      'command agents require a command.',
    );
  }

  validateEnvObject(agent.env ?? {}, `Agent "${agent.name}" env`);
}

function validateChannelDefinition(projectRoot, config, channel) {
  assert(
    CHANNEL_MODE_CHOICES.some((entry) => entry.value === channel.mode),
    `Unsupported channel mode "${channel.mode}".`,
  );
  assert(
    typeof channel.discordChannelId === 'string' &&
      channel.discordChannelId.trim().length > 0,
    'discordChannelId is required.',
  );
  assert(
    typeof channel.workspace === 'string' && channel.workspace.trim().length > 0,
    'workspace is required.',
  );
  const resolvedWorkspace = resolveProjectPath(projectRoot, channel.workspace);
  assert(fs.existsSync(resolvedWorkspace), `Workspace does not exist: ${resolvedWorkspace}`);
  assert(
    fs.statSync(resolvedWorkspace).isDirectory(),
    `Workspace must be a directory: ${resolvedWorkspace}`,
  );
  assert(config.agents[channel.agent], `Channel references unknown agent "${channel.agent}".`);
  const hasTribunal = channel.mode === 'tribunal';
  if (hasTribunal) {
    assert(channel.reviewer, 'Tribunal channel requires a reviewer.');
    assert(channel.arbiter, 'Tribunal channel requires an arbiter.');
  } else {
    assert(!channel.reviewer, 'Single channel cannot define a reviewer.');
    assert(!channel.arbiter, 'Single channel cannot define an arbiter.');
  }
  if (channel.reviewer) {
    assert(config.agents[channel.reviewer], `Channel references unknown reviewer "${channel.reviewer}".`);
    assert(channel.reviewer !== channel.agent, 'Reviewer must be different from the owner agent.');
  }
  if (channel.arbiter) {
    assert(config.agents[channel.arbiter], `Channel references unknown arbiter "${channel.arbiter}".`);
    assert(channel.arbiter !== channel.agent, 'Arbiter must be different from the owner agent.');
    assert(
      channel.arbiter !== channel.reviewer,
      'Arbiter must be different from the reviewer agent.',
    );
  }
  if (channel.reviewRounds !== undefined) {
    assert(
      Number.isInteger(channel.reviewRounds) && channel.reviewRounds > 0,
      'reviewRounds must be a positive integer.',
    );
    assert(hasTribunal, 'reviewRounds requires a tribunal channel.');
  }
}

function validateDashboardDefinition(config, dashboard) {
  assert(
    Number.isInteger(dashboard.refreshMs) && dashboard.refreshMs > 0,
    'Dashboard refreshMs must be a positive integer.',
  );
  assert(
    Array.isArray(dashboard.monitors) && dashboard.monitors.length > 0,
    'Dashboard must monitor at least one agent or "*".',
  );

  if (dashboard.monitors.includes(DASHBOARD_ALL_AGENTS)) {
    assert(
      dashboard.monitors.length === 1,
      'Dashboard monitors cannot mix "*" with explicit agent names.',
    );
    return;
  }

  for (const agentName of dashboard.monitors) {
    assert(config.agents[agentName], `Dashboard references unknown agent "${agentName}".`);
  }
}

function getRequiredString(value, fieldName) {
  assert(
    typeof value === 'string' && value.trim().length > 0,
    `${fieldName} is required.`,
  );
  return value.trim();
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveBooleanValue(value, fallbackValue) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'y', 'yes'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'n', 'no'].includes(normalized)) {
    return false;
  }
  return fallbackValue;
}

function normalizeDashboardMonitors(value) {
  const monitors = Array.isArray(value)
    ? value.flatMap((entry) => normalizeDashboardMonitors(entry))
    : parseCommaSeparatedList(value);

  if (monitors.length === 0) {
    return [DASHBOARD_ALL_AGENTS];
  }

  const unique = [...new Set(monitors)];
  if (unique.includes('all')) {
    return [DASHBOARD_ALL_AGENTS];
  }
  if (unique.includes(DASHBOARD_ALL_AGENTS)) {
    return [DASHBOARD_ALL_AGENTS];
  }
  return unique;
}

function normalizeLegacyAgentRecords(agents) {
  if (!isPlainObject(agents)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => {
      if (!isPlainObject(agent)) {
        return [name, agent];
      }
      const next = { ...agent };
      delete next.historyWindow;
      delete next.workdir;
      return [name, next];
    }),
  );
}

function normalizeLegacyChannelRecords(channels, rawAgents) {
  if (!isPlainObject(channels)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(channels).map(([name, channel]) => {
      if (!isPlainObject(channel)) {
        return [name, channel];
      }
      const next = { ...channel };
      if (!next.workspace) {
        const ownerAgent =
          isPlainObject(rawAgents) && isPlainObject(rawAgents[next.agent])
            ? rawAgents[next.agent]
            : null;
        next.workspace =
          next.workdir || ownerAgent?.workdir || DEFAULT_CHANNEL_WORKSPACE;
      }
      if (!next.mode) {
        next.mode = next.reviewer || next.arbiter ? 'tribunal' : 'single';
      }
      delete next.workdir;
      return [name, next];
    }),
  );
}

function normalizeLegacyDashboardRecords(dashboards) {
  if (!isPlainObject(dashboards)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(dashboards).map(([name, dashboard]) => {
      if (!isPlainObject(dashboard)) {
        return [name, dashboard];
      }
      const next = { ...dashboard };
      delete next.showSessions;
      return [name, next];
    }),
  );
}

function normalizePathEntries(value) {
  const entries = Array.isArray(value)
    ? value.flatMap((entry) => normalizePathEntries(entry) ?? [])
    : parseCommaSeparatedList(value);
  const unique = [...new Set(entries)];
  return unique.length > 0 ? unique : undefined;
}

function validateEnvObject(value, fieldName) {
  assert(isPlainObject(value), `${fieldName} must be an object.`);
  for (const [key, entryValue] of Object.entries(value)) {
    assert(key.trim().length > 0, `${fieldName} keys cannot be empty.`);
    assert(
      typeof entryValue === 'string',
      `${fieldName} values must be strings.`,
    );
  }
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortObjectKeys(entryValue)]),
  );
}

function stripManagedFields(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const next = { ...value };
  delete next.name;
  return next;
}

export function resolveProjectPath(projectRoot, maybeRelativePath) {
  const rawPath = String(maybeRelativePath || '').trim();
  if (!rawPath || rawPath === '~') {
    return os.homedir();
  }
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return path.resolve(projectRoot, rawPath);
}
