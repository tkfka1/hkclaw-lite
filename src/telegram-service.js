import fs from 'node:fs';

import { executeChannelTurn, isTribunalChannel } from './channel-runtime.js';
import { resolveChannelRoleAgentNames } from './discord-runtime-state.js';
import {
  listPendingRuntimeOutboxEvents,
  markRuntimeOutboxEventDispatched,
} from './runtime-db.js';
import { listChannels, loadConfig, resolveProjectPath } from './store.js';
import {
  createTelegramServiceStatus,
  deleteTelegramServiceCommand,
  listTelegramServiceCommands,
  writeTelegramAgentServiceStatus,
  writeTelegramServiceStatus,
} from './telegram-runtime-state.js';
import { assert, timestamp, toErrorMessage } from './utils.js';

const TELEGRAM_MESSAGE_LIMIT = 3500;
const TELEGRAM_OUTBOX_FLUSH_INTERVAL_MS = 1_000;
const TELEGRAM_COMMAND_POLL_INTERVAL_MS = 1_000;
const TELEGRAM_HEARTBEAT_INTERVAL_MS = 10_000;
const TELEGRAM_UPDATES_TIMEOUT_SECONDS = 2;

export async function serveTelegram(projectRoot, { agentName = null } = {}) {
  const config = loadConfig(projectRoot);
  let agentConfigs = resolveTelegramAgentConfigs(config, { agentName });
  const persistServiceStatus = (value) =>
    agentName
      ? writeTelegramAgentServiceStatus(projectRoot, agentName, value)
      : writeTelegramServiceStatus(projectRoot, value);

  const serviceStatus = createTelegramServiceStatus(projectRoot, {
    agentName,
    running: false,
    desiredRunning: true,
    heartbeatAt: timestamp(),
    agents: buildTelegramAgentStatus(agentConfigs),
  });
  persistServiceStatus(serviceStatus);

  let heartbeatTimer = null;
  let outboxTimer = null;
  let commandTimer = null;
  let clients = {};
  let shuttingDown = false;
  let outboxFlushTask = Promise.resolve();
  let pollingTask = Promise.resolve();
  let commandTask = Promise.resolve();

  try {
    clients = await createTelegramClients(agentConfigs);
    hydrateTelegramAgentStatus(serviceStatus.agents, agentConfigs, clients);
    serviceStatus.running = true;
    serviceStatus.startedAt = serviceStatus.startedAt || timestamp();
    serviceStatus.stoppedAt = null;
    serviceStatus.lastError = null;
    serviceStatus.heartbeatAt = timestamp();
    persistServiceStatus(serviceStatus);

    const channelQueues = new Map();
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
    }, TELEGRAM_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    await enqueueOutboxFlush(() =>
      flushPendingTelegramOutbox(projectRoot, clients, { agentName }),
    );
    outboxTimer = setInterval(() => {
      void enqueueOutboxFlush(() =>
        flushPendingTelegramOutbox(projectRoot, clients, { agentName }),
      ).catch((error) => {
        console.error(`Telegram outbox flush error: ${toErrorMessage(error)}`);
      });
    }, TELEGRAM_OUTBOX_FLUSH_INTERVAL_MS);
    outboxTimer.unref?.();

    commandTimer = setInterval(() => {
      void enqueueCommandProcessing(() =>
        processTelegramServiceCommands({
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
          console.error(`Telegram command error: ${toErrorMessage(error)}`);
        });
    }, TELEGRAM_COMMAND_POLL_INTERVAL_MS);
    commandTimer.unref?.();

    printTelegramStartup(projectRoot, clients);
    pollingTask = runTelegramPollingLoop({
      projectRoot,
      clients,
      agentName,
      serviceStatus,
      persistServiceStatus,
      shuttingDown: () => shuttingDown,
    });
    await waitForShutdown(async () => {
      shuttingDown = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (outboxTimer) {
        clearInterval(outboxTimer);
      }
      if (commandTimer) {
        clearInterval(commandTimer);
      }
      serviceStatus.running = false;
      serviceStatus.stoppedAt = timestamp();
      serviceStatus.heartbeatAt = timestamp();
      persistServiceStatus(serviceStatus);
    });
    await pollingTask;
  } catch (error) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (outboxTimer) {
      clearInterval(outboxTimer);
    }
    if (commandTimer) {
      clearInterval(commandTimer);
    }
    serviceStatus.running = false;
    serviceStatus.lastError = toErrorMessage(error);
    serviceStatus.stoppedAt = timestamp();
    serviceStatus.heartbeatAt = timestamp();
    persistServiceStatus(serviceStatus);
    throw error;
  }

}

async function runTelegramPollingLoop({
  projectRoot,
  clients,
  agentName,
  serviceStatus,
  persistServiceStatus,
  shuttingDown,
}) {
  const channelQueues = new Map();
  while (!shuttingDown()) {
    await Promise.all(
      Object.entries(clients).map(async ([botName, client]) => {
        try {
          await pollTelegramUpdates({
            projectRoot,
            clients,
            botName,
            workerAgentName: agentName,
            client,
            channelQueues,
            serviceStatus,
            persistServiceStatus,
            shuttingDown,
          });
        } catch (error) {
          serviceStatus.lastError = toErrorMessage(error);
          serviceStatus.heartbeatAt = timestamp();
          persistServiceStatus(serviceStatus);
          console.error(`Telegram polling error: ${toErrorMessage(error)}`);
          await sleep(1000);
        }
      }),
    );
  }
}

async function createTelegramClients(agentConfigs) {
  const clients = {};
  for (const [agentName, agentConfig] of Object.entries(agentConfigs)) {
    if (!agentConfig?.token) {
      continue;
    }
    clients[agentName] = await createTelegramClient(agentConfig.token, agentConfig.agent);
  }
  return clients;
}

async function createTelegramClient(token, agent) {
  const me = await callTelegramApi(token, 'getMe', {});
  return {
    token,
    agent,
    offset: 0,
    me: {
      id: String(me?.id || ''),
      username: me?.username || '',
    },
  };
}

async function pollTelegramUpdates({
  projectRoot,
  clients,
  botName,
  workerAgentName,
  client,
  channelQueues,
  serviceStatus,
  persistServiceStatus,
  shuttingDown,
}) {
  if (shuttingDown()) {
    return;
  }

  const updates = await callTelegramApi(client.token, 'getUpdates', {
    offset: client.offset,
    timeout: TELEGRAM_UPDATES_TIMEOUT_SECONDS,
    allowed_updates: ['message'],
  });

  serviceStatus.heartbeatAt = timestamp();
  serviceStatus.lastError = null;
  persistServiceStatus(serviceStatus);

  for (const update of updates || []) {
    if (typeof update?.update_id === 'number') {
      client.offset = update.update_id + 1;
    }
    const message = update?.message;
    if (!message || message?.from?.is_bot) {
      continue;
    }
    const key = buildTelegramQueueKey(message);
    await enqueueChannelTask(channelQueues, key, async () => {
      await handleInboundTelegramMessage({
        projectRoot,
        clients,
        inboundAgentName: botName,
        workerAgentName,
        message,
      });
    }).catch((error) => {
      console.error(`Telegram handler error: ${toErrorMessage(error)}`);
      return sendTelegramText(
        client,
        String(message?.chat?.id || ''),
        formatTelegramErrorMessage(error),
        {
          threadId: message?.message_thread_id ? String(message.message_thread_id) : null,
        },
      );
    });
  }
}

async function handleInboundTelegramMessage({
  projectRoot,
  clients,
  inboundAgentName,
  workerAgentName,
  message,
}) {
  const prompt = String(message?.text || '').trim();
  if (!prompt) {
    return;
  }

  const chatId = String(message?.chat?.id || '').trim();
  if (!chatId) {
    return;
  }
  const threadId = message?.message_thread_id ? String(message.message_thread_id) : '';

  const config = loadConfig(projectRoot);
  const matchingChannels = listChannels(config).filter((entry) => {
    if ((entry.platform || 'discord') !== 'telegram') {
      return false;
    }
    if (String(entry.telegramChatId || '').trim() !== chatId) {
      return false;
    }
    if (String(entry.telegramThreadId || '').trim()) {
      return String(entry.telegramThreadId).trim() === threadId;
    }
    return true;
  });
  const channel =
    matchingChannels.find((entry) => entry.connector === inboundAgentName) ||
    matchingChannels.find(
      (entry) => !entry.connector && resolveChannelInboundAgentName(entry) === inboundAgentName,
    );
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
      await flushTelegramOutboxForRun(
        projectRoot,
        clients,
        channel,
        runId,
        chatId,
        { agentName: workerAgentName, fallbackThreadId: threadId },
      );
    }
    throw error;
  }

  if (runId) {
    await flushTelegramOutboxForRun(
      projectRoot,
      clients,
      channel,
      runId,
      chatId,
      { agentName: workerAgentName, fallbackThreadId: threadId },
    );
  }
}

async function processTelegramServiceCommands({
  projectRoot,
  agentName,
  clients,
  agentConfigs,
  serviceStatus,
  persistServiceStatus,
}) {
  const commands = listTelegramServiceCommands(projectRoot, {
    agentName,
  });
  if (commands.length === 0) {
    return agentConfigs;
  }

  let nextAgentConfigs = agentConfigs;
  for (const command of commands) {
    try {
      if (
        command.action === 'reload-config' ||
        command.action === 'reconnect-agent' ||
        command.action === 'reconnect-bot'
      ) {
        nextAgentConfigs = await reloadTelegramServiceConfig({
          projectRoot,
          agentName,
          clients,
          agentConfigs: nextAgentConfigs,
          command,
          serviceStatus,
          persistServiceStatus,
        });
      }
    } finally {
      deleteTelegramServiceCommand(command);
    }
  }

  return nextAgentConfigs;
}

async function reloadTelegramServiceConfig({
  projectRoot,
  agentName,
  clients,
  agentConfigs,
  command,
  serviceStatus,
  persistServiceStatus,
}) {
  const config = loadConfig(projectRoot);
  const nextAgentConfigs = resolveTelegramAgentConfigs(config, { agentName });
  const targetAgentName = String(command?.agentName || command?.botName || '').trim();
  const nextAgentConfig = nextAgentConfigs[targetAgentName];

  if (nextAgentConfig?.token) {
    clients[targetAgentName] = await createTelegramClient(nextAgentConfig.token, nextAgentConfig.agent);
  } else {
    delete clients[targetAgentName];
  }

  serviceStatus.agents = buildTelegramAgentStatus(nextAgentConfigs);
  hydrateTelegramAgentStatus(serviceStatus.agents, nextAgentConfigs, clients);
  serviceStatus.lastError = null;
  serviceStatus.heartbeatAt = timestamp();
  persistServiceStatus(serviceStatus);
  return nextAgentConfigs;
}

async function sendTelegramText(client, chatId, text, { threadId = null } = {}) {
  assert(client?.token, 'Telegram client is not available for this role.');
  assert(chatId, 'Telegram chat id is required.');
  for (const chunk of splitTelegramMessage(text)) {
    const payload = {
      chat_id: chatId,
      text: chunk,
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    };
    if (typeof client.__send === 'function') {
      await client.__send('sendMessage', payload);
    } else {
      await callTelegramApi(client.token, 'sendMessage', payload);
    }
  }
}

function formatTelegramErrorMessage(error) {
  const raw = toErrorMessage(error);
  if (/timeout|timed?\s*out/iu.test(raw)) {
    return '에이전트 응답 시간이 초과되었습니다. 다시 시도해 주세요.';
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed/iu.test(raw)) {
    return 'AI 서비스에 연결할 수 없습니다. 서비스 상태를 확인해 주세요.';
  }
  if (/auth|unauthorized|forbidden|login/iu.test(raw)) {
    return 'AI 인증에 실패했습니다. 웹 어드민에서 로그인 상태를 확인해 주세요.';
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

function splitTelegramMessage(text) {
  const input = String(text || '').trim();
  if (!input) {
    return ['(빈 응답)'];
  }

  const chunks = [];
  let remaining = input;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let splitIndex = remaining.lastIndexOf('\n', TELEGRAM_MESSAGE_LIMIT);
    if (splitIndex < Math.floor(TELEGRAM_MESSAGE_LIMIT / 2)) {
      splitIndex = remaining.lastIndexOf(' ', TELEGRAM_MESSAGE_LIMIT);
    }
    if (splitIndex < Math.floor(TELEGRAM_MESSAGE_LIMIT / 2)) {
      splitIndex = TELEGRAM_MESSAGE_LIMIT;
    }
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
}

export function formatTelegramRoleMessage(channel, entry) {
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

export async function flushTelegramOutboxForRun(
  projectRoot,
  clients,
  channel,
  runId,
  fallbackChatId = null,
  { agentName = null, botName = null, fallbackThreadId = null } = {},
) {
  const selectedAgentName = agentName || botName;
  const events = await listPendingRuntimeOutboxEvents(projectRoot, { runId, limit: 100 });
  for (const event of events) {
    try {
      const targetAgentName = resolveEventAgentName(channel, event.role);
      if (selectedAgentName && targetAgentName !== selectedAgentName && channel?.connector !== selectedAgentName) {
        continue;
      }
      const client = (channel?.connector ? clients[channel.connector] : null) || clients[targetAgentName];
      assert(client, `${targetAgentName || event.role} telegram client is not configured.`);
      const chatId = channel?.telegramChatId || fallbackChatId;
      assert(chatId, `Telegram chat id is missing for run ${runId}.`);
      const threadId = channel?.telegramThreadId || fallbackThreadId || null;
      await sendTelegramText(client, String(chatId), formatTelegramRoleMessage(channel, event), {
        threadId: threadId ? String(threadId) : null,
      });
      await markRuntimeOutboxEventDispatched(projectRoot, event.eventId);
    } catch (error) {
      console.error(`Telegram outbox delivery error for event ${event.eventId}: ${toErrorMessage(error)}`);
    }
  }
}

export async function flushPendingTelegramOutbox(
  projectRoot,
  clients,
  { limit = 100, agentName = null, botName = null } = {},
) {
  const selectedAgentName = agentName || botName;
  const events = await listPendingRuntimeOutboxEvents(projectRoot, { limit });
  if (events.length === 0) {
    return 0;
  }

  const config = loadConfig(projectRoot);
  const channelsByName = new Map(listChannels(config).map((channel) => [channel.name, channel]));
  let flushed = 0;

  for (const event of events) {
    try {
      const channel = channelsByName.get(event.channelName);
      if (!channel || (channel.platform || 'discord') !== 'telegram') {
        continue;
      }
      const targetAgentName = resolveEventAgentName(channel, event.role);
      if (selectedAgentName && targetAgentName !== selectedAgentName && channel?.connector !== selectedAgentName) {
        continue;
      }
      const client = (channel?.connector ? clients[channel.connector] : null) || clients[targetAgentName];
      assert(client, `${targetAgentName || event.role} telegram client is not configured.`);
      const chatId = String(channel.telegramChatId || '').trim();
      assert(chatId, `Telegram chat id is missing for queued event ${event.eventId}.`);
      const threadId = String(channel.telegramThreadId || '').trim() || null;
      await sendTelegramText(client, chatId, formatTelegramRoleMessage(channel, event), {
        threadId,
      });
      await markRuntimeOutboxEventDispatched(projectRoot, event.eventId);
      flushed += 1;
    } catch (error) {
      console.error(`Telegram pending outbox delivery error for event ${event.eventId}: ${toErrorMessage(error)}`);
    }
  }

  return flushed;
}

function enqueueChannelTask(queueMap, key, task) {
  const previous = queueMap.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (queueMap.get(key) === next) {
        queueMap.delete(key);
      }
    });
  queueMap.set(key, next);
  return next;
}

function buildTelegramQueueKey(message) {
  const chatId = String(message?.chat?.id || '').trim();
  const threadId = message?.message_thread_id ? String(message.message_thread_id) : '';
  return `${chatId}:${threadId}`;
}

function printTelegramStartup(projectRoot, clients) {
  console.log(`Telegram service ready for ${projectRoot}`);
  for (const [botName, client] of Object.entries(clients)) {
    const username = client?.me?.username ? `@${client.me.username}` : '(unknown)';
    console.log(`${botName}: ${username}`);
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

function resolveTelegramAgentConfigs(config, { agentName = null } = {}) {
  if (agentName) {
    const connector = config?.connectors?.[agentName];
    if (connector) {
      assert(connector.type === 'telegram', `Connector "${agentName}" is not configured for Telegram.`);
      const token = String(connector?.telegramBotToken || '').trim();
      assert(token, `Connector "${agentName}" does not configure a Telegram bot token.`);
      return {
        [agentName]: {
          name: agentName,
          agent: '',
          token,
        },
      };
    }
    const agent = config?.agents?.[agentName];
    assert(agent, `Agent or connector "${agentName}" does not exist.`);
    const token = String(agent?.telegramBotToken || '').trim();
    assert(token, `Agent "${agentName}" does not configure a Telegram bot token.`);
    return {
      [agentName]: {
        name: agentName,
        agent: agent.agent,
        token,
      },
    };
  }

  const configuredConnectors = config?.connectors || {};
  const configuredConnectorEntries = Object.entries(configuredConnectors).filter(
    ([, connector]) => connector?.type === 'telegram' && String(connector?.telegramBotToken || '').trim(),
  );
  const configuredAgents = config?.agents || {};
  const configuredAgentEntries = Object.entries(configuredAgents).filter(([name, agent]) =>
    String(agent?.telegramBotToken || '').trim() && !configuredConnectors[name],
  );
  return {
    ...Object.fromEntries(
      configuredConnectorEntries.map(([name, connector]) => [
        name,
        {
          name,
          agent: '',
          token: String(connector.telegramBotToken || '').trim(),
        },
      ]),
    ),
    ...Object.fromEntries(
      configuredAgentEntries.map(([name, agent]) => [
        name,
        {
          name,
          agent: agent.agent,
          token: String(agent.telegramBotToken || '').trim(),
        },
      ]),
    ),
  };
}

function buildTelegramAgentStatus(agentConfigs) {
  return Object.fromEntries(
    Object.entries(agentConfigs).map(([agentName, agentConfig]) => [
      agentName,
      {
        agent: agentConfig.agent || '',
        tokenConfigured: Boolean(agentConfig.token),
        connected: false,
        username: '',
        userId: '',
      },
    ]),
  );
}

function hydrateTelegramAgentStatus(agents, agentConfigs, clients) {
  for (const [agentName, agentConfig] of Object.entries(agentConfigs)) {
    const client = clients[agentName];
    agents[agentName] = {
      agent: agentConfig.agent || '',
      tokenConfigured: Boolean(agentConfig.token),
      connected: Boolean(client?.me?.id),
      username: client?.me?.username || '',
      userId: client?.me?.id || '',
    };
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

async function callTelegramApi(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });
  const data = await response.json().catch(() => null);
  assert(response.ok, data?.description || `Telegram API ${method} failed with status ${response.status}.`);
  assert(data?.ok, data?.description || `Telegram API ${method} returned a failure response.`);
  return data.result;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
