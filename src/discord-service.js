import fs from 'node:fs';

import { executeChannelTurn, isTribunalChannel } from './channel-runtime.js';
import {
  createDiscordServiceStatus,
  DISCORD_ROLE_NAMES,
  loadProjectEnvFile,
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

export async function serveDiscord(projectRoot, { envFile = null } = {}) {
  const { envFilePath } = loadProjectEnvFile(projectRoot, envFile);
  const config = loadConfig(projectRoot);
  const needsTribunalBots = listChannels(config).some((channel) => isTribunalChannel(channel));
  const roleTokens = resolveDiscordRoleTokens(process.env, {
    requireReviewerAndArbiter: needsTribunalBots,
  });
  const serviceStatus = createDiscordServiceStatus(projectRoot, {
    running: false,
    envFilePath,
    heartbeatAt: timestamp(),
    roles: buildDiscordRoleStatus(roleTokens),
  });
  writeDiscordServiceStatus(projectRoot, serviceStatus);

  let heartbeatTimer = null;
  let outboxTimer = null;
  let clients = {};
  let outboxFlushTask = Promise.resolve();

  try {
    const Discord = await import('discord.js');
    clients = await createDiscordClients(roleTokens, Discord);
    hydrateDiscordRoleStatus(serviceStatus.roles, roleTokens, clients);
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

    const ownerClient = clients.owner;
    const channelQueues = new Map();

    ownerClient.on('messageCreate', (message) => {
      void enqueueChannelTask(channelQueues, message.channelId, async () => {
        await handleInboundMessage({
          projectRoot,
          clients,
          message,
          enqueueOutboxFlush,
        });
      }).catch(async (error) => {
        console.error(`Discord handler error: ${toErrorMessage(error)}`);
        await sendDiscordText(clients.owner, message.channelId, `오류: ${toErrorMessage(error)}`);
      });
    });

    printDiscordStartup(projectRoot, clients);
    await waitForShutdown(async () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (outboxTimer) {
        clearInterval(outboxTimer);
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
    serviceStatus.running = false;
    serviceStatus.lastError = toErrorMessage(error);
    serviceStatus.stoppedAt = timestamp();
    serviceStatus.heartbeatAt = timestamp();
    writeDiscordServiceStatus(projectRoot, serviceStatus);
    throw error;
  }
}

async function createDiscordClients(roleTokens, Discord) {
  const clients = {};
  for (const role of DISCORD_ROLE_NAMES) {
    if (!roleTokens[role]) {
      continue;
    }
    clients[role] = await createDiscordClient(roleTokens[role], Discord);
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

async function handleInboundMessage({ projectRoot, clients, message, enqueueOutboxFlush }) {
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
    const client = clients[event.role];
    assert(client, `${event.role} bot client is not configured.`);
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
    const client = clients[event.role];
    assert(client, `${event.role} bot client is not configured.`);
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
  for (const role of DISCORD_ROLE_NAMES) {
    const client = clients[role];
    if (!client?.user) {
      continue;
    }
    console.log(`${role}: ${client.user.tag}`);
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

function buildDiscordRoleStatus(roleTokens) {
  return Object.fromEntries(
    DISCORD_ROLE_NAMES.map((role) => [
      role,
      {
        tokenConfigured: Boolean(roleTokens[role]),
        connected: false,
        tag: '',
        userId: '',
      },
    ]),
  );
}

function hydrateDiscordRoleStatus(roles, roleTokens, clients) {
  for (const role of DISCORD_ROLE_NAMES) {
    const client = clients[role];
    roles[role] = {
      tokenConfigured: Boolean(roleTokens[role]),
      connected: Boolean(client?.user),
      tag: client?.user?.tag || '',
      userId: client?.user?.id || '',
    };
  }
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
