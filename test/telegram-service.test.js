import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  flushPendingTelegramOutbox,
  flushTelegramOutboxForRun,
  formatTelegramRoleMessage,
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
  assert.match(sent[0].payload.text, /owner 초안/u);

  const pending = await listPendingRuntimeOutboxEvents(projectRoot, { limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].role, 'reviewer');
});
