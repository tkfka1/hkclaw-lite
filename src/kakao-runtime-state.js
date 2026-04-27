import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getProjectLayout } from './store.js';
import { assert, readJson, timestamp, writeJson } from './utils.js';

const KAKAO_STATUS_FILENAME = 'kakao-status.json';
const KAKAO_AGENT_STATUSES_DIRNAME = 'kakao-agent-statuses';
const KAKAO_COMMANDS_DIRNAME = 'kakao-commands';
const KAKAO_AGENT_COMMANDS_DIRNAME = 'kakao-agent-commands';
const KAKAO_HEARTBEAT_STALE_MS = 45_000;

export function getKakaoStatusPath(projectRoot) {
  return path.join(getProjectLayout(projectRoot).toolRoot, KAKAO_STATUS_FILENAME);
}

export function getKakaoAgentStatusesPath(projectRoot) {
  return path.join(getProjectLayout(projectRoot).toolRoot, KAKAO_AGENT_STATUSES_DIRNAME);
}

export function getKakaoAgentStatusPath(projectRoot, agentName) {
  assert(agentName, 'Agent name is required.');
  return path.join(getKakaoAgentStatusesPath(projectRoot), `${agentName}.json`);
}

export function getKakaoCommandQueuePath(projectRoot, agentName = null) {
  if (agentName) {
    return path.join(
      getProjectLayout(projectRoot).toolRoot,
      KAKAO_AGENT_COMMANDS_DIRNAME,
      agentName,
    );
  }
  return path.join(getProjectLayout(projectRoot).toolRoot, KAKAO_COMMANDS_DIRNAME);
}

export function inspectKakaoAgentConfigs(config, channels, runtimeStatus = null) {
  const kakaoChannels = channels.filter((channel) => (channel?.platform || 'discord') === 'kakao');
  const agents = config?.agents || {};
  const connectors = Object.fromEntries(
    Object.entries(config?.connectors || {}).filter(([, connector]) => connector?.type === 'kakao'),
  );
  const runtimeAgents = runtimeStatus?.agents || runtimeStatus?.accounts || {};

  return {
    kakaoChannelCount: kakaoChannels.length,
    agents: Object.fromEntries(
      Object.entries({ ...agents, ...connectors }).map(([name, entry]) => {
        const connector = connectors[name];
        const agent = agents[name];
        const sourceConfig = connector || agent || {};
        const runtimeAgent = runtimeAgents[name] || {};
        const hasConfiguredToken = Boolean(sourceConfig?.kakaoRelayToken || sourceConfig?.kakaoSessionToken);
        const usesKakao = connector ? connector.type === 'kakao' : (agent?.platform || 'discord') === 'kakao';
        return [
          name,
          {
            configured: usesKakao || hasConfiguredToken || Boolean(runtimeAgent.tokenConfigured),
            required: kakaoChannels.some(
              (channel) =>
                channel.connector === name ||
                (!channel.connector &&
                  (channel.agent === name ||
                    channel.reviewer === name ||
                    channel.arbiter === name)),
            ),
            agent: agent?.agent || '',
            connector: Boolean(connector),
            source: hasConfiguredToken
              ? 'config'
              : runtimeAgent.tokenConfigured
                ? 'kakao serve'
                : usesKakao
                  ? 'pairing'
                  : '없음',
            tokenConfigured: usesKakao || hasConfiguredToken || Boolean(runtimeAgent.tokenConfigured),
            connected: Boolean(runtimeAgent.connected),
            relayUrl: runtimeAgent.relayUrl || sourceConfig?.kakaoRelayUrl || '',
            pairingCode: runtimeAgent.pairingCode || '',
            pairingExpiresIn: runtimeAgent.pairingExpiresIn || null,
            pairedUserId: runtimeAgent.pairedUserId || '',
            sessionTokenConfigured: Boolean(sourceConfig?.kakaoSessionToken || runtimeAgent.sessionTokenConfigured),
          },
        ];
      }),
    ),
  };
}

export function readKakaoServiceStatus(projectRoot) {
  return readJson(getKakaoStatusPath(projectRoot), null);
}

export function writeKakaoServiceStatus(projectRoot, value) {
  writeJson(getKakaoStatusPath(projectRoot), value);
}

export function readKakaoAgentServiceStatus(projectRoot, agentName) {
  return readJson(getKakaoAgentStatusPath(projectRoot, agentName), null);
}

export function writeKakaoAgentServiceStatus(projectRoot, agentName, value) {
  writeJson(getKakaoAgentStatusPath(projectRoot, agentName), value);
}

export function listKakaoAgentServiceStatuses(projectRoot) {
  const statusesPath = getKakaoAgentStatusesPath(projectRoot);
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

export function buildKakaoServiceSnapshot(projectRoot, rawStatus = undefined) {
  if (rawStatus !== undefined) {
    return buildSingleKakaoServiceSnapshot(rawStatus);
  }

  rawStatus = readKakaoServiceStatus(projectRoot);
  const platformService = buildSingleKakaoServiceSnapshot(rawStatus);
  const agentStatuses = listKakaoAgentServiceStatuses(projectRoot);
  const agentNames = Object.keys(agentStatuses);
  if (agentNames.length > 0) {
    const agentServices = Object.fromEntries(
      agentNames.map((agentName) => [
        agentName,
        buildKakaoAgentServiceSnapshot(projectRoot, agentName, agentStatuses[agentName]),
      ]),
    );
    const runningAgentNames = agentNames.filter((agentName) => agentServices[agentName].running);
    const staleAgentNames = agentNames.filter((agentName) => agentServices[agentName].stale);
    const platformAgents = buildServiceAgentSummary(rawStatus?.agents || rawStatus?.accounts || {});
    const agents = {
      ...platformAgents,
      ...Object.fromEntries(
        agentNames.map((agentName) => [
          agentName,
          buildServiceAgentSummary(agentStatuses[agentName]?.agents || agentStatuses[agentName]?.accounts || {})[agentName] || {
            tokenConfigured: false,
            connected: false,
            relayUrl: '',
            pairingCode: '',
            pairingExpiresIn: null,
            pairedUserId: '',
            sessionTokenConfigured: false,
            agent: '',
          },
        ]),
      ),
    };
    const platformRunningCount = platformService.running || platformService.starting ? 1 : 0;
    const platformStaleCount = platformService.stale ? 1 : 0;
    const runningCount = runningAgentNames.length + platformRunningCount;
    const staleCount = staleAgentNames.length + platformStaleCount;
    const totalCount = agentNames.length + (rawStatus ? 1 : 0);
    const state =
      runningCount > 0 ? 'running' : staleCount > 0 ? 'stale' : 'stopped';

    return {
      state,
      label: buildAggregateKakaoServiceLabel({
        state,
        runningCount,
        totalCount,
        staleCount,
      }),
      running: runningCount > 0,
      stale: staleCount > 0,
      desiredRunning: agentNames.some(
        (agentName) => Boolean(agentStatuses[agentName]?.desiredRunning ?? agentStatuses[agentName]?.running),
      ) || platformService.desiredRunning,
      pid: platformService.pid,
      pidAlive: platformService.pidAlive,
      heartbeatFresh: platformService.heartbeatFresh,
      startedAt: platformService.startedAt,
      stoppedAt: platformService.stoppedAt,
      heartbeatAt: platformService.heartbeatAt,
      lastError: platformService.lastError,
      agents,
      platformService,
      agentServices,
      runningAgentCount: runningCount,
      totalAgentCount: totalCount,
    };
  }

  return platformService;
}

export function buildKakaoAgentServiceSnapshot(
  projectRoot,
  agentName,
  rawStatus = readKakaoAgentServiceStatus(projectRoot, agentName),
) {
  return {
    agentName,
    ...buildSingleKakaoServiceSnapshot(rawStatus),
  };
}

function buildSingleKakaoServiceSnapshot(rawStatus) {
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
      lastError: null,
      agents: emptyAgents,
    };
  }

  const pidAlive =
    Number.isInteger(rawStatus.pid) && rawStatus.pid > 0 ? isPidAlive(rawStatus.pid) : false;
  const heartbeatFresh = isHeartbeatFresh(rawStatus.heartbeatAt);

  let state = 'stopped';
  if (rawStatus.running && heartbeatFresh) {
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
    label: localizeKakaoServiceState(state),
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
    lastError: rawStatus.lastError || null,
    agents: buildServiceAgentSummary(rawStatus.agents || rawStatus.accounts),
  };
}

export function createKakaoServiceStatus(projectRoot, options = {}) {
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
    lastError: options.lastError || null,
    agents: buildServiceAgentSummary(options.agents || options.accounts),
  };
}

export function enqueueKakaoServiceCommand(projectRoot, input = {}) {
  const action = String(input?.action || '').trim();
  assert(action, 'Kakao service command action is required.');
  const agentName =
    input?.agentName || input?.accountName ? String(input.agentName || input.accountName).trim() : null;
  assert(
    agentName || action === 'reload-config',
    'Kakao service command agentName is required.',
  );

  const command = {
    version: 1,
    id: randomUUID(),
    action,
    agentName,
    requestedAt: timestamp(),
  };
  const filePath = path.join(
    getKakaoCommandQueuePath(projectRoot, agentName),
    `${Date.now()}-${command.id}.json`,
  );
  writeJson(filePath, command);
  return command;
}

export function listKakaoServiceCommands(projectRoot, { agentName = null } = {}) {
  const queuePath = getKakaoCommandQueuePath(projectRoot, agentName);
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

export function deleteKakaoServiceCommand(commandOrPath) {
  const filePath =
    typeof commandOrPath === 'string' ? commandOrPath : commandOrPath?.filePath || null;
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }
  fs.rmSync(filePath, { force: true });
  return true;
}

export function deleteKakaoAgentServiceArtifacts(projectRoot, agentName) {
  assert(agentName, 'Agent name is required.');

  const statusPath = getKakaoAgentStatusPath(projectRoot, agentName);
  const commandQueuePath = getKakaoCommandQueuePath(projectRoot, agentName);

  fs.rmSync(statusPath, { force: true });
  fs.rmSync(commandQueuePath, { recursive: true, force: true });
}

function buildServiceAgentSummary(input = {}) {
  return Object.fromEntries(
    Object.entries(input || {}).map(([name, source]) => [
      name,
      {
        tokenConfigured: Boolean(source?.tokenConfigured),
        connected: Boolean(source?.connected),
        relayUrl: source?.relayUrl || '',
        pairingCode: source?.pairingCode || '',
        pairingExpiresIn: source?.pairingExpiresIn || null,
        pairedUserId: source?.pairedUserId || '',
        sessionTokenConfigured: Boolean(source?.sessionTokenConfigured),
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
  return Date.now() - parsed <= KAKAO_HEARTBEAT_STALE_MS;
}

function localizeKakaoServiceState(state) {
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

function buildAggregateKakaoServiceLabel({ state, runningCount, totalCount, staleCount }) {
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
