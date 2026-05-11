import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createDiscordIntermediatePublisher,
  flushPendingDiscordOutbox,
  flushDiscordOutboxForRun,
  formatDiscordRoleMessage,
} from '../src/discord-service.js';
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-discord-test-'));
}

test('discord formatter labels tribunal roles clearly', () => {
  const channel = {
    name: 'tribunal-main',
    mode: 'tribunal',
  };

  const ownerText = formatDiscordRoleMessage(channel, {
    role: 'owner',
    mode: 'tribunal',
    round: 1,
    maxRounds: 2,
    agent: {
      name: 'owner-agent',
    },
    content: 'owner draft',
  });
  assert.match(ownerText, /\*\*owner 초안 · owner-agent\*\*/u);
  assert.match(ownerText, /tribunal-main · 1\/2/u);

  const reviewerText = formatDiscordRoleMessage(channel, {
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
  assert.match(reviewerText, /\*\*reviewer 판정 · reviewer-agent\*\*/u);
  assert.match(reviewerText, /수정 필요/u);

  const arbiterText = formatDiscordRoleMessage(channel, {
    role: 'arbiter',
    mode: 'tribunal',
    round: 2,
    maxRounds: 2,
    verdict: 'blocked',
    agent: {
      name: 'arbiter-agent',
    },
    content: 'final answer',
  });
  assert.match(arbiterText, /\*\*arbiter 최종 · arbiter-agent\*\*/u);
  assert.match(arbiterText, /최종 정리/u);
});

test('discord formatter keeps single channels concise', () => {
  const text = formatDiscordRoleMessage(
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

test('discord intermediate publisher edits one compact status message', async () => {
  const sent = [];
  const edits = [];
  const channel = {
    async send(text) {
      sent.push(text);
      return {
        async edit(nextText) {
          edits.push(nextText);
          return this;
        },
      };
    },
  };

  const publisher = createDiscordIntermediatePublisher(channel);
  await publisher.push({
    source: 'claude-cli',
    kind: 'tool',
    phase: 'start',
    toolName: 'exec_command',
    text: 'cat very-large-file-with-sensitive-command-body',
  });
  await publisher.push({
    source: 'claude-cli',
    kind: 'tool',
    phase: 'input',
    toolName: 'exec_command',
    text: '\n'.repeat(10) + 'full tool payload should stay hidden',
  });
  await publisher.push({
    source: 'claude-cli',
    kind: 'thinking',
    text: 'working on it',
  });
  await publisher.finish();

  assert.equal(sent.length, 1);
  assert.ok(edits.length >= 1);
  assert.match(sent[0], /도구 실행 중: exec_command/u);
  assert.doesNotMatch(sent.join('\n'), /full tool payload/u);
  assert.doesNotMatch(edits.join('\n'), /full tool payload/u);
  assert.match(edits.at(-1), /working on it/u);
});

test('discord intermediate publisher accepts Codex stream events', async () => {
  const sent = [];
  const edits = [];
  const channel = {
    async send(text) {
      sent.push(text);
      return {
        async edit(nextText) {
          edits.push(nextText);
          return this;
        },
      };
    },
  };

  const publisher = createDiscordIntermediatePublisher(channel);
  await publisher.push({
    source: 'codex-cli',
    kind: 'thinking',
    text: 'checking files',
  });
  await publisher.push({
    source: 'codex-cli',
    kind: 'tool',
    phase: 'stop',
    toolName: 'exec_command',
    text: '{"cmd":"pwd"}',
  });
  await publisher.finish();

  assert.equal(sent.length, 1);
  assert.match(sent[0], /checking files/u);
  assert.match(edits.at(-1), /도구 실행 중: exec_command/u);
  assert.doesNotMatch(edits.join('\n'), /"cmd":"pwd"/u);
});

test('discord service flushes queued runtime outbox events', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const channel = {
    name: 'tribunal-main',
    discordChannelId: '123',
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
      channels: {
        async fetch(channelId) {
          return {
            isTextBased() {
              return channelId === '123';
            },
            async send(text) {
              sent.push(text);
            },
          };
        },
      },
    },
  };

  await flushDiscordOutboxForRun(projectRoot, clients, channel, run.runId, '123');

  assert.equal(sent.length, 1);
  assert.match(sent[0], /\*\*owner 초안 · owner-agent\*\*/u);

  const pending = await listPendingRuntimeOutboxEvents(projectRoot, {
    runId: run.runId,
    limit: 10,
  });
  assert.equal(pending.length, 0);
});

test('discord service flushes pending outbox events after restart', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    command: 'cat',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    discordChannelId: '123',
    workspace: '~',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const run = await startRuntimeRun(projectRoot, {
    channel: {
      name: 'main',
      discordChannelId: '123',
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
      discordChannelId: '123',
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
      channels: {
        async fetch(channelId) {
          return {
            isTextBased() {
              return channelId === '123';
            },
            async send(text) {
              sent.push(text);
            },
          };
        },
      },
    },
  };

  const flushed = await flushPendingDiscordOutbox(projectRoot, clients, { limit: 10 });
  assert.equal(flushed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'queued text');

  const pending = await listPendingRuntimeOutboxEvents(projectRoot, {
    limit: 10,
  });
  assert.equal(pending.length, 0);
});

test('discord pending outbox can deliver through an agent platform route', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    command: 'cat',
    discordToken: 'discord-token',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    discordChannelId: '123',
    workspace: '~',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const run = await startRuntimeRun(projectRoot, {
    channel: {
      name: 'main',
      discordChannelId: '123',
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
      discordChannelId: '123',
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
      channels: {
        async fetch(channelId) {
          return {
            isTextBased() {
              return channelId === '123';
            },
            async send(text) {
              sent.push(text);
            },
          };
        },
      },
    },
  };

  const flushed = await flushPendingDiscordOutbox(projectRoot, clients, { limit: 10 });
  assert.equal(flushed, 1);
  assert.deepEqual(sent, ['agent route text']);
});

test('discord pending outbox can deliver through a direct DM route', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    command: 'cat',
    discordToken: 'discord-token',
  });
  config.channels.dm = buildChannelDefinition(projectRoot, config, 'dm', {
    name: 'dm',
    targetType: 'direct',
    discordUserId: 'user-123',
    workspace: '~',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const run = await startRuntimeRun(projectRoot, {
    channel: {
      name: 'dm',
      targetType: 'direct',
      discordUserId: 'user-123',
      mode: 'single',
      agent: 'owner',
    },
    prompt: 'recover dm outbox',
    workdir: '/tmp/workspace',
  });
  await enqueueRuntimeOutboxEvent(projectRoot, {
    runId: run.runId,
    channel: {
      name: 'dm',
      targetType: 'direct',
      discordUserId: 'user-123',
      mode: 'single',
    },
    entry: {
      role: 'owner',
      agent: { name: 'owner' },
      content: 'dm route text',
      final: true,
      round: 1,
      maxRounds: 1,
      mode: 'single',
    },
  });

  const sent = [];
  const clients = {
    owner: {
      users: {
        async fetch(userId) {
          assert.equal(userId, 'user-123');
          return {
            async send(text) {
              sent.push(text);
            },
          };
        },
      },
    },
  };

  const flushed = await flushPendingDiscordOutbox(projectRoot, clients, { limit: 10 });
  assert.equal(flushed, 1);
  assert.deepEqual(sent, ['dm route text']);
});

test('discord outbox flush skips bad events and continues with valid ones', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    command: 'cat',
  });
  config.agents.reviewer = buildAgentDefinition(projectRoot, 'reviewer', {
    name: 'reviewer',
    agent: 'command',
    command: 'cat',
  });
  config.agents.arbiter = buildAgentDefinition(projectRoot, 'arbiter', {
    name: 'arbiter',
    agent: 'command',
    command: 'cat',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    mode: 'tribunal',
    discordChannelId: '123',
    workspace: '~',
    agent: 'owner',
    reviewer: 'reviewer',
    arbiter: 'arbiter',
  });
  saveConfig(projectRoot, config);

  const run = await startRuntimeRun(projectRoot, {
    channel: {
      name: 'main',
      discordChannelId: '123',
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
      discordChannelId: '123',
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
      discordChannelId: '123',
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
      channels: {
        async fetch(channelId) {
          return {
            isTextBased() {
              return channelId === '123';
            },
            async send(text) {
              sent.push(text);
            },
          };
        },
      },
    },
  };

  const flushed = await flushPendingDiscordOutbox(projectRoot, clients, { limit: 10 });
  assert.equal(flushed, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /owner result/u);

  const pending = await listPendingRuntimeOutboxEvents(projectRoot, { limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].role, 'reviewer');
});
