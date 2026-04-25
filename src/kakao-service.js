import fs from 'node:fs';

import { executeChannelTurn, isTribunalChannel } from './channel-runtime.js';
import { resolveChannelRoleAgentNames } from './discord-runtime-state.js';
import {
  listPendingRuntimeOutboxEvents,
  markRuntimeOutboxEventDispatched,
} from './runtime-db.js';
import { listChannels, loadConfig, resolveProjectPath } from './store.js';
import {
  createKakaoServiceStatus,
  deleteKakaoServiceCommand,
  listKakaoServiceCommands,
  writeKakaoAgentServiceStatus,
  writeKakaoServiceStatus,
} from './kakao-runtime-state.js';
import { assert, timestamp, toErrorMessage } from './utils.js';

export const DEFAULT_KAKAO_RELAY_URL = 'https://k.tess.dev/';

const KAKAO_RELAY_URL_ENV_KEYS = [
  'OPENCLAW_TALKCHANNEL_RELAY_URL',
  'KAKAO_TALKCHANNEL_RELAY_URL',
];
const KAKAO_OUTBOX_FLUSH_INTERVAL_MS = 1_000;
const KAKAO_COMMAND_POLL_INTERVAL_MS = 1_000;
const KAKAO_HEARTBEAT_INTERVAL_MS = 10_000;
const KAKAO_RECONNECT_DELAY_MS = 1_000;
const KAKAO_MAX_RECONNECT_DELAY_MS = 30_000;
const KAKAO_SSE_TIMEOUT_MS = 300_000;
const KAKAO_MESSAGE_LIMIT = 900;

export async function serveKakao(projectRoot, { agentName = null } = {}) {
  const config = loadConfig(projectRoot);
  let agentConfigs = resolveKakaoAgentConfigs(config, { agentName });
  const persistServiceStatus = (value) =>
    agentName
      ? writeKakaoAgentServiceStatus(projectRoot, agentName, value)
      : writeKakaoServiceStatus(projectRoot, value);

  const serviceStatus = createKakaoServiceStatus(projectRoot, {
    agentName,
    running: false,
    desiredRunning: true,
    heartbeatAt: timestamp(),
    agents: buildKakaoAgentStatus(agentConfigs),
  });
  persistServiceStatus(serviceStatus);

  let heartbeatTimer = null;
  let outboxTimer = null;
  let commandTimer = null;
  let clients = {};
  let shuttingDown = false;
  let outboxFlushTask = Promise.resolve();
  let commandTask = Promise.resolve();

  try {
    clients = await createKakaoClients(agentConfigs, {
      projectRoot,
      serviceStatus,
      persistServiceStatus,
    });
    hydrateKakaoAgentStatus(serviceStatus.agents, agentConfigs, clients);
    serviceStatus.running = true;
    serviceStatus.startedAt = serviceStatus.startedAt || timestamp();
    serviceStatus.stoppedAt = null;
    serviceStatus.lastError = null;
    serviceStatus.heartbeatAt = timestamp();
    persistServiceStatus(serviceStatus);

    const enqueueOutboxFlush = (task) => {
      const next = outboxFlushTask.catch(() => {}).then(task);
      outboxFlushTask = next.catch(() => {});
      return next;
    };

    const enqueueCommandProcessing = (task) => {
      const next = commandTask.catch(() => {}).then(task);
      commandTask = next.catch(() => {});
      return next;
    };

    heartbeatTimer = setInterval(() => {
      serviceStatus.heartbeatAt = timestamp();
      persistServiceStatus(serviceStatus);
    }, KAKAO_HEARTBEAT_INTERVAL_MS);

    await enqueueOutboxFlush(() => flushPendingKakaoOutbox(projectRoot, clients, { agentName }));
    outboxTimer = setInterval(() => {
      void enqueueOutboxFlush(() => flushPendingKakaoOutbox(projectRoot, clients, { agentName }))
        .catch((error) => {
          console.error(`Kakao outbox flush error: ${toErrorMessage(error)}`);
        });
    }, KAKAO_OUTBOX_FLUSH_INTERVAL_MS);

    commandTimer = setInterval(() => {
      void enqueueCommandProcessing(() =>
        processKakaoServiceCommands({
          projectRoot,
          agentName,
          clients,
          agentConfigs,
          serviceStatus,
          persistServiceStatus,
        }),
      )
        .then((nextAgentConfigs) => {
          agentConfigs = nextAgentConfigs;
        })
        .catch((error) => {
          serviceStatus.lastError = `Command processing failed: ${toErrorMessage(error)}`;
          serviceStatus.heartbeatAt = timestamp();
          persistServiceStatus(serviceStatus);
          console.error(`Kakao command error: ${toErrorMessage(error)}`);
        });
    }, KAKAO_COMMAND_POLL_INTERVAL_MS);

    printKakaoStartup(projectRoot, clients);
    await waitForShutdown(async () => {
      shuttingDown = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (outboxTimer) clearInterval(outboxTimer);
      if (commandTimer) clearInterval(commandTimer);
      for (const client of Object.values(clients)) {
        client.controller.abort();
      }
      await Promise.allSettled(Object.values(clients).map((client) => client.streamTask));
      serviceStatus.running = false;
      serviceStatus.stoppedAt = timestamp();
      serviceStatus.heartbeatAt = timestamp();
      persistServiceStatus(serviceStatus);
    });
  } catch (error) {
    shuttingDown = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (outboxTimer) clearInterval(outboxTimer);
    if (commandTimer) clearInterval(commandTimer);
    for (const client of Object.values(clients)) {
      client.controller?.abort?.();
    }
    serviceStatus.running = false;
    serviceStatus.lastError = toErrorMessage(error);
    serviceStatus.stoppedAt = timestamp();
    serviceStatus.heartbeatAt = timestamp();
    persistServiceStatus(serviceStatus);
    if (!shuttingDown) {
      throw error;
    }
    throw error;
  }
}

async function createKakaoClients(agentConfigs, context) {
  const clients = {};
  for (const [agentName, agentConfig] of Object.entries(agentConfigs)) {
    clients[agentName] = await createKakaoClient(agentConfig, context);
  }
  return clients;
}

async function createKakaoClient(agentConfig, { projectRoot, serviceStatus, persistServiceStatus }) {
  const tokenInfo = await resolveKakaoRelayToken(agentConfig);
  const controller = new AbortController();
  const client = {
    name: agentConfig.name,
    agent: agentConfig.agent,
    relayUrl: tokenInfo.relayUrl,
    token: tokenInfo.token,
    tokenSource: tokenInfo.source,
    sessionTokenConfigured: tokenInfo.source === 'session' || tokenInfo.source === 'created-session',
    tokenConfigured: Boolean(tokenInfo.token),
    pairingCode: tokenInfo.pairingCode || '',
    pairingExpiresIn: tokenInfo.pairingExpiresIn || null,
    pairedUserId: '',
    connected: false,
    controller,
    streamTask: null,
  };

  const updateStatus = () => {
    serviceStatus.agents[agentConfig.name] = buildKakaoAgentStatusEntry(agentConfig, client);
    serviceStatus.heartbeatAt = timestamp();
    serviceStatus.lastError = null;
    persistServiceStatus(serviceStatus);
  };
  updateStatus();

  client.streamTask = connectKakaoSse(
    client,
    async (message) => {
      await handleInboundKakaoMessage({
        projectRoot,
        clients: { [agentConfig.name]: client },
        inboundAgentName: agentConfig.name,
        workerAgentName: agentConfig.name,
        message,
      });
    },
    controller.signal,
    {
      onConnected: () => {
        client.connected = true;
        updateStatus();
      },
      onDisconnected: () => {
        client.connected = false;
        updateStatus();
      },
      onPairingComplete: (data) => {
        client.pairedUserId = data?.kakaoUserId || client.pairedUserId;
        client.pairingCode = '';
        client.pairingExpiresIn = null;
        updateStatus();
      },
      onPairingExpired: () => {
        client.pairingCode = '';
        client.pairingExpiresIn = null;
        updateStatus();
      },
      onError: (error) => {
        serviceStatus.lastError = toErrorMessage(error);
        serviceStatus.heartbeatAt = timestamp();
        persistServiceStatus(serviceStatus);
      },
    },
  ).catch((error) => {
    if (!controller.signal.aborted) {
      client.connected = false;
      serviceStatus.lastError = toErrorMessage(error);
      serviceStatus.heartbeatAt = timestamp();
      persistServiceStatus(serviceStatus);
      console.error(`Kakao SSE error for ${agentConfig.name}: ${toErrorMessage(error)}`);
    }
  });

  return client;
}

async function resolveKakaoRelayToken(agentConfig) {
  const relayUrl = normalizeRelayUrl(agentConfig.relayUrl || getDefaultKakaoRelayUrl());
  if (agentConfig.sessionToken) {
    return { relayUrl, token: agentConfig.sessionToken, source: 'session' };
  }
  if (agentConfig.relayToken) {
    return { relayUrl, token: agentConfig.relayToken, source: 'config' };
  }
  const envToken = process.env.OPENCLAW_TALKCHANNEL_RELAY_TOKEN || process.env.KAKAO_TALKCHANNEL_RELAY_TOKEN;
  if (envToken) {
    return { relayUrl, token: envToken, source: 'env' };
  }

  const session = await createKakaoRelaySession(relayUrl);
  return {
    relayUrl,
    token: session.sessionToken,
    source: 'created-session',
    pairingCode: session.pairingCode,
    pairingExpiresIn: session.expiresIn,
  };
}

export async function createKakaoRelaySession(relayUrl = getDefaultKakaoRelayUrl()) {
  const response = await fetch(`${normalizeRelayUrl(relayUrl)}v1/sessions/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await response.json().catch(() => null);
  assert(
    response.ok,
    data?.message || data?.error || `Kakao relay session create failed with status ${response.status}.`,
  );
  assert(data?.sessionToken, 'Kakao relay did not return a session token.');
  return {
    sessionToken: String(data.sessionToken),
    pairingCode: String(data.pairingCode || ''),
    expiresIn: Number.isFinite(Number(data.expiresIn)) ? Number(data.expiresIn) : null,
    status: data.status || 'pending_pairing',
  };
}

export async function connectKakaoSse(client, onMessage, abortSignal, callbacks = {}) {
  let reconnectAttempt = 0;
  let lastEventId = '';

  while (!abortSignal.aborted) {
    const timeout = createTimeoutSignal(KAKAO_SSE_TIMEOUT_MS, abortSignal);
    try {
      const headers = {
        authorization: `Bearer ${client.token}`,
        accept: 'text/event-stream',
        'cache-control': 'no-cache',
      };
      if (lastEventId) {
        headers['last-event-id'] = lastEventId;
      }

      const response = await fetch(`${normalizeRelayUrl(client.relayUrl)}v1/events`, {
        method: 'GET',
        headers,
        signal: timeout.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 410) {
          throw new Error(`Kakao relay session invalidated: HTTP ${response.status}`);
        }
        throw new Error(`Kakao relay SSE failed: HTTP ${response.status}`);
      }
      assert(response.body, 'Kakao relay SSE response did not include a body.');

      reconnectAttempt = 0;
      callbacks.onConnected?.();
      const reader = response.body.getReader();
      try {
        const decoder = new TextDecoder();
        let buffer = '';
        while (!abortSignal.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseKakaoSseChunk(buffer);
          if (parsed.consumed > 0) {
            buffer = buffer.slice(parsed.consumed);
          }
          if (parsed.parseErrors > 0) {
            callbacks.onError?.(new Error(`Skipped ${parsed.parseErrors} malformed Kakao SSE event(s).`));
          }
          for (const event of parsed.events) {
            if (event.id) {
              lastEventId = event.id;
            }
            if (event.event === 'message') {
              await onMessage(event.data);
            } else if (event.event === 'pairing_complete') {
              callbacks.onPairingComplete?.(event.data);
            } else if (event.event === 'pairing_expired') {
              callbacks.onPairingExpired?.(event.data?.reason || 'expired');
            } else if (event.event === 'error') {
              callbacks.onError?.(new Error(event.data?.message || 'Kakao relay event error.'));
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (abortSignal.aborted) {
        return;
      }
      callbacks.onDisconnected?.();
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      reconnectAttempt += 1;
      const delay = calculateKakaoReconnectDelay(reconnectAttempt);
      await sleep(delay, abortSignal).catch(() => {});
    } finally {
      timeout.clear();
    }
  }
}

export function parseKakaoSseChunk(chunk) {
  const events = [];
  let consumed = 0;
  let searchFrom = 0;
  let parseErrors = 0;

  while (true) {
    const boundary = chunk.indexOf('\n\n', searchFrom);
    if (boundary === -1) {
      break;
    }
    const block = chunk.slice(consumed, boundary);
    const endPos = boundary + 2;
    const current = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        current.event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        current.data = `${current.data || ''}${line.slice(5).trim()}`;
      } else if (line.startsWith('id:')) {
        current.id = line.slice(3).trim();
      }
    }
    if (current.event && current.data) {
      try {
        events.push({
          event: current.event,
          data: JSON.parse(current.data),
          id: current.id,
        });
      } catch {
        parseErrors += 1;
      }
    }
    consumed = endPos;
    searchFrom = endPos;
  }

  return { events, consumed, parseErrors };
}

function calculateKakaoReconnectDelay(attempt) {
  const exponential = KAKAO_RECONNECT_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, KAKAO_MAX_RECONNECT_DELAY_MS);
  return Math.floor(capped + capped * 0.2 * Math.random());
}

async function handleInboundKakaoMessage({
  projectRoot,
  clients,
  inboundAgentName,
  workerAgentName,
  message,
}) {
  const prompt = String(message?.normalized?.text || '').trim();
  if (!prompt) {
    return;
  }
  const messageId = String(message?.id || '').trim();
  if (!messageId) {
    return;
  }

  const config = loadConfig(projectRoot);
  const channel = resolveKakaoChannelForMessage(config, message, inboundAgentName);
  if (!channel) {
    return;
  }

  const workspace = channel.workspace || channel.workdir;
  assert(workspace, `Channel "${channel.name}" does not define a workspace.`);
  const workdir = resolveProjectPath(projectRoot, workspace);
  assert(fs.existsSync(workdir), `Workspace does not exist: ${workdir}`);

  let runId = null;
  try {
    const result = await executeChannelTurn({
      projectRoot,
      config,
      channel,
      prompt,
      workdir,
    });
    runId = result.runId || null;
  } catch (error) {
    runId = error?.runtimeRunId || null;
    if (runId) {
      await flushKakaoOutboxForRun(projectRoot, clients, channel, runId, messageId, {
        agentName: workerAgentName,
      });
    }
    const client = clients[inboundAgentName];
    if (client) {
      await sendKakaoText(client, messageId, formatKakaoErrorMessage(error));
    }
    throw error;
  }

  if (runId) {
    await flushKakaoOutboxForRun(projectRoot, clients, channel, runId, messageId, {
      agentName: workerAgentName,
    });
  }
}

export function resolveKakaoChannelForMessage(config, message, inboundAgentName) {
  const normalized = message?.normalized || {};
  const kakaoChannels = listChannels(config).filter((entry) => (entry.platform || 'discord') === 'kakao');
  const matchesTarget = (entry) => matchesKakaoChannelTarget(entry, normalized);

  return (
    kakaoChannels.find((entry) => entry.connector === inboundAgentName && matchesTarget(entry)) ||
    kakaoChannels.find(
      (entry) => !entry.connector && resolveChannelInboundAgentName(entry) === inboundAgentName && matchesTarget(entry),
    )
  );
}

export function getDefaultKakaoRelayUrl() {
  for (const key of KAKAO_RELAY_URL_ENV_KEYS) {
    const value = String(process.env[key] || '').trim();
    if (value) {
      return normalizeRelayUrl(value);
    }
  }
  return DEFAULT_KAKAO_RELAY_URL;
}

function matchesKakaoChannelTarget(channel, normalized) {
  const channelId = String(normalized?.channelId || '').trim();
  const userId = String(normalized?.userId || '').trim();
  const configuredChannelId = String(channel?.kakaoChannelId || '*').trim() || '*';
  const configuredUserId = String(channel?.kakaoUserId || '').trim();

  if (configuredChannelId !== '*' && configuredChannelId !== channelId) {
    return false;
  }
  if (configuredUserId && configuredUserId !== userId) {
    return false;
  }
  return true;
}

async function processKakaoServiceCommands({
  projectRoot,
  agentName,
  clients,
  agentConfigs,
  serviceStatus,
  persistServiceStatus,
}) {
  const commands = listKakaoServiceCommands(projectRoot, { agentName });
  if (commands.length === 0) {
    return agentConfigs;
  }

  let nextAgentConfigs = agentConfigs;
  for (const command of commands) {
    try {
      if (
        command.action === 'reload-config' ||
        command.action === 'reconnect-agent' ||
        command.action === 'reconnect-account'
      ) {
        nextAgentConfigs = await reloadKakaoServiceConfig({
          projectRoot,
          agentName,
          clients,
          command,
          serviceStatus,
          persistServiceStatus,
        });
      }
    } finally {
      deleteKakaoServiceCommand(command);
    }
  }

  return nextAgentConfigs;
}

async function reloadKakaoServiceConfig({
  projectRoot,
  agentName,
  clients,
  command,
  serviceStatus,
  persistServiceStatus,
}) {
  const config = loadConfig(projectRoot);
  const nextAgentConfigs = resolveKakaoAgentConfigs(config, { agentName });
  const targetAgentName = String(command?.agentName || command?.accountName || agentName || '').trim();
  const targets = targetAgentName ? [targetAgentName] : Object.keys(nextAgentConfigs);

  for (const name of targets) {
    const currentClient = clients[name];
    if (currentClient) {
      currentClient.controller.abort();
      await currentClient.streamTask.catch(() => {});
      delete clients[name];
    }
    const nextAgentConfig = nextAgentConfigs[name];
    if (nextAgentConfig) {
      clients[name] = await createKakaoClient(nextAgentConfig, {
        projectRoot,
        serviceStatus,
        persistServiceStatus,
      });
    }
  }

  serviceStatus.agents = buildKakaoAgentStatus(nextAgentConfigs);
  hydrateKakaoAgentStatus(serviceStatus.agents, nextAgentConfigs, clients);
  serviceStatus.lastError = null;
  serviceStatus.heartbeatAt = timestamp();
  persistServiceStatus(serviceStatus);
  return nextAgentConfigs;
}

export async function sendKakaoReply(client, messageId, response) {
  assert(client?.relayUrl, 'Kakao relay URL is required.');
  assert(client?.token, 'Kakao relay token is required.');
  assert(messageId, 'Kakao message id is required.');
  const httpResponse = await fetch(`${normalizeRelayUrl(client.relayUrl)}openclaw/reply`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${client.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messageId, response }),
  });
  const data = await httpResponse.json().catch(() => null);
  assert(
    httpResponse.ok,
    data?.error?.message || data?.message || data?.error || `Kakao reply failed with status ${httpResponse.status}.`,
  );
  return data;
}

async function sendKakaoText(client, messageId, text) {
  for (const response of buildKakaoSkillResponses(text)) {
    await sendKakaoReply(client, messageId, response);
  }
}

export function buildKakaoSkillResponses(text) {
  const cardResponse = tryBuildKakaoCardResponse(text);
  if (cardResponse) {
    return [cardResponse];
  }
  return splitKakaoMessage(stripMarkdown(String(text || '').trim()) || '(빈 응답)').map((chunk) => ({
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text: chunk } }],
    },
  }));
}

function tryBuildKakaoCardResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const outputs = buildKakaoOutputsFromData(parsed);
  if (outputs.length === 0) {
    return null;
  }
  const response = {
    version: '2.0',
    template: {
      outputs: outputs.slice(0, 3),
    },
  };
  if (Array.isArray(parsed.quickReplies)) {
    response.template.quickReplies = parsed.quickReplies.slice(0, 10);
  }
  return response;
}

function buildKakaoOutputsFromData(data) {
  if (Array.isArray(data.outputs)) {
    return data.outputs;
  }
  const outputs = [];
  for (const key of [
    'simpleText',
    'simpleImage',
    'textCard',
    'basicCard',
    'commerceCard',
    'listCard',
    'itemCard',
    'carousel',
  ]) {
    if (data[key]) {
      outputs.push({ [key]: data[key] });
    }
  }
  return outputs;
}

export function formatKakaoRoleMessage(channel, entry) {
  const content = String(entry?.content || '').trim() || '(빈 응답)';
  if (!isTribunalChannel(channel)) {
    return content;
  }

  const title = resolveRoleMessageTitle(channel, entry);
  const meta = [];
  if (channel?.name) {
    meta.push(channel.name);
  }
  if (entry?.mode === 'tribunal' && entry?.round && entry?.maxRounds) {
    meta.push(`${entry.round}/${entry.maxRounds}`);
  }
  if (entry?.role === 'reviewer') {
    meta.push(localizeReviewerVerdict(entry.verdict));
  }
  if (entry?.role === 'arbiter') {
    meta.push('최종 정리');
  }

  return [
    `${title}${entry?.agent?.name ? ` · ${entry.agent.name}` : ''}`,
    meta.join(' · '),
    '',
    content,
  ]
    .filter((line, index) => index === 2 || Boolean(line))
    .join('\n');
}

export async function flushKakaoOutboxForRun(
  projectRoot,
  clients,
  channel,
  runId,
  messageId,
  { agentName = null, accountName = null } = {},
) {
  const selectedAgentName = agentName || accountName;
  const events = await listPendingRuntimeOutboxEvents(projectRoot, { runId, limit: 100 });
  for (const event of events) {
    try {
      const targetAgentName = resolveEventAgentName(channel, event.role);
      const client =
        (channel?.connector ? clients[channel.connector] : null) ||
        clients[targetAgentName] ||
        (selectedAgentName ? clients[selectedAgentName] : null) ||
        clients[resolveChannelInboundAgentName(channel)] ||
        Object.values(clients)[0];
      assert(client, `${targetAgentName || event.role} kakao client is not configured.`);
      await sendKakaoText(client, messageId, formatKakaoRoleMessage(channel, event));
      await markRuntimeOutboxEventDispatched(projectRoot, event.eventId);
    } catch (error) {
      console.error(`Kakao outbox delivery error for event ${event.eventId}: ${toErrorMessage(error)}`);
    }
  }
}

export async function flushPendingKakaoOutbox(projectRoot, clients, { limit = 100, agentName = null } = {}) {
  void projectRoot;
  void clients;
  void limit;
  void agentName;
  // Kakao relay replies need the original relay messageId. That id is only available
  // while handling the inbound SSE event, so orphaned queued events cannot be safely
  // redelivered after a process restart.
  return 0;
}

function formatKakaoErrorMessage(error) {
  const raw = toErrorMessage(error);
  if (/timeout|timed?\s*out/iu.test(raw)) {
    return '에이전트 응답 시간이 초과되었습니다. 다시 시도해 주세요.';
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed/iu.test(raw)) {
    return 'AI 서비스나 카카오 릴레이에 연결할 수 없습니다. 서비스 상태를 확인해 주세요.';
  }
  if (/auth|unauthorized|forbidden|login|401|410/iu.test(raw)) {
    return '인증 또는 페어링이 만료되었습니다. Kakao 워커를 재시작한 뒤 다시 페어링해 주세요.';
  }
  if (/rate.?limit|too many requests|429/iu.test(raw)) {
    return 'API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
  }
  if (/workspace does not exist/iu.test(raw)) {
    return '워크스페이스 경로를 찾을 수 없습니다. 채널 설정을 확인해 주세요.';
  }
  const truncated = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return `오류: ${truncated}`;
}

function splitKakaoMessage(text) {
  const input = String(text || '').trim();
  if (!input) {
    return ['(빈 응답)'];
  }
  const chunks = [];
  let remaining = input;
  while (remaining.length > KAKAO_MESSAGE_LIMIT && chunks.length < 3) {
    let splitIndex = remaining.lastIndexOf('\n', KAKAO_MESSAGE_LIMIT);
    if (splitIndex < Math.floor(KAKAO_MESSAGE_LIMIT / 2)) {
      splitIndex = remaining.lastIndexOf(' ', KAKAO_MESSAGE_LIMIT);
    }
    if (splitIndex < Math.floor(KAKAO_MESSAGE_LIMIT / 2)) {
      splitIndex = KAKAO_MESSAGE_LIMIT;
    }
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining && chunks.length < 3) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
}

export function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/gu, (match) => match.replace(/```\w*\n?/gu, '').replace(/```$/u, '').trim())
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '[이미지: $1]')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1 ($2)')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/~~([^~]+)~~/gu, '$1')
    .replace(/^>\s?/gmu, '')
    .replace(/^[\s]*[-*+]\s+/gmu, '• ')
    .replace(/^[\s]*\d+\.\s+/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function resolveKakaoAgentConfigs(config, { agentName = null } = {}) {
  if (agentName) {
    const connector = config?.connectors?.[agentName];
    if (connector) {
      assert(connector.type === 'kakao', `Connector "${agentName}" is not configured for Kakao.`);
      return {
        [agentName]: buildKakaoConnectorConfig(agentName, connector),
      };
    }
    const agent = config?.agents?.[agentName];
    assert(agent, `Agent or connector "${agentName}" does not exist.`);
    assert((agent?.platform || 'discord') === 'kakao', `Agent "${agentName}" is not configured for Kakao.`);
    return {
      [agentName]: buildKakaoAgentConfig(agentName, agent),
    };
  }

  const configuredConnectors = config?.connectors || {};
  const connectorEntries = Object.entries(configuredConnectors).filter(
    ([, connector]) => connector?.type === 'kakao',
  );
  const configuredAgents = config?.agents || {};
  const configuredAgentEntries = Object.entries(configuredAgents).filter(
    ([name, agent]) => (agent?.platform || 'discord') === 'kakao' && !configuredConnectors[name],
  );
  return {
    ...Object.fromEntries(
      connectorEntries.map(([name, connector]) => [name, buildKakaoConnectorConfig(name, connector)]),
    ),
    ...Object.fromEntries(
      configuredAgentEntries.map(([name, agent]) => [name, buildKakaoAgentConfig(name, agent)]),
    ),
  };
}

function buildKakaoAgentConfig(name, agent) {
  return {
    name,
    agent: agent.agent,
    relayUrl: String(agent.kakaoRelayUrl || '').trim() || getDefaultKakaoRelayUrl(),
    relayToken: String(agent.kakaoRelayToken || '').trim(),
    sessionToken: String(agent.kakaoSessionToken || '').trim(),
  };
}

function buildKakaoConnectorConfig(name, connector) {
  return {
    name,
    agent: '',
    relayUrl: String(connector.kakaoRelayUrl || '').trim() || getDefaultKakaoRelayUrl(),
    relayToken: String(connector.kakaoRelayToken || '').trim(),
    sessionToken: String(connector.kakaoSessionToken || '').trim(),
  };
}

function buildKakaoAgentStatus(agentConfigs) {
  return Object.fromEntries(
    Object.entries(agentConfigs).map(([agentName, agentConfig]) => [
      agentName,
      buildKakaoAgentStatusEntry(agentConfig, null),
    ]),
  );
}

export function buildKakaoAgentStatusEntry(agentConfig, client) {
  return {
    agent: agentConfig.agent || '',
    tokenConfigured: Boolean(client?.tokenConfigured || agentConfig.relayToken || agentConfig.sessionToken),
    connected: Boolean(client?.connected),
    relayUrl: client?.relayUrl || agentConfig.relayUrl || DEFAULT_KAKAO_RELAY_URL,
    pairingCode: client?.pairingCode || '',
    pairingExpiresIn: client?.pairingExpiresIn || null,
    pairedUserId: client?.pairedUserId || '',
    sessionTokenConfigured: Boolean(client?.sessionTokenConfigured || agentConfig.sessionToken),
  };
}

function hydrateKakaoAgentStatus(agents, agentConfigs, clients) {
  for (const [agentName, agentConfig] of Object.entries(agentConfigs)) {
    agents[agentName] = buildKakaoAgentStatusEntry(agentConfig, clients[agentName]);
  }
}

function resolveChannelInboundAgentName(channel) {
  const roleAgents = resolveChannelRoleAgentNames(channel);
  return roleAgents.owner || 'owner';
}

function resolveEventAgentName(channel, role) {
  const roleAgents = resolveChannelRoleAgentNames(channel);
  if (role === 'reviewer') {
    return roleAgents.reviewer || 'reviewer';
  }
  if (role === 'arbiter') {
    return roleAgents.arbiter || 'arbiter';
  }
  return roleAgents.owner || 'owner';
}

function resolveRoleMessageTitle(channel, entry) {
  if (!isTribunalChannel(channel)) {
    return 'owner 응답';
  }
  if (entry?.role === 'owner') {
    return 'owner 초안';
  }
  if (entry?.role === 'reviewer') {
    return 'reviewer 판정';
  }
  if (entry?.role === 'arbiter') {
    return 'arbiter 최종';
  }
  return entry?.role || '응답';
}

function localizeReviewerVerdict(verdict) {
  if (verdict === 'approved') {
    return '승인';
  }
  if (verdict === 'blocked') {
    return '수정 필요';
  }
  if (verdict === 'invalid') {
    return '판정 오류';
  }
  return '검토';
}

function normalizeRelayUrl(value) {
  const relayUrl = String(value || DEFAULT_KAKAO_RELAY_URL).trim() || DEFAULT_KAKAO_RELAY_URL;
  return relayUrl.endsWith('/') ? relayUrl : `${relayUrl}/`;
}

function createTimeoutSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let abortHandler = null;
  if (parentSignal) {
    abortHandler = () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
    parentSignal.addEventListener('abort', abortHandler, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timeoutId);
      if (parentSignal && abortHandler) {
        parentSignal.removeEventListener('abort', abortHandler);
      }
    },
  };
}

function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timeout = setTimeout(() => {
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
      resolve();
    }, ms);
    const abortHandler = () => {
      clearTimeout(timeout);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
}

function printKakaoStartup(projectRoot, clients) {
  console.log(`Kakao TalkChannel service ready for ${projectRoot}`);
  for (const [agentName, client] of Object.entries(clients)) {
    const relay = client?.relayUrl || DEFAULT_KAKAO_RELAY_URL;
    const pairing = client?.pairingCode ? ` pairing=/pair ${client.pairingCode}` : '';
    console.log(`${agentName}: ${relay}${pairing}`);
  }
  console.log('Press Ctrl+C to stop.');
}

async function waitForShutdown(onShutdown) {
  await new Promise((resolve) => {
    let closed = false;
    const finish = async () => {
      if (closed) {
        return;
      }
      closed = true;
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      await onShutdown();
      resolve();
    };

    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
  });
}
