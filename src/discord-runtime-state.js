import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getProjectLayout } from './store.js';
import { assert, readJson, timestamp, writeJson } from './utils.js';

export const DISCORD_ROLE_NAMES = ['owner', 'reviewer', 'arbiter'];

const DISCORD_STATUS_FILENAME = 'discord-status.json';
const DISCORD_AGENT_STATUSES_DIRNAME = 'discord-agent-statuses';
const DISCORD_COMMANDS_DIRNAME = 'discord-commands';
const DISCORD_AGENT_COMMANDS_DIRNAME = 'discord-agent-commands';
const DISCORD_HEARTBEAT_STALE_MS = 45_000;
const ROLE_TOKEN_ENV_KEYS = {
  owner: [
    'OWNER_BOT_TOKEN',
    'OWNER_DISCORD_BOT_TOKEN',
    'HKCLAW_LITE_OWNER_BOT_TOKEN',
  ],
  reviewer: [
    'REVIEWER_BOT_TOKEN',
    'REVIEWER_DISCORD_BOT_TOKEN',
    'HKCLAW_LITE_REVIEWER_BOT_TOKEN',
  ],
  arbiter: [
    'ARBITER_BOT_TOKEN',
    'ARBITER_DISCORD_BOT_TOKEN',
    'HKCLAW_LITE_ARBITER_BOT_TOKEN',
  ],
};

export function getDiscordStatusPath(projectRoot) {
  return path.join(getProjectLayout(projectRoot).toolRoot, DISCORD_STATUS_FILENAME);
}

export function getDiscordAgentStatusesPath(projectRoot) {
  return path.join(getProjectLayout(projectRoot).toolRoot, DISCORD_AGENT_STATUSES_DIRNAME);
}

export function getDiscordAgentStatusPath(projectRoot, agentName) {
  assert(agentName, 'Agent name is required.');
  return path.join(getDiscordAgentStatusesPath(projectRoot), `${agentName}.json`);
}

export function getDiscordCommandQueuePath(projectRoot, agentName = null) {
  if (agentName) {
    return path.join(
      getProjectLayout(projectRoot).toolRoot,
      DISCORD_AGENT_COMMANDS_DIRNAME,
      agentName,
    );
  }
  return path.join(getProjectLayout(projectRoot).toolRoot, DISCORD_COMMANDS_DIRNAME);
}

export function parseDotEnv(source) {
  const output = {};
  for (const rawLine of String(source || '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

export function readProjectEnvEntries(projectRoot, envFile = null) {
  const envFilePath = envFile
    ? path.resolve(projectRoot, envFile)
    : path.join(projectRoot, '.env');

  if (!fs.existsSync(envFilePath)) {
    return {
      envFilePath,
      entries: {},
    };
  }

  return {
    envFilePath,
    entries: parseDotEnv(fs.readFileSync(envFilePath, 'utf8')),
  };
}

export function loadProjectEnvFile(projectRoot, envFile = null, targetEnv = process.env) {
  const { envFilePath, entries } = readProjectEnvEntries(projectRoot, envFile);
  for (const [key, value] of Object.entries(entries)) {
    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
    }
  }
  return {
    envFilePath,
    entries,
  };
}

export function resolveDiscordRoleTokens(env, options = {}) {
  const output = Object.fromEntries(
    DISCORD_ROLE_NAMES.map((role) => {
      const resolved = resolveRoleToken(env, role);
      return [role, resolved.token];
    }),
  );

  assert(output.owner, 'OWNER_BOT_TOKEN is required.');
  if (options.requireReviewerAndArbiter) {
    assert(output.reviewer, 'REVIEWER_BOT_TOKEN is required for tribunal channels.');
    assert(output.arbiter, 'ARBITER_BOT_TOKEN is required for tribunal channels.');
  }

  return output;
}

export function resolveChannelRoleAgentNames(channel) {
  return {
    owner: channel?.agent || null,
    reviewer: channel?.reviewer || null,
    arbiter: channel?.arbiter || null,
  };
}

export function inspectDiscordAgentConfigs(config, channels, runtimeStatus = null) {
  const tribunalChannelCount = channels.filter(
    (channel) => channel?.mode === 'tribunal' || Boolean(channel?.reviewer && channel?.arbiter),
  ).length;
  const agents = config?.agents || {};
  const runtimeAgents = runtimeStatus?.agents || runtimeStatus?.bots || {};

  return {
    tribunalChannelCount,
    singleChannelCount: channels.length - tribunalChannelCount,
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, agent]) => {
        const runtimeAgent = runtimeAgents[name] || {};
        return [
          name,
          {
            configured: Boolean(agent?.discordToken || runtimeAgent.tokenConfigured),
            required: true,
            agent: agent?.agent || '',
            source: agent?.discordToken ? 'config' : runtimeAgent.tokenConfigured ? 'discord serve' : '없음',
            tokenConfigured: Boolean(agent?.discordToken || runtimeAgent.tokenConfigured),
            connected: Boolean(runtimeAgent.connected),
            tag: runtimeAgent.tag || '',
            userId: runtimeAgent.userId || '',
          },
        ];
      }),
    ),
  };
}

export function inspectDiscordRoleTokens(
  projectRoot,
  {
    envFile = null,
    baseEnv = process.env,
    requireReviewerAndArbiter = false,
    runtimeStatus = null,
  } = {},
) {
  const { envFilePath, entries } = readProjectEnvEntries(projectRoot, envFile);
  const mergedEnv = {
    ...entries,
    ...baseEnv,
  };

  return {
    envFilePath,
    roles: Object.fromEntries(
      DISCORD_ROLE_NAMES.map((role) => {
        const resolved = resolveRoleToken(mergedEnv, role);
        const runtimeRole = runtimeStatus?.roles?.[role] || {};
        const configured = Boolean(resolved.token || runtimeRole.tokenConfigured);
        return [
          role,
          {
            configured,
            required: role === 'owner' || requireReviewerAndArbiter,
            envKey: resolved.envKey || runtimeRole.envKey || null,
            source: resolveTokenSource({
              envKey: resolved.envKey,
              envEntries: entries,
              baseEnv,
              runtimeConfigured: runtimeRole.tokenConfigured,
            }),
            tag: runtimeRole.tag || '',
            userId: runtimeRole.userId || '',
            connected: Boolean(runtimeRole.connected),
          },
        ];
      }),
    ),
  };
}

export function readDiscordServiceStatus(projectRoot) {
  return readJson(getDiscordStatusPath(projectRoot), null);
}

export function writeDiscordServiceStatus(projectRoot, value) {
  writeJson(getDiscordStatusPath(projectRoot), value);
}

export function readDiscordAgentServiceStatus(projectRoot, agentName) {
  return readJson(getDiscordAgentStatusPath(projectRoot, agentName), null);
}

export function writeDiscordAgentServiceStatus(projectRoot, agentName, value) {
  writeJson(getDiscordAgentStatusPath(projectRoot, agentName), value);
}

export function listDiscordAgentServiceStatuses(projectRoot) {
  const statusesPath = getDiscordAgentStatusesPath(projectRoot);
  if (!fs.existsSync(statusesPath)) {
    return {};
  }

  return Object.fromEntries(
    fs
      .readdirSync(statusesPath)
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => {
        const agentName = fileName.slice(0, -'.json'.length);
        return [agentName, readJson(path.join(statusesPath, fileName), null)];
      })
      .filter(([, status]) => Boolean(status)),
  );
}

export function buildDiscordServiceSnapshot(
  projectRoot,
  rawStatus = undefined,
) {
  if (rawStatus !== undefined) {
    return buildSingleDiscordServiceSnapshot(rawStatus);
  }

  const agentStatuses = listDiscordAgentServiceStatuses(projectRoot);
  const agentNames = Object.keys(agentStatuses);
  if (agentNames.length > 0) {
    const agentServices = Object.fromEntries(
      agentNames.map((agentName) => [
        agentName,
        buildDiscordAgentServiceSnapshot(projectRoot, agentName, agentStatuses[agentName]),
      ]),
    );
    const runningAgentNames = agentNames.filter((agentName) => agentServices[agentName].running);
    const staleAgentNames = agentNames.filter((agentName) => agentServices[agentName].stale);
    const agents = Object.fromEntries(
      agentNames.map((agentName) => [
        agentName,
        buildServiceAgentSummary(agentStatuses[agentName]?.agents || agentStatuses[agentName]?.bots || {})[agentName] || {
          tokenConfigured: false,
          connected: false,
          tag: '',
          userId: '',
          agent: '',
        },
      ]),
    );
    const state =
      runningAgentNames.length > 0 ? 'running' : staleAgentNames.length > 0 ? 'stale' : 'stopped';

    return {
      state,
      label: buildAggregateDiscordServiceLabel({
        state,
        runningCount: runningAgentNames.length,
        totalCount: agentNames.length,
        staleCount: staleAgentNames.length,
      }),
      running: runningAgentNames.length > 0,
      stale: staleAgentNames.length > 0,
      desiredRunning: agentNames.some(
        (agentName) => Boolean(agentStatuses[agentName]?.desiredRunning ?? agentStatuses[agentName]?.running),
      ),
      pid: null,
      startedAt: null,
      stoppedAt: null,
      heartbeatAt: null,
      envFilePath: null,
      lastError: null,
      agents,
      agentServices,
      runningAgentCount: runningAgentNames.length,
      totalAgentCount: agentNames.length,
    };
  }

  rawStatus = readDiscordServiceStatus(projectRoot);
  return buildSingleDiscordServiceSnapshot(rawStatus);
}

export function buildDiscordAgentServiceSnapshot(
  projectRoot,
  agentName,
  rawStatus = readDiscordAgentServiceStatus(projectRoot, agentName),
) {
  return {
    agentName,
    ...buildSingleDiscordServiceSnapshot(rawStatus),
  };
}

function buildSingleDiscordServiceSnapshot(rawStatus) {
  const emptyAgents = {};
  if (!rawStatus) {
    return {
      state: 'stopped',
      label: '중지',
      running: false,
      starting: false,
      stale: false,
      desiredRunning: false,
      pid: null,
      pidAlive: false,
      heartbeatFresh: false,
      startedAt: null,
      stoppedAt: null,
      heartbeatAt: null,
      envFilePath: null,
      lastError: null,
      agents: emptyAgents,
    };
  }

  const pidAlive =
    Number.isInteger(rawStatus.pid) && rawStatus.pid > 0 ? isPidAlive(rawStatus.pid) : false;
  const heartbeatFresh = isHeartbeatFresh(rawStatus.heartbeatAt);

  let state = 'stopped';
  if (rawStatus.running && pidAlive && heartbeatFresh) {
    state = 'running';
  } else if (
    Boolean(rawStatus.desiredRunning ?? rawStatus.running) &&
    pidAlive &&
    heartbeatFresh &&
    !rawStatus.lastError
  ) {
    state = 'starting';
  } else if (rawStatus.running) {
    state = 'stale';
  }

  return {
    state,
    label: localizeDiscordServiceState(state),
    running: state === 'running',
    starting: state === 'starting',
    stale: state === 'stale',
    desiredRunning: Boolean(rawStatus.desiredRunning ?? rawStatus.running),
    pid: rawStatus.pid || null,
    pidAlive,
    heartbeatFresh,
    startedAt: rawStatus.startedAt || null,
    stoppedAt: rawStatus.stoppedAt || null,
    heartbeatAt: rawStatus.heartbeatAt || null,
    envFilePath: rawStatus.envFilePath || null,
    lastError: rawStatus.lastError || null,
    agents: buildServiceAgentSummary(rawStatus.agents || rawStatus.bots),
  };
}

export function createDiscordServiceStatus(projectRoot, options = {}) {
  return {
    version: 1,
    projectRoot,
    agentName: options.agentName || null,
    pid: process.pid,
    running: Boolean(options.running),
    desiredRunning: Boolean(
      options.desiredRunning === undefined ? options.running : options.desiredRunning,
    ),
    startedAt: options.startedAt || timestamp(),
    stoppedAt: options.stoppedAt || null,
    heartbeatAt: options.heartbeatAt || timestamp(),
    envFilePath: options.envFilePath || null,
    lastError: options.lastError || null,
    agents: buildServiceAgentSummary(options.agents || options.bots),
  };
}

export function enqueueDiscordServiceCommand(projectRoot, input = {}) {
  const action = String(input?.action || '').trim();
  assert(action, 'Discord service command action is required.');
  const agentName =
    input?.agentName || input?.botName ? String(input.agentName || input.botName).trim() : null;
  assert(agentName, 'Discord service command agentName is required.');

  const command = {
    version: 1,
    id: randomUUID(),
    action,
    agentName,
    requestedAt: timestamp(),
  };
  const filePath = path.join(
    getDiscordCommandQueuePath(projectRoot, agentName),
    `${Date.now()}-${command.id}.json`,
  );
  writeJson(filePath, command);
  return command;
}

export function listDiscordServiceCommands(projectRoot, { agentName = null } = {}) {
  const queuePath = getDiscordCommandQueuePath(projectRoot, agentName);
  if (!fs.existsSync(queuePath)) {
    return [];
  }

  return fs
    .readdirSync(queuePath)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => {
      const filePath = path.join(queuePath, fileName);
      return {
        ...readJson(filePath, {}),
        fileName,
        filePath,
      };
    });
}

export function deleteDiscordServiceCommand(commandOrPath) {
  const filePath =
    typeof commandOrPath === 'string' ? commandOrPath : commandOrPath?.filePath || null;
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }
  fs.rmSync(filePath, { force: true });
  return true;
}

export function deleteDiscordAgentServiceArtifacts(projectRoot, agentName) {
  assert(agentName, 'Agent name is required.');

  const statusPath = getDiscordAgentStatusPath(projectRoot, agentName);
  const commandQueuePath = getDiscordCommandQueuePath(projectRoot, agentName);

  fs.rmSync(statusPath, { force: true });
  fs.rmSync(commandQueuePath, { recursive: true, force: true });
}

function resolveRoleToken(env, role) {
  const envKey = ROLE_TOKEN_ENV_KEYS[role].find((key) => String(env[key] || '').trim());
  return {
    envKey: envKey || null,
    token: envKey ? String(env[envKey]).trim() : '',
  };
}

function resolveTokenSource({ envKey, envEntries, baseEnv, runtimeConfigured }) {
  if (envKey) {
    if (baseEnv[envKey] !== undefined) {
      return '환경 변수';
    }
    if (envEntries[envKey] !== undefined) {
      return '.env';
    }
  }
  if (runtimeConfigured) {
    return 'discord serve';
  }
  return '없음';
}

function buildServiceAgentSummary(input = {}) {
  return Object.fromEntries(
    Object.entries(input || {}).map(([name, source]) => [
      name,
      {
        tokenConfigured: Boolean(source?.tokenConfigured),
        connected: Boolean(source?.connected),
        tag: source?.tag || '',
        userId: source?.userId || '',
        agent: source?.agent || '',
      },
    ]),
  );
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isHeartbeatFresh(heartbeatAt) {
  if (!heartbeatAt) {
    return false;
  }
  const parsed = Date.parse(heartbeatAt);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return Date.now() - parsed <= DISCORD_HEARTBEAT_STALE_MS;
}

function localizeDiscordServiceState(state) {
  if (state === 'running') {
    return '가동 중';
  }
  if (state === 'starting') {
    return '시작 중';
  }
  if (state === 'stale') {
    return '끊김';
  }
  return '중지';
}

function buildAggregateDiscordServiceLabel({ state, runningCount, totalCount, staleCount }) {
  if (state === 'running') {
    return `가동 중 ${runningCount}/${totalCount}`;
  }
  if (state === 'starting') {
    return totalCount > 0 ? `시작 중 ${runningCount}/${totalCount}` : '시작 중';
  }
  if (state === 'stale') {
    return staleCount > 0 ? `끊김 ${staleCount}/${totalCount}` : '끊김';
  }
  return totalCount > 0 ? `중지 0/${totalCount}` : '중지';
}
