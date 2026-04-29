import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
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
