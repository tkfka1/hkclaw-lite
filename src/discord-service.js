import fs from 'node:fs';

import { executeChannelTurn, isTribunalChannel } from './channel-runtime.js';
import {
  createDiscordServiceStatus,
  deleteDiscordServiceCommand,
  DISCORD_ROLE_NAMES,
  listDiscordServiceCommands,
  loadProjectEnvFile,
  writeDiscordAgentServiceStatus,
  resolveChannelRoleAgentNames,
  resolveDiscordRoleTokens,
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
const DISCORD_PROGRESS_UPDATE_INTERVAL_MS = 5_000;

export async function serveDiscord(projectRoot, { envFile = null, agentName = null } = {}) {
  const { envFilePath } = loadProjectEnvFile(projectRoot, envFile);
  const config = loadConfig(projectRoot);
  const needsTribunalBots = listChannels(config).some((channel) => isTribunalChannel(channel));
  let agentConfigs = resolveDiscordAgentConfigs(config, process.env, {
    requireReviewerAndArbiter: needsTribunalBots,
    agentName,
  });
  const persistServiceStatus = (value) =>
    agentName
      ? writeDiscordAgentServiceStatus(projectRoot, agentName, value)
      : writeDiscordServiceStatus(projectRoot, value);
  const serviceStatus = createDiscordServiceStatus(projectRoot, {
    agentName,
    running: false,
    envFilePath,
    heartbeatAt: timestamp(),
    agents: buildDiscordAgentStatus(agentConfigs),
  });
  persistServiceStatus(serviceStatus);

  let heartbeatTimer = null;
  let outboxTimer = null;
  let commandTimer = null;
  let clients = {};
  let outboxFlushTask = Promise.resolve();

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
      void processDiscordServiceCommands({
        projectRoot,
        Discord,
        env: process.env,
        agentName,
        clients,
        agentConfigs,
        serviceStatus,
        persistServiceStatus,
        channelQueues,
        enqueueOutboxFlush,
      })
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
  const client = new Discord.Client({
    intents: [
      Discord.GatewayIntentBits.Guilds,
      Discord.GatewayIntentBits.GuildMessages,
      Discord.GatewayIntentBits.MessageContent,
    ],
  });

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
  if (!message.inGuild() || message.author.bot) {
    return;
  }

  const prompt = String(message.content || '').trim();
  if (!prompt) {
    return;
  }

  const config = loadConfig(projectRoot);
  const channel = listChannels(config).find(
    (entry) => entry.discordChannelId === message.channelId,
  );
  if (!channel) {
    return;
  }
  if (resolveChannelInboundAgentName(channel) !== inboundAgentName) {
    return;
  }

  const workspace = channel.workspace || channel.workdir;
  assert(workspace, `Channel "${channel.name}" does not define a workspace.`);
  const workdir = resolveProjectPath(projectRoot, workspace);
  assert(fs.existsSync(workdir), `Workspace does not exist: ${workdir}`);

  const typingInterval = startTypingIndicator(message.channel);
  const progressTracker = createDiscordProgressTracker(message, channel);
  let runId = null;
  try {
    await progressTracker.start();
    const result = await executeChannelTurn({
      projectRoot,
      config,
      channel,
      prompt,
      workdir,
      onTransition: async (entry) => {
        await progressTracker.transition(entry);
      },
    });
    runId = result.runId || null;
    await progressTracker.complete(result);
  } catch (error) {
    runId = error?.runtimeRunId || null;
    await progressTracker.fail(error);
    if (runId) {
      await enqueueOutboxFlush(() =>
        flushDiscordOutboxForRun(projectRoot, clients, channel, runId, message.channelId),
      );
    }
    throw error;
  } finally {
    progressTracker.dispose();
    stopTypingIndicator(typingInterval);
  }

  if (runId) {
    await enqueueOutboxFlush(() =>
      flushDiscordOutboxForRun(projectRoot, clients, channel, runId, message.channelId, {
        agentName: workerAgentName,
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
  env,
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
          env,
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
          env,
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
  env,
  agentName,
  clients,
  agentConfigs,
  serviceStatus,
  persistServiceStatus,
  channelQueues,
  enqueueOutboxFlush,
}) {
  const config = loadConfig(projectRoot);
  const needsTribunalBots = listChannels(config).some((channel) => isTribunalChannel(channel));
  const nextAgentConfigs = resolveDiscordAgentConfigs(config, env, {
    requireReviewerAndArbiter: needsTribunalBots,
    agentName,
  });
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
  env,
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
  const needsTribunalBots = listChannels(config).some((channel) => isTribunalChannel(channel));
  const nextAgentConfigs = resolveDiscordAgentConfigs(config, env, {
    requireReviewerAndArbiter: needsTribunalBots,
    agentName,
  });
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

async function sendDiscordText(client, channelId, text) {
  assert(client, 'Discord client is not available for this role.');
  const channel = await client.channels.fetch(channelId);
  assert(channel?.isTextBased?.(), `Discord channel "${channelId}" is not text-based.`);
  for (const chunk of splitDiscordMessage(text)) {
    await channel.send(chunk);
  }
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

export function formatDiscordProgressMessage(channel, progress, { now = Date.now() } = {}) {
  const meta = [];
  if (channel?.name) {
    meta.push(channel.name);
  }
  if (isTribunalChannel(channel) && progress?.currentRound && progress?.maxRounds) {
    meta.push(`${progress.currentRound}/${progress.maxRounds}`);
  }
  if (progress?.reviewerVerdict) {
    meta.push(localizeReviewerVerdict(progress.reviewerVerdict));
  }
  meta.push(`${formatDiscordElapsedDuration(progress?.startedAt, now)} 경과`);

  return [`⏱ **${resolveDiscordProgressTitle(channel, progress)}**`, meta.join(' · ')]
    .filter(Boolean)
    .join('\n');
}

export function formatDiscordProgressFinalMessage(channel, progress, { now = Date.now() } = {}) {
  const completedAt = progress?.completedAt || now;
  const status = progress?.status === 'failed' ? 'failed' : 'completed';
  const meta = [];
  if (channel?.name) {
    meta.push(channel.name);
  }
  if (isTribunalChannel(channel) && progress?.currentRound && progress?.maxRounds) {
    meta.push(`${progress.currentRound}/${progress.maxRounds}`);
  }
  if (progress?.reviewerVerdict) {
    meta.push(localizeReviewerVerdict(progress.reviewerVerdict));
  }
  meta.push(`${formatDiscordElapsedDuration(progress?.startedAt, completedAt)} 소요`);

  return [
    `${status === 'failed' ? '❌' : '✅'} **${resolveDiscordProgressFinalTitle(channel, progress)}**`,
    meta.join(' · '),
    status === 'failed' && progress?.error ? '' : null,
    status === 'failed' && progress?.error ? String(progress.error).trim() : null,
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
  { agentName = null, botName = null } = {},
) {
  const selectedAgentName = agentName || botName;
  const events = await listPendingRuntimeOutboxEvents(projectRoot, { runId, limit: 100 });
  for (const event of events) {
    const targetAgentName = resolveEventAgentName(channel, event.role);
    if (selectedAgentName && targetAgentName !== selectedAgentName) {
      continue;
    }
    const client = clients[targetAgentName];
    assert(client, `${targetAgentName || event.role} agent client is not configured.`);
    const channelId = event.discordChannelId || fallbackChannelId;
    assert(channelId, `Discord channel id is missing for run ${runId}.`);
    await sendDiscordText(client, channelId, formatDiscordRoleMessage(channel, event));
    await markRuntimeOutboxEventDispatched(projectRoot, event.eventId);
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
    const channel =
      channelsByName.get(event.channelName) ||
      channels.find((entry) => entry.discordChannelId === event.discordChannelId) ||
      {
        name: event.channelName || 'unknown',
        mode: 'single',
        discordChannelId: event.discordChannelId,
      };
    const targetAgentName = resolveEventAgentName(channel, event.role);
    if (selectedAgentName && targetAgentName !== selectedAgentName) {
      continue;
    }
    const client = clients[targetAgentName];
    assert(client, `${targetAgentName || event.role} agent client is not configured.`);
    const channelId = event.discordChannelId || channel.discordChannelId;
    assert(channelId, `Discord channel id is missing for queued event ${event.eventId}.`);
    await sendDiscordText(client, channelId, formatDiscordRoleMessage(channel, event));
    await markRuntimeOutboxEventDispatched(projectRoot, event.eventId);
    flushed += 1;
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
  env,
  { requireReviewerAndArbiter = false, agentName = null } = {},
) {
  if (agentName) {
    const agent = config?.agents?.[agentName];
    assert(agent, `Agent "${agentName}" does not exist.`);
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

  const configuredAgents = config?.agents || {};
  const configuredAgentEntries = Object.entries(configuredAgents).filter(([, agent]) =>
    String(agent?.discordToken || '').trim(),
  );
  if (configuredAgentEntries.length > 0) {
    return Object.fromEntries(
      configuredAgentEntries.map(([name, agent]) => [
        name,
        {
          name,
          agent: agent.agent,
          token: String(agent.discordToken || '').trim(),
        },
      ]),
    );
  }

  const roleTokens = resolveDiscordRoleTokens(env, {
    requireReviewerAndArbiter,
  });
  return Object.fromEntries(
    DISCORD_ROLE_NAMES.filter((role) => roleTokens[role]).map((role) => [
      role,
      {
        name: role,
        agent: role,
        token: roleTokens[role],
      },
    ]),
  );
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

function createDiscordProgressTracker(message, channel) {
  const initialState = {
    status: 'queued',
    activeRole: 'owner',
    currentRound: 1,
    maxRounds: channel?.mode === 'tribunal' ? channel?.reviewRounds || 2 : 1,
    reviewerVerdict: null,
    startedAt: Date.now(),
    completedAt: null,
    error: '',
  };
  let currentState = initialState;
  let progressMessage = null;
  let interval = null;
  let queue = Promise.resolve();
  let disposed = false;
  let lastRenderedText = '';

  const enqueue = (task) => {
    queue = queue
      .catch(() => {})
      .then(task)
      .catch((error) => {
        console.error(`Discord progress update error: ${toErrorMessage(error)}`);
      });
    return queue;
  };

  const renderProgress = async (force = false) => {
    if (disposed || typeof message?.channel?.send !== 'function') {
      return;
    }
    const nextText = formatDiscordProgressMessage(channel, currentState);
    if (!force && nextText === lastRenderedText) {
      return;
    }
    if (!progressMessage) {
      progressMessage = await message.channel.send(nextText);
    } else if (typeof progressMessage.edit === 'function') {
      await progressMessage.edit(nextText);
    }
    lastRenderedText = nextText;
  };

  const renderFinal = async () => {
    if (disposed || typeof message?.channel?.send !== 'function') {
      return;
    }
    const nextText = formatDiscordProgressFinalMessage(channel, currentState);
    if (!progressMessage) {
      progressMessage = await message.channel.send(nextText);
    } else if (typeof progressMessage.edit === 'function') {
      await progressMessage.edit(nextText);
    }
    lastRenderedText = nextText;
  };

  return {
    async start() {
      await enqueue(() => renderProgress(true));
      interval = setInterval(() => {
        void enqueue(() => renderProgress(false));
      }, DISCORD_PROGRESS_UPDATE_INTERVAL_MS);
      interval.unref?.();
    },
    async transition(entry = {}) {
      currentState = {
        ...currentState,
        ...entry,
        startedAt: entry.startedAt || currentState.startedAt,
        reviewerVerdict:
          entry.reviewerVerdict === undefined
            ? currentState.reviewerVerdict
            : entry.reviewerVerdict,
      };
      await enqueue(() => renderProgress(true));
    },
    async complete(result = {}) {
      currentState = {
        ...currentState,
        status: 'completed',
        activeRole: result.role || currentState.activeRole,
        reviewerVerdict:
          result.reviewerVerdict === undefined
            ? currentState.reviewerVerdict
            : result.reviewerVerdict,
        completedAt: Date.now(),
      };
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      await enqueue(renderFinal);
    },
    async fail(error) {
      currentState = {
        ...currentState,
        status: 'failed',
        completedAt: Date.now(),
        error: toErrorMessage(error),
      };
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      await enqueue(renderFinal);
    },
    dispose() {
      disposed = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}

function resolveDiscordProgressTitle(channel, progress) {
  if (!isTribunalChannel(channel)) {
    return '응답 생성 중';
  }
  if (progress?.status === 'awaiting_revision') {
    return 'owner 수정 준비 중';
  }
  if (progress?.activeRole === 'reviewer' || progress?.status === 'reviewer_running') {
    return 'reviewer 검토 중';
  }
  if (progress?.activeRole === 'arbiter' || progress?.status === 'arbiter_running') {
    return 'arbiter 정리 중';
  }
  return 'owner 작성 중';
}

function resolveDiscordProgressFinalTitle(channel, progress) {
  if (progress?.status === 'failed') {
    return '실행 실패';
  }
  if (!isTribunalChannel(channel)) {
    return '응답 완료';
  }
  if (progress?.activeRole === 'arbiter') {
    return 'arbiter 완료';
  }
  if (progress?.reviewerVerdict === 'approved') {
    return 'reviewer 승인 완료';
  }
  return 'owner 완료';
}

function formatDiscordElapsedDuration(startedAt, endedAt) {
  const startMs = normalizeDiscordProgressTime(startedAt);
  const endMs = normalizeDiscordProgressTime(endedAt);
  if (startMs === null || endMs === null || endMs < startMs) {
    return '0초';
  }

  const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}시간`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}분`);
  }
  parts.push(`${seconds}초`);
  return parts.join(' ');
}

function normalizeDiscordProgressTime(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
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
