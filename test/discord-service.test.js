import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  flushPendingDiscordOutbox,
  flushDiscordOutboxForRun,
  formatDiscordProgressFinalMessage,
  formatDiscordProgressMessage,
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

test('discord progress formatter shows tribunal elapsed state clearly', () => {
  const text = formatDiscordProgressMessage(
    {
      name: 'tribunal-main',
      mode: 'tribunal',
      reviewRounds: 2,
    },
    {
      status: 'reviewer_running',
      activeRole: 'reviewer',
      currentRound: 1,
      maxRounds: 2,
      startedAt: '2026-04-16T00:00:00.000Z',
    },
    {
      now: new Date('2026-04-16T00:01:55.000Z').getTime(),
    },
  );

  assert.match(text, /⏱ \*\*reviewer 검토 중\*\*/u);
  assert.match(text, /tribunal-main · 1\/2 · 1분 55초 경과/u);
});

test('discord progress formatter shows final elapsed state clearly', () => {
  const text = formatDiscordProgressFinalMessage(
    {
      name: 'tribunal-main',
      mode: 'tribunal',
      reviewRounds: 2,
    },
    {
      status: 'completed',
      activeRole: 'arbiter',
      currentRound: 2,
      maxRounds: 2,
      reviewerVerdict: 'blocked',
      startedAt: '2026-04-16T00:00:00.000Z',
      completedAt: '2026-04-16T00:01:55.000Z',
    },
  );

  assert.match(text, /✅ \*\*arbiter 완료\*\*/u);
  assert.match(text, /tribunal-main · 2\/2 · 수정 필요 · 1분 55초 소요/u);
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
