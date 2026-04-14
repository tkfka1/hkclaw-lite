import fs from 'node:fs';

import { executeChannelTurn, isTribunalChannel } from './channel-runtime.js';
import {
  createDiscordServiceStatus,
  deleteDiscordServiceCommand,
  DISCORD_ROLE_NAMES,
  listDiscordServiceCommands,
  loadProjectEnvFile,
  resolveChannelBotNames,
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
const DISCORD_OUTBOX_FLUSH_INTERVAL_MS = 5_000;
const DISCORD_COMMAND_POLL_INTERVAL_MS = 1_000;

export async function serveDiscord(projectRoot, { envFile = null } = {}) {
  const { envFilePath } = loadProjectEnvFile(projectRoot, envFile);
  const config = loadConfig(projectRoot);
  const needsTribunalBots = listChannels(config).some((channel) => isTribunalChannel(channel));
  let botConfigs = resolveDiscordBotConfigs(config, process.env, {
    requireReviewerAndArbiter: needsTribunalBots,
  });
  const serviceStatus = createDiscordServiceStatus(projectRoot, {
    running: false,
    envFilePath,
    heartbeatAt: timestamp(),
    bots: buildDiscordBotStatus(botConfigs),
  });
  writeDiscordServiceStatus(projectRoot, serviceStatus);

  let heartbeatTimer = null;
  let outboxTimer = null;
  let commandTimer = null;
  let clients = {};
  let outboxFlushTask = Promise.resolve();

  try {
    const Discord = await import('discord.js');
    clients = await createDiscordClients(botConfigs, Discord);
    hydrateDiscordBotStatus(serviceStatus.bots, botConfigs, clients);
    serviceStatus.running = true;
    serviceStatus.startedAt = serviceStatus.startedAt || timestamp();
    serviceStatus.stoppedAt = null;
    serviceStatus.lastError = null;
    serviceStatus.heartbeatAt = timestamp();
    writeDiscordServiceStatus(projectRoot, serviceStatus);

    const enqueueOutboxFlush = (task) => {
      const next = outboxFlushTask
        .catch(() => {})
        .then(task);
      outboxFlushTask = next.catch(() => {});
      return next;
    };

    heartbeatTimer = setInterval(() => {
      serviceStatus.heartbeatAt = timestamp();
      writeDiscordServiceStatus(projectRoot, serviceStatus);
    }, 10_000);
    heartbeatTimer.unref?.();

    await enqueueOutboxFlush(() => flushPendingDiscordOutbox(projectRoot, clients));
    outboxTimer = setInterval(() => {
      void enqueueOutboxFlush(() => flushPendingDiscordOutbox(projectRoot, clients)).catch((error) => {
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
      });
    }

    commandTimer = setInterval(() => {
      void processDiscordServiceCommands({
        projectRoot,
        Discord,
        env: process.env,
        clients,
        botConfigs,
        serviceStatus,
        channelQueues,
        enqueueOutboxFlush,
      })
        .then((nextBotConfigs) => {
          botConfigs = nextBotConfigs;
        })
        .catch((error) => {
          serviceStatus.lastError = `Command processing failed: ${toErrorMessage(error)}`;
          serviceStatus.heartbeatAt = timestamp();
          writeDiscordServiceStatus(projectRoot, serviceStatus);
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
      writeDiscordServiceStatus(projectRoot, serviceStatus);
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
    writeDiscordServiceStatus(projectRoot, serviceStatus);
    throw error;
  }
}

async function createDiscordClients(botConfigs, Discord) {
  const clients = {};
  for (const [botName, bot] of Object.entries(botConfigs)) {
    if (!bot?.token) {
      continue;
    }
    clients[botName] = await createDiscordClient(bot.token, Discord);
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
    client.login(token).catch(reject);
  });

  return client;
}

async function handleInboundMessage({ projectRoot, clients, botName, message, enqueueOutboxFlush }) {
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
  if (resolveChannelInboundBotName(channel) !== botName) {
    return;
  }

  const workspace = channel.workspace || channel.workdir;
  assert(workspace, `Channel "${channel.name}" does not define a workspace.`);
  const workdir = resolveProjectPath(projectRoot, workspace);
  assert(fs.existsSync(workdir), `Workspace does not exist: ${workdir}`);

  await message.channel.sendTyping();
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
      await enqueueOutboxFlush(() =>
        flushDiscordOutboxForRun(projectRoot, clients, channel, runId, message.channelId),
      );
    }
    throw error;
  }

  if (runId) {
    await enqueueOutboxFlush(() =>
      flushDiscordOutboxForRun(projectRoot, clients, channel, runId, message.channelId),
    );
  }
}

function attachDiscordClientMessageHandler({
  projectRoot,
  clients,
  botName,
  client,
  channelQueues,
  enqueueOutboxFlush,
}) {
  client.on('messageCreate', (message) => {
    void enqueueChannelTask(channelQueues, message.channelId, async () => {
      await handleInboundMessage({
        projectRoot,
        clients,
        botName,
        message,
        enqueueOutboxFlush,
      });
    }).catch(async (error) => {
      console.error(`Discord handler error: ${toErrorMessage(error)}`);
      await sendDiscordText(client, message.channelId, `오류: ${toErrorMessage(error)}`);
    });
  });
}

async function processDiscordServiceCommands({
  projectRoot,
  Discord,
  env,
  clients,
  botConfigs,
  serviceStatus,
  channelQueues,
  enqueueOutboxFlush,
}) {
  const commands = listDiscordServiceCommands(projectRoot);
  if (commands.length === 0) {
    return botConfigs;
  }

  let nextBotConfigs = botConfigs;
  for (const command of commands) {
    try {
      if (command.action === 'reload-config') {
        nextBotConfigs = await reloadDiscordServiceConfig({
          projectRoot,
          Discord,
          env,
          clients,
          botConfigs: nextBotConfigs,
          serviceStatus,
          channelQueues,
          enqueueOutboxFlush,
        });
      } else if (command.action === 'reconnect-bot') {
        nextBotConfigs = await reconnectDiscordBot({
          projectRoot,
          Discord,
          env,
          clients,
          botConfigs: nextBotConfigs,
          botName: command.botName,
          serviceStatus,
          channelQueues,
          enqueueOutboxFlush,
        });
      }
    } finally {
      deleteDiscordServiceCommand(command);
    }
  }
  return nextBotConfigs;
}

async function reloadDiscordServiceConfig({
  projectRoot,
  Discord,
  env,
  clients,
  botConfigs,
  serviceStatus,
  channelQueues,
  enqueueOutboxFlush,
}) {
  const config = loadConfig(projectRoot);
  const needsTribunalBots = listChannels(config).some((channel) => isTribunalChannel(channel));
  const nextBotConfigs = resolveDiscordBotConfigs(config, env, {
    requireReviewerAndArbiter: needsTribunalBots,
  });
  if (buildDiscordBotConfigSignature(nextBotConfigs) === buildDiscordBotConfigSignature(botConfigs)) {
    return botConfigs;
  }

  const nextClients = {};
  for (const [botName, bot] of Object.entries(nextBotConfigs)) {
    const previous = botConfigs[botName];
    if (clients[botName] && previous && previous.token === bot.token) {
      nextClients[botName] = clients[botName];
      continue;
    }
    if (!bot.token) {
      continue;
    }
    const client = await createDiscordClient(bot.token, Discord);
    attachDiscordClientMessageHandler({
      projectRoot,
      clients,
      botName,
      client,
      channelQueues,
      enqueueOutboxFlush,
    });
    nextClients[botName] = client;
  }

  for (const [botName, client] of Object.entries(clients)) {
    if (nextClients[botName] === client) {
      continue;
    }
    client.destroy();
  }

  for (const botName of Object.keys(clients)) {
    delete clients[botName];
  }
  Object.assign(clients, nextClients);

  serviceStatus.bots = buildDiscordBotStatus(nextBotConfigs);
  hydrateDiscordBotStatus(serviceStatus.bots, nextBotConfigs, clients);
  serviceStatus.lastError = null;
  serviceStatus.heartbeatAt = timestamp();
  writeDiscordServiceStatus(projectRoot, serviceStatus);
  console.log('Discord service reloaded bot configuration.');
  return nextBotConfigs;
}

async function reconnectDiscordBot({
  projectRoot,
  Discord,
  env,
  clients,
  botConfigs,
  botName,
  serviceStatus,
  channelQueues,
  enqueueOutboxFlush,
}) {
  assert(botName, 'Bot name is required.');
  const config = loadConfig(projectRoot);
  const needsTribunalBots = listChannels(config).some((channel) => isTribunalChannel(channel));
  const nextBotConfigs = resolveDiscordBotConfigs(config, env, {
    requireReviewerAndArbiter: needsTribunalBots,
  });
  const nextBot = nextBotConfigs[botName] || null;
  const existingClient = clients[botName] || null;
  let nextClient = null;

  if (nextBot?.token) {
    nextClient = await createDiscordClient(nextBot.token, Discord);
    attachDiscordClientMessageHandler({
      projectRoot,
      clients,
      botName,
      client: nextClient,
      channelQueues,
      enqueueOutboxFlush,
    });
  }

  if (existingClient && existingClient !== nextClient) {
    existingClient.destroy();
  }

  if (nextClient) {
    clients[botName] = nextClient;
  } else {
    delete clients[botName];
  }

  serviceStatus.bots = buildDiscordBotStatus(nextBotConfigs);
  hydrateDiscordBotStatus(serviceStatus.bots, nextBotConfigs, clients);
  serviceStatus.lastError = null;
  serviceStatus.heartbeatAt = timestamp();
  writeDiscordServiceStatus(projectRoot, serviceStatus);
  console.log(`Discord service reconnected bot "${botName}".`);
  return nextBotConfigs;
}

async function sendDiscordText(client, channelId, text) {
  assert(client, 'Discord client is not available for this role.');
  const channel = await client.channels.fetch(channelId);
  assert(channel?.isTextBased?.(), `Discord channel "${channelId}" is not text-based.`);
  for (const chunk of splitDiscordMessage(text)) {
    await channel.send(chunk);
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
    String(entry?.content || '').trim() || '(빈 응답)',
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
) {
  const events = await listPendingRuntimeOutboxEvents(projectRoot, { runId, limit: 100 });
  for (const event of events) {
    const botName = resolveEventBotName(channel, event.role);
    const client = clients[botName];
    assert(client, `${botName || event.role} bot client is not configured.`);
    const channelId = event.discordChannelId || fallbackChannelId;
    assert(channelId, `Discord channel id is missing for run ${runId}.`);
    await sendDiscordText(client, channelId, formatDiscordRoleMessage(channel, event));
    await markRuntimeOutboxEventDispatched(projectRoot, event.eventId);
  }
}

export async function flushPendingDiscordOutbox(projectRoot, clients, { limit = 100 } = {}) {
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
    const botName = resolveEventBotName(channel, event.role);
    const client = clients[botName];
    assert(client, `${botName || event.role} bot client is not configured.`);
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

function resolveDiscordBotConfigs(config, env, { requireReviewerAndArbiter = false } = {}) {
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

function buildDiscordBotConfigSignature(botConfigs) {
  return JSON.stringify(
    Object.entries(botConfigs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, bot]) => ({
        name,
        agent: bot?.agent || '',
        token: bot?.token || '',
      })),
  );
}

function buildDiscordBotStatus(botConfigs) {
  return Object.fromEntries(
    Object.entries(botConfigs).map(([botName, bot]) => [
      botName,
      {
        agent: bot.agent || '',
        tokenConfigured: Boolean(bot.token),
        connected: false,
        tag: '',
        userId: '',
      },
    ]),
  );
}

function hydrateDiscordBotStatus(bots, botConfigs, clients) {
  for (const [botName, bot] of Object.entries(botConfigs)) {
    const client = clients[botName];
    bots[botName] = {
      agent: bot.agent || '',
      tokenConfigured: Boolean(bot.token),
      connected: Boolean(client?.user),
      tag: client?.user?.tag || '',
      userId: client?.user?.id || '',
    };
  }
}

function resolveChannelInboundBotName(channel) {
  const botNames = resolveChannelBotNames(channel);
  return botNames.owner || 'owner';
}

function resolveEventBotName(channel, role) {
  const botNames = resolveChannelBotNames(channel);
  if (role === 'reviewer') {
    return botNames.reviewer || 'reviewer';
  }
  if (role === 'arbiter') {
    return botNames.arbiter || 'arbiter';
  }
  return botNames.owner || 'owner';
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
