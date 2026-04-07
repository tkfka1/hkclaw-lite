import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { executeChannelTurn } from '../src/channel-runtime.js';
import {
  listPendingRuntimeOutboxEvents,
  listRecentRuntimeRuns,
  listRuntimeRoleSessions,
  listRuntimeRoleMessages,
  listRuntimeRunEvents,
} from '../src/runtime-db.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  createDefaultConfig,
  getChannel,
  initProject,
  loadConfig,
  saveConfig,
} from '../src/store.js';

const repoRoot = process.cwd();
const ownerFixturePath = path.join(repoRoot, 'test', 'fixtures', 'echo-assistant.mjs');
const reviewerFixturePath = path.join(repoRoot, 'test', 'fixtures', 'blocking-reviewer.mjs');
const arbiterFixturePath = path.join(repoRoot, 'test', 'fixtures', 'arbiter-agent.mjs');

function createProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-runtime-test-'));
}

test('single channel emits owner result once', async () => {
  const projectRoot = createProject();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    command: `node ${ownerFixturePath}`,
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    mode: 'single',
    discordChannelId: '123',
    workspace: 'workspace',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const loaded = loadConfig(projectRoot);
  const events = [];
  const result = await executeChannelTurn({
    projectRoot,
    config: loaded,
    channel: getChannel(loaded, 'main'),
    prompt: 'hello runtime',
    workdir: workspacePath,
    onRoleMessage: async (entry) => {
      events.push({
        role: entry.role,
        final: entry.final,
        content: entry.content,
      });
    },
  });

  assert.equal(result.role, 'owner');
  assert.match(result.content, /HELLO RUNTIME/u);
  assert.deepEqual(events, [
    {
      role: 'owner',
      final: true,
      content: result.content,
    },
  ]);

  const runs = await listRecentRuntimeRuns(projectRoot, { limit: 5 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].channelName, 'main');
  assert.equal(runs[0].mode, 'single');
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].currentRound, 1);
  assert.equal(runs[0].maxRounds, 1);
  assert.equal(runs[0].finalDisposition, 'owner_response_sent');
  assert.equal(runs[0].resultRole, 'owner');
  assert.match(runs[0].resultContent, /HELLO RUNTIME/u);

  const runEvents = await listRuntimeRunEvents(projectRoot, runs[0].runId);
  assert.deepEqual(
    runEvents.map((entry) => entry.status),
    ['queued', 'owner_running', 'completed'],
  );

  const messages = await listRuntimeRoleMessages(projectRoot, runs[0].runId);
  assert.deepEqual(
    messages.map((entry) => ({
      role: entry.role,
      final: entry.final,
    })),
    [
      {
        role: 'owner',
        final: true,
      },
    ],
  );

  const outbox = await listPendingRuntimeOutboxEvents(projectRoot, {
    runId: runs[0].runId,
    limit: 10,
  });
  assert.deepEqual(
    outbox.map((entry) => ({
      role: entry.role,
      final: entry.final,
    })),
    [
      {
        role: 'owner',
        final: true,
      },
    ],
  );

  const sessions = await listRuntimeRoleSessions(projectRoot, { channelName: 'main' });
  assert.deepEqual(
    sessions.map((entry) => ({
      role: entry.role,
      agentName: entry.agentName,
      runCount: entry.runCount,
      sessionPolicy: entry.sessionPolicy,
      lastStatus: entry.lastStatus,
    })),
    [
      {
        role: 'owner',
        agentName: 'owner',
        runCount: 1,
        sessionPolicy: 'sticky',
        lastStatus: 'completed',
      },
    ],
  );
});

test('tribunal channel emits owner, reviewer, and arbiter roles in order', async () => {
  const projectRoot = createProject();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    command: `node ${ownerFixturePath}`,
  });
  config.agents.reviewer = buildAgentDefinition(projectRoot, 'reviewer', {
    name: 'reviewer',
    agent: 'command',
    command: `node ${reviewerFixturePath}`,
  });
  config.agents.arbiter = buildAgentDefinition(projectRoot, 'arbiter', {
    name: 'arbiter',
    agent: 'command',
    command: `node ${arbiterFixturePath}`,
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    mode: 'tribunal',
    discordChannelId: '123',
    workspace: 'workspace',
    agent: 'owner',
    reviewer: 'reviewer',
    arbiter: 'arbiter',
    reviewRounds: 1,
  });
  saveConfig(projectRoot, config);

  const loaded = loadConfig(projectRoot);
  const events = [];
  const result = await executeChannelTurn({
    projectRoot,
    config: loaded,
    channel: getChannel(loaded, 'main'),
    prompt: 'settle this',
    workdir: workspacePath,
    onRoleMessage: async (entry) => {
      events.push({
        role: entry.role,
        final: entry.final,
        content: entry.content,
      });
    },
  });

  assert.equal(result.role, 'arbiter');
  assert.equal(result.content, 'arbiter-final');
  assert.deepEqual(
    events.map((entry) => entry.role),
    ['owner', 'reviewer', 'arbiter'],
  );
  assert.equal(events[0].final, false);
  assert.equal(events[1].final, false);
  assert.equal(events[2].final, true);
  assert.match(events[1].content, /^BLOCKED:/u);

  const runs = await listRecentRuntimeRuns(projectRoot, { limit: 5 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].channelName, 'main');
  assert.equal(runs[0].mode, 'tribunal');
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].currentRound, 1);
  assert.equal(runs[0].maxRounds, 1);
  assert.equal(runs[0].reviewerVerdict, 'blocked');
  assert.equal(runs[0].finalDisposition, 'arbiter_after_blocked_review');
  assert.equal(runs[0].resultRole, 'arbiter');
  assert.equal(runs[0].arbiterAgent, 'arbiter');

  const runEvents = await listRuntimeRunEvents(projectRoot, runs[0].runId);
  assert.deepEqual(
    runEvents.map((entry) => ({
      status: entry.status,
      role: entry.role || null,
      verdict: entry.verdict || null,
    })),
    [
      {
        status: 'queued',
        role: null,
        verdict: null,
      },
      {
        status: 'owner_running',
        role: 'owner',
        verdict: null,
      },
      {
        status: 'reviewer_running',
        role: 'reviewer',
        verdict: null,
      },
      {
        status: 'arbiter_running',
        role: 'arbiter',
        verdict: 'blocked',
      },
      {
        status: 'completed',
        role: 'arbiter',
        verdict: 'blocked',
      },
    ],
  );

  const messages = await listRuntimeRoleMessages(projectRoot, runs[0].runId);
  assert.deepEqual(
    messages.map((entry) => ({
      role: entry.role,
      verdict: entry.verdict || null,
      final: entry.final,
    })),
    [
      {
        role: 'owner',
        verdict: null,
        final: false,
      },
      {
        role: 'reviewer',
        verdict: 'blocked',
        final: false,
      },
      {
        role: 'arbiter',
        verdict: 'blocked',
        final: true,
      },
    ],
  );

  const outbox = await listPendingRuntimeOutboxEvents(projectRoot, {
    runId: runs[0].runId,
    limit: 10,
  });
  assert.deepEqual(
    outbox.map((entry) => entry.role),
    ['owner', 'reviewer', 'arbiter'],
  );

  const sessions = await listRuntimeRoleSessions(projectRoot, { channelName: 'main' });
  assert.deepEqual(
    sessions.map((entry) => ({
      role: entry.role,
      agentName: entry.agentName,
      runCount: entry.runCount,
      sessionPolicy: entry.sessionPolicy,
      lastVerdict: entry.lastVerdict,
    })),
    [
      {
        role: 'arbiter',
        agentName: 'arbiter',
        runCount: 1,
        sessionPolicy: 'ephemeral',
        lastVerdict: 'blocked',
      },
      {
        role: 'reviewer',
        agentName: 'reviewer',
        runCount: 1,
        sessionPolicy: 'sticky',
        lastVerdict: 'blocked',
      },
      {
        role: 'owner',
        agentName: 'owner',
        runCount: 1,
        sessionPolicy: 'sticky',
        lastVerdict: null,
      },
    ],
  );
});
