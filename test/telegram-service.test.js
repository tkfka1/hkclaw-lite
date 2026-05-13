import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  flushPendingTelegramOutbox,
  flushTelegramOutboxForRun,
  formatTelegramChatIdentityMessage,
  formatTelegramRoleMessage,
  lookupTelegramApiHost,
  recordTelegramRecentChat,
  withTelegramTypingIndicator,
} from '../src/telegram-service.js';
import {
  enqueueRuntimeOutboxEvent,
  listPendingRuntimeOutboxEvents,
  startRuntimeRun,
} from '../src/runtime-db.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  createDefaultConfig,
  initProject,
  saveConfig,
} from '../src/store.js';

function createProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-telegram-test-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('telegram API lookup forces IPv4 for cluster networks without IPv6 egress', async (t) => {
  const lookupCalls = [];
  const ipv4Addresses = [{ address: '149.154.166.110', family: 4 }];
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    lookupCalls.push({ hostname, options });
    callback(null, options.all ? ipv4Addresses : ipv4Addresses[0].address, 4);
  });

  const result = await new Promise((resolve, reject) => {
    lookupTelegramApiHost('api.telegram.org', { all: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(addresses);
    });
  });

  assert.deepEqual(result, ipv4Addresses);
  assert.equal(lookupCalls.length, 1);
  assert.equal(lookupCalls[0].hostname, 'api.telegram.org');
  assert.equal(lookupCalls[0].options.family, 4);
  assert.equal(lookupCalls[0].options.all, true);
});

test('telegram formatter labels tribunal roles clearly', () => {
  const channel = {
    name: 'tribunal-main',
    mode: 'tribunal',
  };

  const ownerText = formatTelegramRoleMessage(channel, {
    role: 'owner',
    mode: 'tribunal',
    round: 1,
    maxRounds: 2,
    agent: {
      name: 'owner-agent',
    },
    content: 'owner draft',
  });
  assert.match(ownerText, /owner 초안 · owner-agent/u);
  assert.match(ownerText, /tribunal-main · 1\/2/u);

  const ownerFinalText = formatTelegramRoleMessage(channel, {
    role: 'owner',
    mode: 'tribunal',
    round: 1,
    maxRounds: 2,
    final: true,
    agent: {
      name: 'owner-agent',
    },
    content: 'owner final',
  });
  assert.match(ownerFinalText, /owner 최종 · owner-agent/u);

  const reviewerText = formatTelegramRoleMessage(channel, {
    role: 'reviewer',
    mode: 'tribunal',
    round: 1,
    maxRounds: 2,
    verdict: 'blocked',
    agent: {
      name: 'reviewer-agent',
    },
    content: 'BLOCKED: revise this',
  });
  assert.match(reviewerText, /reviewer 판정 · reviewer-agent/u);
  assert.match(reviewerText, /수정 필요/u);
});

test('telegram formatter keeps single channels concise', () => {
  const text = formatTelegramRoleMessage(
    {
      name: 'main',
      mode: 'single',
    },
    {
      role: 'owner',
      mode: 'single',
      round: 1,
      maxRounds: 1,
      agent: {
        name: 'worker',
      },
      content: 'done',
    },
  );

  assert.equal(text, 'done');
});

test('telegram service records recent chat targets for setup discovery', () => {
  const serviceStatus = {
    recentChats: [],
  };
  const message = {
    message_thread_id: 77,
    chat: {
      id: -1001234567890,
      type: 'supergroup',
      title: 'Ops Room',
    },
    from: {
      username: 'alice',
      first_name: 'Alice',
    },
  };

  assert.equal(
    recordTelegramRecentChat(serviceStatus, 'telegram-worker', message, '2026-04-30T00:00:00.000Z'),
    true,
  );
  assert.deepEqual(serviceStatus.recentChats, [
    {
      agentName: 'telegram-worker',
      chatId: '-1001234567890',
      threadId: '77',
      type: 'supergroup',
      title: 'Ops Room',
      username: '',
      fromUsername: 'alice',
      fromName: 'Alice',
      lastSeenAt: '2026-04-30T00:00:00.000Z',
    },
  ]);

  assert.equal(
    recordTelegramRecentChat(serviceStatus, 'telegram-worker', message, '2026-04-30T00:01:00.000Z'),
    true,
  );
  assert.equal(serviceStatus.recentChats.length, 1);
  assert.equal(serviceStatus.recentChats[0].lastSeenAt, '2026-04-30T00:01:00.000Z');
});

test('telegram /id response includes chat and thread ids', () => {
  const text = formatTelegramChatIdentityMessage({
    message_thread_id: 77,
    chat: {
      id: -1001234567890,
      type: 'supergroup',
      title: 'Ops Room',
    },
  });

  assert.match(text, /chat_id: -1001234567890/u);
  assert.match(text, /thread_id: 77/u);
  assert.match(text, /title: Ops Room/u);
});

test('telegram service flushes queued runtime outbox events', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const channel = {
    name: 'tribunal-main',
    platform: 'telegram',
    telegramChatId: '-100123',
    telegramThreadId: '77',
    mode: 'tribunal',
  };
  const run = await startRuntimeRun(projectRoot, {
    channel,
    prompt: 'ship it',
    workdir: '/tmp/workspace',
  });
  await enqueueRuntimeOutboxEvent(projectRoot, {
    runId: run.runId,
    channel,
    entry: {
      role: 'owner',
      agent: { name: 'owner-agent' },
      content: 'owner draft',
      final: false,
      round: 1,
      maxRounds: 2,
      mode: 'tribunal',
    },
  });

  const sent = [];
  const clients = {
    owner: {
      token: 'telegram-token',
      async __send(method, payload) {
        sent.push({ method, payload });
        return { ok: true };
      },
    },
  };

  await flushTelegramOutboxForRun(projectRoot, clients, channel, run.runId, '-100123', {
    fallbackThreadId: '77',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'sendMessage');
  assert.equal(String(sent[0].payload.chat_id), '-100123');
  assert.equal(sent[0].payload.message_thread_id, 77);
  assert.match(sent[0].payload.text, /owner 초안 · owner-agent/u);

  const pending = await listPendingRuntimeOutboxEvents(projectRoot, {
    runId: run.runId,
    limit: 10,
  });
  assert.equal(pending.length, 0);
});

test('telegram typing indicator stays active while a task runs', async () => {
  const sent = [];
  const client = {
    token: 'telegram-token',
    async __send(method, payload) {
      sent.push({ method, payload });
      return { ok: true };
    },
  };

  await withTelegramTypingIndicator(
    client,
    '-100123',
    { threadId: '77', intervalMs: 20 },
    async () => {
      await sleep(225);
    },
  );

  const actions = sent.filter((entry) => entry.method === 'sendChatAction');
  assert.ok(actions.length >= 2);
  assert.ok(actions.every((entry) => entry.payload.action === 'typing'));
  assert.equal(String(actions[0].payload.chat_id), '-100123');
  assert.equal(actions[0].payload.message_thread_id, 77);

  const countAfterStop = actions.length;
  await sleep(130);
  assert.equal(
    sent.filter((entry) => entry.method === 'sendChatAction').length,
    countAfterStop,
  );
});

test('telegram service flushes pending outbox events after restart', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    platform: 'telegram',
    command: 'cat',
    telegramBotToken: 'telegram-token',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    platform: 'telegram',
    telegramChatId: '-100123',
    workspace: '~',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const run = await startRuntimeRun(projectRoot, {
    channel: {
      name: 'main',
      platform: 'telegram',
      telegramChatId: '-100123',
      mode: 'single',
      agent: 'owner',
    },
    prompt: 'recover me',
    workdir: '/tmp/workspace',
  });
  await enqueueRuntimeOutboxEvent(projectRoot, {
    runId: run.runId,
    channel: {
      name: 'main',
      platform: 'telegram',
      telegramChatId: '-100123',
      mode: 'single',
    },
    entry: {
      role: 'owner',
      agent: { name: 'owner' },
      content: 'queued text',
      final: true,
      round: 1,
      maxRounds: 1,
      mode: 'single',
    },
  });

  const sent = [];
  const clients = {
    owner: {
      token: 'telegram-token',
      async __send(method, payload) {
        sent.push({ method, payload });
        return { ok: true };
      },
    },
  };

  const flushed = await flushPendingTelegramOutbox(projectRoot, clients, { limit: 10 });
  assert.equal(flushed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.text, 'queued text');

  const pending = await listPendingRuntimeOutboxEvents(projectRoot, {
    limit: 10,
  });
  assert.equal(pending.length, 0);
});

test('telegram pending outbox can deliver through an agent platform route', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    platform: 'telegram',
    command: 'cat',
    telegramBotToken: 'telegram-token',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    platform: 'telegram',
    telegramChatId: '-100123',
    workspace: '~',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const run = await startRuntimeRun(projectRoot, {
    channel: {
      name: 'main',
      platform: 'telegram',
      telegramChatId: '-100123',
      mode: 'single',
      agent: 'owner',
    },
    prompt: 'recover connector outbox',
    workdir: '/tmp/workspace',
  });
  await enqueueRuntimeOutboxEvent(projectRoot, {
    runId: run.runId,
    channel: {
      name: 'main',
      platform: 'telegram',
      telegramChatId: '-100123',
      mode: 'single',
    },
    entry: {
      role: 'owner',
      agent: { name: 'owner' },
      content: 'agent route text',
      final: true,
      round: 1,
      maxRounds: 1,
      mode: 'single',
    },
  });

  const sent = [];
  const clients = {
    owner: {
      token: 'telegram-token',
      async __send(method, payload) {
        sent.push({ method, payload });
        return { ok: true };
      },
    },
  };

  const flushed = await flushPendingTelegramOutbox(projectRoot, clients, { limit: 10 });
  assert.equal(flushed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.text, 'agent route text');
});

test('telegram outbox flush skips bad events and continues with valid ones', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    platform: 'telegram',
    command: 'cat',
    telegramBotToken: 'owner-token',
  });
  config.agents.reviewer = buildAgentDefinition(projectRoot, 'reviewer', {
    name: 'reviewer',
    agent: 'command',
    platform: 'telegram',
    command: 'cat',
    telegramBotToken: 'reviewer-token',
  });
  config.agents.arbiter = buildAgentDefinition(projectRoot, 'arbiter', {
    name: 'arbiter',
    agent: 'command',
    platform: 'telegram',
    command: 'cat',
    telegramBotToken: 'arbiter-token',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    platform: 'telegram',
    mode: 'tribunal',
    telegramChatId: '-100123',
    workspace: '~',
    agent: 'owner',
    reviewer: 'reviewer',
    arbiter: 'arbiter',
  });
  saveConfig(projectRoot, config);

  const run = await startRuntimeRun(projectRoot, {
    channel: {
      name: 'main',
      platform: 'telegram',
      telegramChatId: '-100123',
      mode: 'tribunal',
      agent: 'owner',
      reviewer: 'reviewer',
      arbiter: 'arbiter',
    },
    prompt: 'recover partial outbox',
    workdir: '/tmp/workspace',
  });

  await enqueueRuntimeOutboxEvent(projectRoot, {
    runId: run.runId,
    channel: {
      name: 'main',
      platform: 'telegram',
      telegramChatId: '-100123',
      mode: 'tribunal',
    },
    entry: {
      role: 'reviewer',
      agent: { name: 'reviewer' },
      content: 'review result',
      final: false,
      round: 1,
      maxRounds: 2,
      mode: 'tribunal',
    },
  });
  await enqueueRuntimeOutboxEvent(projectRoot, {
    runId: run.runId,
    channel: {
      name: 'main',
      platform: 'telegram',
      telegramChatId: '-100123',
      mode: 'tribunal',
    },
    entry: {
      role: 'owner',
      agent: { name: 'owner' },
      content: 'owner result',
      final: true,
      round: 1,
      maxRounds: 2,
      mode: 'tribunal',
    },
  });

  const sent = [];
  const clients = {
    owner: {
      token: 'telegram-token',
      async __send(method, payload) {
        sent.push({ method, payload });
        return { ok: true };
      },
    },
  };

  const flushed = await flushPendingTelegramOutbox(projectRoot, clients, { limit: 10 });
  assert.equal(flushed, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.text, /owner result/u);
  assert.match(sent[0].payload.text, /owner 최종/u);

  const pending = await listPendingRuntimeOutboxEvents(projectRoot, { limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].role, 'reviewer');
});
