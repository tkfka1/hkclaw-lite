import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getProjectLayout } from './store.js';
import { assert, readJson, timestamp, writeJson } from './utils.js';

const TELEGRAM_STATUS_FILENAME = 'telegram-status.json';
const TELEGRAM_AGENT_STATUSES_DIRNAME = 'telegram-agent-statuses';
const TELEGRAM_COMMANDS_DIRNAME = 'telegram-commands';
const TELEGRAM_AGENT_COMMANDS_DIRNAME = 'telegram-agent-commands';
const TELEGRAM_HEARTBEAT_STALE_MS = 45_000;

export function getTelegramStatusPath(projectRoot) {
  return path.join(getProjectLayout(projectRoot).toolRoot, TELEGRAM_STATUS_FILENAME);
}

export function getTelegramAgentStatusesPath(projectRoot) {
  return path.join(getProjectLayout(projectRoot).toolRoot, TELEGRAM_AGENT_STATUSES_DIRNAME);
}

export function getTelegramAgentStatusPath(projectRoot, agentName) {
  assert(agentName, 'Agent name is required.');
  return path.join(getTelegramAgentStatusesPath(projectRoot), `${agentName}.json`);
}

export function getTelegramCommandQueuePath(projectRoot, agentName = null) {
  if (agentName) {
    return path.join(
      getProjectLayout(projectRoot).toolRoot,
      TELEGRAM_AGENT_COMMANDS_DIRNAME,
      agentName,
    );
  }
  return path.join(getProjectLayout(projectRoot).toolRoot, TELEGRAM_COMMANDS_DIRNAME);
}

export function inspectTelegramAgentConfigs(config, channels, runtimeStatus = null) {
  const telegramChannels = channels.filter((channel) => (channel?.platform || 'discord') === 'telegram');
  const agents = config?.agents || {};
  const runtimeAgents = runtimeStatus?.agents || runtimeStatus?.bots || {};

  return {
    telegramChannelCount: telegramChannels.length,
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, agent]) => {
        const runtimeAgent = runtimeAgents[name] || {};
        return [
          name,
          {
            configured: Boolean(agent?.telegramBotToken || runtimeAgent.tokenConfigured),
            required: telegramChannels.some(
              (channel) =>
                channel.agent === name ||
                channel.reviewer === name ||
                channel.arbiter === name,
            ),
            agent: agent?.agent || '',
            source: agent?.telegramBotToken ? 'config' : runtimeAgent.tokenConfigured ? 'telegram serve' : '없음',
            tokenConfigured: Boolean(agent?.telegramBotToken || runtimeAgent.tokenConfigured),
            connected: Boolean(runtimeAgent.connected),
            username: runtimeAgent.username || '',
            userId: runtimeAgent.userId || '',
          },
        ];
      }),
    ),
  };
}

export function readTelegramServiceStatus(projectRoot) {
  return readJson(getTelegramStatusPath(projectRoot), null);
}

export function writeTelegramServiceStatus(projectRoot, value) {
  writeJson(getTelegramStatusPath(projectRoot), value);
}

export function readTelegramAgentServiceStatus(projectRoot, agentName) {
  return readJson(getTelegramAgentStatusPath(projectRoot, agentName), null);
}

export function writeTelegramAgentServiceStatus(projectRoot, agentName, value) {
  writeJson(getTelegramAgentStatusPath(projectRoot, agentName), value);
}

export function listTelegramAgentServiceStatuses(projectRoot) {
  const statusesPath = getTelegramAgentStatusesPath(projectRoot);
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

export function buildTelegramServiceSnapshot(projectRoot, rawStatus = undefined) {
  if (rawStatus !== undefined) {
    return buildSingleTelegramServiceSnapshot(rawStatus);
  }

  const agentStatuses = listTelegramAgentServiceStatuses(projectRoot);
  const agentNames = Object.keys(agentStatuses);
  if (agentNames.length > 0) {
    const agentServices = Object.fromEntries(
      agentNames.map((agentName) => [
        agentName,
        buildTelegramAgentServiceSnapshot(projectRoot, agentName, agentStatuses[agentName]),
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
          username: '',
          userId: '',
          agent: '',
        },
      ]),
    );
    const state =
      runningAgentNames.length > 0 ? 'running' : staleAgentNames.length > 0 ? 'stale' : 'stopped';

    return {
      state,
      label: buildAggregateTelegramServiceLabel({
        state,
        runningCount: runningAgentNames.length,
        totalCount: agentNames.length,
        staleCount: staleAgentNames.length,
      }),
      running: runningAgentNames.length > 0,
      stale: staleAgentNames.length > 0,
      pid: null,
      startedAt: null,
      stoppedAt: null,
      heartbeatAt: null,
      lastError: null,
      agents,
      agentServices,
      runningAgentCount: runningAgentNames.length,
      totalAgentCount: agentNames.length,
    };
  }

  rawStatus = readTelegramServiceStatus(projectRoot);
  return buildSingleTelegramServiceSnapshot(rawStatus);
}

export function buildTelegramAgentServiceSnapshot(
  projectRoot,
  agentName,
  rawStatus = readTelegramAgentServiceStatus(projectRoot, agentName),
) {
  return {
    agentName,
    ...buildSingleTelegramServiceSnapshot(rawStatus),
  };
}

function buildSingleTelegramServiceSnapshot(rawStatus) {
  const emptyAgents = {};
  if (!rawStatus) {
    return {
      state: 'stopped',
      label: '중지',
      running: false,
      stale: false,
      pid: null,
      pidAlive: false,
      heartbeatFresh: false,
      startedAt: null,
      stoppedAt: null,
      heartbeatAt: null,
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
  } else if (rawStatus.running) {
    state = 'stale';
  }

  return {
    state,
    label: localizeTelegramServiceState(state),
    running: state === 'running',
    stale: state === 'stale',
    pid: rawStatus.pid || null,
    pidAlive,
    heartbeatFresh,
    startedAt: rawStatus.startedAt || null,
    stoppedAt: rawStatus.stoppedAt || null,
    heartbeatAt: rawStatus.heartbeatAt || null,
    lastError: rawStatus.lastError || null,
    agents: buildServiceAgentSummary(rawStatus.agents || rawStatus.bots),
  };
}

export function createTelegramServiceStatus(projectRoot, options = {}) {
  return {
    version: 1,
    projectRoot,
    agentName: options.agentName || null,
    pid: process.pid,
    running: Boolean(options.running),
    startedAt: options.startedAt || timestamp(),
    stoppedAt: options.stoppedAt || null,
    heartbeatAt: options.heartbeatAt || timestamp(),
    lastError: options.lastError || null,
    agents: buildServiceAgentSummary(options.agents || options.bots),
  };
}

export function enqueueTelegramServiceCommand(projectRoot, input = {}) {
  const action = String(input?.action || '').trim();
  assert(action, 'Telegram service command action is required.');
  const agentName =
    input?.agentName || input?.botName ? String(input.agentName || input.botName).trim() : null;
  assert(agentName, 'Telegram service command agentName is required.');

  const command = {
    version: 1,
    id: randomUUID(),
    action,
    agentName,
    requestedAt: timestamp(),
  };
  const filePath = path.join(
    getTelegramCommandQueuePath(projectRoot, agentName),
    `${Date.now()}-${command.id}.json`,
  );
  writeJson(filePath, command);
  return command;
}

export function listTelegramServiceCommands(projectRoot, { agentName = null } = {}) {
  const queuePath = getTelegramCommandQueuePath(projectRoot, agentName);
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

export function deleteTelegramServiceCommand(commandOrPath) {
  const filePath =
    typeof commandOrPath === 'string' ? commandOrPath : commandOrPath?.filePath || null;
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }
  fs.rmSync(filePath, { force: true });
  return true;
}

function buildServiceAgentSummary(input = {}) {
  return Object.fromEntries(
    Object.entries(input || {}).map(([name, source]) => [
      name,
      {
        tokenConfigured: Boolean(source?.tokenConfigured),
        connected: Boolean(source?.connected),
        username: source?.username || '',
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
  return Date.now() - parsed <= TELEGRAM_HEARTBEAT_STALE_MS;
}

function localizeTelegramServiceState(state) {
  if (state === 'running') {
    return '가동 중';
  }
  if (state === 'stale') {
    return '끊김';
  }
  return '중지';
}

function buildAggregateTelegramServiceLabel({ state, runningCount, totalCount, staleCount }) {
  if (state === 'running') {
    return `가동 중 ${runningCount}/${totalCount}`;
  }
  if (state === 'stale') {
    return staleCount > 0 ? `끊김 ${staleCount}/${totalCount}` : '끊김';
  }
  return totalCount > 0 ? `중지 0/${totalCount}` : '중지';
}
