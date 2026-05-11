import fs from 'node:fs';

import { executeChannelTurn, isTribunalChannel } from './channel-runtime.js';
import {
  createDiscordServiceStatus,
  deleteDiscordServiceCommand,
  listDiscordServiceCommands,
  writeDiscordAgentServiceStatus,
  resolveChannelRoleAgentNames,
  writeDiscordServiceStatus,
} from './discord-runtime-state.js';
import {
  listPendingRuntimeOutboxEvents,
  markRuntimeOutboxEventDispatched,
} from './runtime-db.js';
import { listChannels, loadConfig, resolveProjectPath } from './store.js';
import { assert, timestamp, toErrorMessage } from './utils.js';

const DISCORD_MESSAGE_LIMIT = 1900;
const DISCORD_OUTBOX_FLUSH_INTERVAL_MS = 1_000;
const DISCORD_COMMAND_POLL_INTERVAL_MS = 1_000;
const DISCORD_TYPING_REFRESH_MS = 8_000;
const DISCORD_STREAM_FLUSH_INTERVAL_MS = 2_000;
const DISCORD_STREAM_THINKING_FLUSH_CHARS = 800;
const DISCORD_INTERMEDIATE_MESSAGE_LIMIT = 1_200;

export async function serveDiscord(projectRoot, { agentName = null } = {}) {
  const config = loadConfig(projectRoot);
  let agentConfigs = resolveDiscordAgentConfigs(config, { agentName });
  const persistServiceStatus = (value) =>
    agentName
      ? writeDiscordAgentServiceStatus(projectRoot, agentName, value)
      : writeDiscordServiceStatus(projectRoot, value);
  const serviceStatus = createDiscordServiceStatus(projectRoot, {
    agentName,
    running: false,
    desiredRunning: true,
    heartbeatAt: timestamp(),
    agents: buildDiscordAgentStatus(agentConfigs),
  });
  persistServiceStatus(serviceStatus);

  let heartbeatTimer = null;
  let outboxTimer = null;
  let commandTimer = null;
  let clients = {};
  let outboxFlushTask = Promise.resolve();
  let commandTask = Promise.resolve();

  try {
    const Discord = await import('discord.js');
    clients = await createDiscordClients(agentConfigs, Discord);
    hydrateDiscordAgentStatus(serviceStatus.agents, agentConfigs, clients);
    serviceStatus.running = true;
    serviceStatus.startedAt = serviceStatus.startedAt || timestamp();
    serviceStatus.stoppedAt = null;
    serviceStatus.lastError = null;
    serviceStatus.heartbeatAt = timestamp();
    persistServiceStatus(serviceStatus);

    const enqueueOutboxFlush = (task) => {
      const next = outboxFlushTask
        .catch(() => {})
        .then(task);
      outboxFlushTask = next.catch(() => {});
      return next;
    };

    const enqueueCommandProcessing = (task) => {
      const next = commandTask
        .catch(() => {})
        .then(task);
      commandTask = next.catch(() => {});
      return next;
    };

    heartbeatTimer = setInterval(() => {
      serviceStatus.heartbeatAt = timestamp();
      persistServiceStatus(serviceStatus);
    }, 10_000);
    heartbeatTimer.unref?.();

    await enqueueOutboxFlush(() =>
      flushPendingDiscordOutbox(projectRoot, clients, {
        agentName,
      }),
    );
    outboxTimer = setInterval(() => {
      void enqueueOutboxFlush(() =>
        flushPendingDiscordOutbox(projectRoot, clients, {
          agentName,
        }),
      ).catch((error) => {
        console.error(`Discord outbox flush error: ${toErrorMessage(error)}`);
      });
    }, DISCORD_OUTBOX_FLUSH_INTERVAL_MS);
    outboxTimer.unref?.();

    const channelQueues = new Map();
    for (const [botName, client] of Object.entries(clients)) {
      attachDiscordClientMessageHandler({
        projectRoot,
        clients,
        botName,
        client,
        channelQueues,
        enqueueOutboxFlush,
        workerAgentName: agentName,
      });
    }

    commandTimer = setInterval(() => {
      void enqueueCommandProcessing(() =>
        processDiscordServiceCommands({
          projectRoot,
          Discord,
          agentName,
          clients,
          agentConfigs,
          serviceStatus,
          persistServiceStatus,
          channelQueues,
          enqueueOutboxFlush,
        }),
      )
        .then((nextAgentConfigs) => {
          agentConfigs = nextAgentConfigs;
        })
        .catch((error) => {
          serviceStatus.lastError = `Command processing failed: ${toErrorMessage(error)}`;
          serviceStatus.heartbeatAt = timestamp();
          persistServiceStatus(serviceStatus);
          console.error(`Discord command error: ${toErrorMessage(error)}`);
        });
    }, DISCORD_COMMAND_POLL_INTERVAL_MS);
    commandTimer.unref?.();

    printDiscordStartup(projectRoot, clients);
    await waitForShutdown(async () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (outboxTimer) {
        clearInterval(outboxTimer);
      }
      if (commandTimer) {
        clearInterval(commandTimer);
      }
      for (const client of Object.values(clients)) {
        client.destroy();
      }
      serviceStatus.running = false;
      serviceStatus.stoppedAt = timestamp();
      serviceStatus.heartbeatAt = timestamp();
      persistServiceStatus(serviceStatus);
    });
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

async function createDiscordClients(agentConfigs, Discord) {
  const clients = {};
  for (const [agentName, agentConfig] of Object.entries(agentConfigs)) {
    if (!agentConfig?.token) {
      continue;
    }
    clients[agentName] = await createDiscordClient(agentConfig.token, Discord);
  }
  return clients;
}

async function createDiscordClient(token, Discord) {
  const clientOptions = {
    intents: [
      Discord.GatewayIntentBits.Guilds,
      Discord.GatewayIntentBits.GuildMessages,
      Discord.GatewayIntentBits.DirectMessages,
      Discord.GatewayIntentBits.MessageContent,
    ],
  };
  if (Discord.Partials?.Channel) {
    clientOptions.partials = [Discord.Partials.Channel];
  }
  const client = new Discord.Client(clientOptions);

  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.login(token).catch((error) => {
      reject(normalizeDiscordClientError(error));
    });
  });

  return client;
}

function normalizeDiscordClientError(error) {
  const raw = toErrorMessage(error);
  if (error?.code === 4014 || /Used disallowed intents/iu.test(raw)) {
    return new Error(
      'Discord 봇 설정에서 Message Content Intent 가 꺼져 있습니다. Discord Developer Portal > Bot > Privileged Gateway Intents 에서 Message Content Intent 를 켜세요.',
    );
  }
  return error instanceof Error ? error : new Error(raw);
}

async function handleInboundMessage({
  projectRoot,
  clients,
  inboundAgentName,
  workerAgentName,
  message,
  enqueueOutboxFlush,
}) {
  if (message.author.bot) {
    return;
  }

  const prompt = String(message.content || '').trim();
  if (!prompt) {
    return;
  }

  const config = loadConfig(projectRoot);
  const inGuild = Boolean(message.inGuild?.());
  const matchingChannels = listChannels(config).filter((entry) => {
    if ((entry.platform || 'discord') !== 'discord') {
      return false;
    }
    if (inGuild) {
      return entry.targetType !== 'direct' && entry.discordChannelId === message.channelId;
    }
    return entry.targetType === 'direct' && entry.discordUserId === message.author.id;
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

  const typingInterval = startTypingIndicator(message.channel);
  const intermediatePublisher = isTribunalChannel(channel)
    ? null
    : createDiscordIntermediatePublisher(message.channel);
  let runId = null;
  try {
    const result = await executeChannelTurn({
      projectRoot,
      config,
      channel,
      prompt,
      workdir,
      onStreamEvent:
        intermediatePublisher
          ? async (event) => {
              await intermediatePublisher.push(event);
            }
          : null,
    });
    runId = result.runId || null;
  } catch (error) {
    runId = error?.runtimeRunId || null;
    if (runId) {
      await enqueueOutboxFlush(() =>
        flushDiscordOutboxForRun(projectRoot, clients, channel, runId, message.channelId, {
          fallbackUserId: message.author.id,
        }),
      );
    }
    throw error;
  } finally {
    if (intermediatePublisher) {
      await intermediatePublisher.finish();
    }
    stopTypingIndicator(typingInterval);
  }

  if (runId) {
    await enqueueOutboxFlush(() =>
      flushDiscordOutboxForRun(projectRoot, clients, channel, runId, message.channelId, {
        agentName: workerAgentName,
        fallbackUserId: message.author.id,
      }),
    );
  }
}

function attachDiscordClientMessageHandler({
  projectRoot,
  clients,
  botName,
  workerAgentName,
  client,
  channelQueues,
  enqueueOutboxFlush,
}) {
  client.on('messageCreate', (message) => {
    void enqueueChannelTask(channelQueues, message.channelId, async () => {
      await handleInboundMessage({
        projectRoot,
        clients,
        inboundAgentName: botName,
        workerAgentName,
        message,
        enqueueOutboxFlush,
      });
    }).catch(async (error) => {
      console.error(`Discord handler error: ${toErrorMessage(error)}`);
      const userMessage = formatDiscordErrorMessage(error);
      await sendDiscordText(client, message.channelId, userMessage);
    });
  });
}

async function processDiscordServiceCommands({
  projectRoot,
  Discord,
  agentName,
  clients,
  agentConfigs,
  serviceStatus,
  persistServiceStatus,
  channelQueues,
  enqueueOutboxFlush,
}) {
  const commands = listDiscordServiceCommands(projectRoot, {
    agentName,
  });
  if (commands.length === 0) {
    return agentConfigs;
  }

  let nextAgentConfigs = agentConfigs;
  for (const command of commands) {
    try {
      if (command.action === 'reload-config') {
        nextAgentConfigs = await reloadDiscordServiceConfig({
          projectRoot,
          Discord,
          agentName,
          clients,
          agentConfigs: nextAgentConfigs,
          serviceStatus,
          persistServiceStatus,
          channelQueues,
          enqueueOutboxFlush,
        });
      } else if (
        command.action === 'reconnect-agent' ||
        command.action === 'reconnect-bot'
      ) {
        nextAgentConfigs = await reconnectDiscordAgent({
          projectRoot,
          Discord,
          agentName,
          clients,
          agentConfigs: nextAgentConfigs,
          targetAgentName: command.agentName || command.botName,
          serviceStatus,
          persistServiceStatus,
          channelQueues,
          enqueueOutboxFlush,
        });
      }
    } finally {
      deleteDiscordServiceCommand(command);
    }
  }
  return nextAgentConfigs;
}

async function reloadDiscordServiceConfig({
  projectRoot,
  Discord,
  agentName,
  clients,
  agentConfigs,
  serviceStatus,
  persistServiceStatus,
  channelQueues,
  enqueueOutboxFlush,
}) {
  const config = loadConfig(projectRoot);
  const nextAgentConfigs = resolveDiscordAgentConfigs(config, { agentName });
  if (buildDiscordAgentConfigSignature(nextAgentConfigs) === buildDiscordAgentConfigSignature(agentConfigs)) {
    return agentConfigs;
  }

  const nextClients = {};
  for (const [nextAgentName, agentConfig] of Object.entries(nextAgentConfigs)) {
    const previous = agentConfigs[nextAgentName];
    if (clients[nextAgentName] && previous && previous.token === agentConfig.token) {
      nextClients[nextAgentName] = clients[nextAgentName];
      continue;
    }
    if (!agentConfig.token) {
      continue;
    }
    const client = await createDiscordClient(agentConfig.token, Discord);
    attachDiscordClientMessageHandler({
      projectRoot,
      clients,
      botName: nextAgentName,
      client,
      channelQueues,
      enqueueOutboxFlush,
      workerAgentName: agentName,
    });
    nextClients[nextAgentName] = client;
  }

  for (const [existingAgentName, client] of Object.entries(clients)) {
    if (nextClients[existingAgentName] === client) {
      continue;
    }
    client.destroy();
  }

  for (const existingAgentName of Object.keys(clients)) {
    delete clients[existingAgentName];
  }
  Object.assign(clients, nextClients);

  serviceStatus.agents = buildDiscordAgentStatus(nextAgentConfigs);
  hydrateDiscordAgentStatus(serviceStatus.agents, nextAgentConfigs, clients);
  serviceStatus.lastError = null;
  serviceStatus.heartbeatAt = timestamp();
  persistServiceStatus(serviceStatus);
  console.log('Discord service reloaded agent configuration.');
  return nextAgentConfigs;
}

async function reconnectDiscordAgent({
  projectRoot,
  Discord,
  agentName,
  clients,
  agentConfigs,
  targetAgentName,
  serviceStatus,
  persistServiceStatus,
  channelQueues,
  enqueueOutboxFlush,
}) {
  assert(targetAgentName, 'Agent name is required.');
  const config = loadConfig(projectRoot);
  const nextAgentConfigs = resolveDiscordAgentConfigs(config, { agentName });
  const nextAgentConfig = nextAgentConfigs[targetAgentName] || null;
  const existingClient = clients[targetAgentName] || null;
  let nextClient = null;

  if (nextAgentConfig?.token) {
    nextClient = await createDiscordClient(nextAgentConfig.token, Discord);
    attachDiscordClientMessageHandler({
      projectRoot,
      clients,
      botName: targetAgentName,
      client: nextClient,
      channelQueues,
      enqueueOutboxFlush,
      workerAgentName: agentName,
    });
  }

  if (existingClient && existingClient !== nextClient) {
    existingClient.destroy();
  }

  if (nextClient) {
    clients[targetAgentName] = nextClient;
  } else {
    delete clients[targetAgentName];
  }

  serviceStatus.agents = buildDiscordAgentStatus(nextAgentConfigs);
  hydrateDiscordAgentStatus(serviceStatus.agents, nextAgentConfigs, clients);
  serviceStatus.lastError = null;
  serviceStatus.heartbeatAt = timestamp();
  persistServiceStatus(serviceStatus);
  console.log(`Discord service reconnected agent "${targetAgentName}".`);
  return nextAgentConfigs;
}

async function sendDiscordText(client, target, text) {
  assert(client, 'Discord client is not available for this role.');
  const normalizedTarget =
    typeof target === 'string' ? { channelId: target } : target || {};
  if (normalizedTarget.userId) {
    const user = await resolveDiscordUserDmChannel(client, normalizedTarget.userId);
    for (const chunk of splitDiscordMessage(text)) {
      await user.send(chunk);
    }
    return;
  }
  const channel = await client.channels.fetch(normalizedTarget.channelId);
  assert(
    channel?.isTextBased?.(),
    `Discord channel "${normalizedTarget.channelId}" is not text-based.`,
  );
  for (const chunk of splitDiscordMessage(text)) {
    await channel.send(chunk);
  }
}

async function resolveDiscordUserDmChannel(client, userId) {
  assert(client?.users?.fetch, 'Discord client cannot fetch users for DM delivery.');
  const user = await client.users.fetch(userId);
  assert(user?.send, `Discord user "${userId}" cannot receive DMs.`);
  return user;
}

function formatDiscordErrorMessage(error) {
  const raw = toErrorMessage(error);
  if (/timeout|timed?\s*out/iu.test(raw)) {
    return '⏱ 에이전트 응답 시간이 초과되었습니다. 다시 시도해 주세요.';
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed/iu.test(raw)) {
    return '🔌 AI 서비스에 연결할 수 없습니다. 서비스 상태를 확인해 주세요.';
  }
  if (/auth|unauthorized|forbidden|login/iu.test(raw)) {
    return '🔑 AI 인증에 실패했습니다. 웹 어드민에서 로그인 상태를 확인해 주세요.';
  }
  if (/rate.?limit|too many requests|429/iu.test(raw)) {
    return '⚠️ API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
  }
  if (/workspace does not exist/iu.test(raw)) {
    return '📁 워크스페이스 경로를 찾을 수 없습니다. 채널 설정을 확인해 주세요.';
  }
  const truncated = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return `오류: ${truncated}`;
}

function startTypingIndicator(discordChannel) {
  try {
    discordChannel.sendTyping();
  } catch {}
  const interval = setInterval(() => {
    try {
      discordChannel.sendTyping();
    } catch {}
  }, DISCORD_TYPING_REFRESH_MS);
  interval.unref?.();
  return interval;
}

function stopTypingIndicator(interval) {
  if (interval) {
    clearInterval(interval);
  }
}

function splitDiscordMessage(text) {
  const input = String(text || '').trim();
  if (!input) {
    return ['(빈 응답)'];
  }

  const chunks = [];
  let remaining = input;
  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    let splitIndex = remaining.lastIndexOf('\n', DISCORD_MESSAGE_LIMIT);
    if (splitIndex < Math.floor(DISCORD_MESSAGE_LIMIT / 2)) {
      splitIndex = remaining.lastIndexOf(' ', DISCORD_MESSAGE_LIMIT);
    }
    if (splitIndex < Math.floor(DISCORD_MESSAGE_LIMIT / 2)) {
      splitIndex = DISCORD_MESSAGE_LIMIT;
    }
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
}

export function createDiscordIntermediatePublisher(discordChannel) {
  let thinkingBuffer = '';
  let activeTool = null;
  let lastThinkingFlushAt = 0;
  let statusMessage = null;

  const publishStatus = async (text) => {
    const content = truncateDiscordIntermediateText(text);
    if (statusMessage?.edit) {
      statusMessage = await statusMessage.edit(content);
      return;
    }
    statusMessage = await discordChannel.send(content);
  };

  const flushThinking = async ({ force = false } = {}) => {
    const trimmed = thinkingBuffer.trim();
    if (!trimmed) {
      thinkingBuffer = '';
      return;
    }
    const now = Date.now();
    if (
      !force &&
      trimmed.length < DISCORD_STREAM_THINKING_FLUSH_CHARS &&
      now - lastThinkingFlushAt < DISCORD_STREAM_FLUSH_INTERVAL_MS
    ) {
      return;
    }
    thinkingBuffer = '';
    lastThinkingFlushAt = now;
    await publishStatus(`처리 중\n${trimmed}`);
  };

  const flushTool = async () => {
    if (!activeTool) {
      return;
    }
    const lines = [`도구 실행 중: ${activeTool.name || 'unknown'}`];
    activeTool = null;
    await publishStatus(lines.join('\n'));
  };

  return {
    async push(event) {
      if (!event || !['claude-cli', 'codex-cli'].includes(event.source)) {
        return;
      }

      if (event.kind === 'thinking') {
        if (activeTool) {
          await flushTool();
        }
        thinkingBuffer += String(event.text || '');
        await flushThinking();
        return;
      }

      if (event.kind === 'tool') {
        await flushThinking({ force: true });
        if (event.phase === 'start') {
          if (activeTool) {
            await flushTool();
          }
          activeTool = {
            name: String(event.toolName || 'unknown').trim() || 'unknown',
            inputText: String(event.text || ''),
          };
          return;
        }
        if (event.phase === 'input') {
          if (!activeTool) {
            activeTool = {
              name: String(event.toolName || 'unknown').trim() || 'unknown',
              inputText: '',
            };
          }
          activeTool.inputText += String(event.text || '');
          return;
        }
        if (event.phase === 'stop') {
          if (!activeTool) {
            activeTool = {
              name: String(event.toolName || 'unknown').trim() || 'unknown',
              inputText: String(event.text || ''),
            };
          }
          await flushTool();
        }
      }
    },
    async finish() {
      await flushThinking({ force: true });
      await flushTool();
    },
  };
}

function truncateDiscordIntermediateText(text) {
  const input = String(text || '').trim() || '처리 중';
  if (input.length <= DISCORD_INTERMEDIATE_MESSAGE_LIMIT) {
    return input;
  }
  return `${input.slice(0, DISCORD_INTERMEDIATE_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

export function formatDiscordRoleMessage(channel, entry) {
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
    `**${title}${entry?.agent?.name ? ` · ${entry.agent.name}` : ''}**`,
    meta.join(' · '),
    '',
    content,
  ]
    .filter((line, index) => index === 2 || Boolean(line))
    .join('\n');
}


export async function flushDiscordOutboxForRun(
  projectRoot,
  clients,
  channel,
  runId,
  fallbackChannelId = null,
  { agentName = null, botName = null, fallbackUserId = null } = {},
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
      assert(client, `${targetAgentName || event.role} agent client is not configured.`);
      const target = resolveDiscordSendTarget(channel, {
        event,
        fallbackChannelId,
        fallbackUserId,
      });
      await sendDiscordText(client, target, formatDiscordRoleMessage(channel, event));
      await markRuntimeOutboxEventDispatched(projectRoot, event.eventId);
    } catch (error) {
      console.error(`Discord outbox delivery error for event ${event.eventId}: ${toErrorMessage(error)}`);
    }
  }
}

export async function flushPendingDiscordOutbox(
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
  const channels = listChannels(config);
  const channelsByName = new Map(channels.map((channel) => [channel.name, channel]));
  let flushed = 0;

  for (const event of events) {
    try {
      const channel =
        channelsByName.get(event.channelName) ||
        channels.find((entry) => entry.discordChannelId === event.discordChannelId) ||
        {
          name: event.channelName || 'unknown',
          mode: 'single',
          discordChannelId: event.discordChannelId,
        };
      const targetAgentName = resolveEventAgentName(channel, event.role);
      if (selectedAgentName && targetAgentName !== selectedAgentName && channel?.connector !== selectedAgentName) {
        continue;
      }
      const client = (channel?.connector ? clients[channel.connector] : null) || clients[targetAgentName];
      assert(client, `${targetAgentName || event.role} agent client is not configured.`);
      const target = resolveDiscordSendTarget(channel, { event });
      await sendDiscordText(client, target, formatDiscordRoleMessage(channel, event));
      await markRuntimeOutboxEventDispatched(projectRoot, event.eventId);
      flushed += 1;
    } catch (error) {
      console.error(`Discord pending outbox delivery error for event ${event.eventId}: ${toErrorMessage(error)}`);
    }
  }

  return flushed;
}

function resolveDiscordSendTarget(channel, { event = null, fallbackChannelId = null, fallbackUserId = null } = {}) {
  const userId = channel?.targetType === 'direct'
    ? String(channel.discordUserId || fallbackUserId || '').trim()
    : '';
  if (userId) {
    return { userId };
  }
  const channelId = String(event?.discordChannelId || channel?.discordChannelId || fallbackChannelId || '').trim();
  assert(channelId, `Discord channel id is missing for queued event ${event?.eventId || 'unknown'}.`);
  return { channelId };
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

function printDiscordStartup(projectRoot, clients) {
  console.log(`Discord service ready for ${projectRoot}`);
  for (const [botName, client] of Object.entries(clients)) {
    if (!client?.user) {
      continue;
    }
    console.log(`${botName}: ${client.user.tag}`);
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

function resolveDiscordAgentConfigs(
  config,
  { agentName = null } = {},
) {
  if (agentName) {
    const connector = config?.connectors?.[agentName];
    if (connector) {
      assert(connector.type === 'discord', `Connector "${agentName}" is not configured for Discord.`);
      const token = String(connector?.discordToken || '').trim();
      assert(token, `Connector "${agentName}" does not configure a Discord token.`);
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
    const token = String(agent?.discordToken || '').trim();
    assert(token, `Agent "${agentName}" does not configure a Discord token.`);
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
    ([, connector]) => connector?.type === 'discord' && String(connector?.discordToken || '').trim(),
  );
  const configuredAgents = config?.agents || {};
  const configuredAgentEntries = Object.entries(configuredAgents).filter(([name, agent]) =>
    String(agent?.discordToken || '').trim() && !configuredConnectors[name],
  );
  if (configuredConnectorEntries.length > 0 || configuredAgentEntries.length > 0) {
    return {
      ...Object.fromEntries(
        configuredConnectorEntries.map(([name, connector]) => [
          name,
          {
            name,
            agent: '',
            token: String(connector.discordToken || '').trim(),
          },
        ]),
      ),
      ...Object.fromEntries(
        configuredAgentEntries.map(([name, agent]) => [
          name,
          {
            name,
            agent: agent.agent,
            token: String(agent.discordToken || '').trim(),
          },
        ]),
      ),
    };
  }

  assert(false, 'At least one Discord-enabled agent is required.');
}

function buildDiscordAgentConfigSignature(agentConfigs) {
  return JSON.stringify(
    Object.entries(agentConfigs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, agentConfig]) => ({
        name,
        agent: agentConfig?.agent || '',
        token: agentConfig?.token || '',
      })),
  );
}

function buildDiscordAgentStatus(agentConfigs) {
  return Object.fromEntries(
    Object.entries(agentConfigs).map(([agentName, agentConfig]) => [
      agentName,
      {
        agent: agentConfig.agent || '',
        tokenConfigured: Boolean(agentConfig.token),
        connected: false,
        tag: '',
        userId: '',
      },
    ]),
  );
}

function hydrateDiscordAgentStatus(agents, agentConfigs, clients) {
  for (const [agentName, agentConfig] of Object.entries(agentConfigs)) {
    const client = clients[agentName];
    agents[agentName] = {
      agent: agentConfig.agent || '',
      tokenConfigured: Boolean(agentConfig.token),
      connected: Boolean(client?.user),
      tag: client?.user?.tag || '',
      userId: client?.user?.id || '',
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
