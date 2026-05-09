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
const inspectFixturePath = path.join(repoRoot, 'test', 'fixtures', 'inspect-agent.mjs');

function createProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-runtime-test-'));
}

function createFakeClaudeAgentSdkBundle() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-runtime-claude-sdk-'));
  const packageDir = path.join(rootDir, '@anthropic-ai', 'claude-agent-sdk');
  const modulePath = path.join(packageDir, 'sdk.mjs');
  const cliPath = path.join(packageDir, 'cli.js');
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk',
      version: '0.0.0-test',
      type: 'module',
      exports: {
        '.': {
          default: './sdk.mjs',
        },
      },
    }),
  );
  fs.writeFileSync(
    modulePath,
    `export function query() {
  throw new Error('query() should not be used for Claude CLI turn execution in this test');
}
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'status' && args[2] === '--json') {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    authMethod: 'claudeai',
    apiProvider: 'firstParty',
  }));
  process.exit(0);
} else if (args.includes('-p') && args.includes('--output-format') && args.includes('stream-json')) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdin += chunk;
  });
  process.stdin.on('end', () => {
  const sessionIdIndex = args.indexOf('--session-id');
  const resumeIndex = args.indexOf('--resume');
  const dangerous = args.includes('--dangerously-skip-permissions');
  const sessionId =
    (sessionIdIndex >= 0 ? args[sessionIdIndex + 1] : null) ||
    (resumeIndex >= 0 ? args[resumeIndex + 1] : null) ||
    '33333333-3333-3333-3333-333333333333';
  const mode = resumeIndex >= 0 ? 'resume' : 'new';
  process.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-sonnet-test',
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'content_block_start',
    index: 0,
    session_id: sessionId,
    content_block: {
      type: 'thinking',
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    session_id: sessionId,
    delta: {
      type: 'thinking_delta',
      thinking: 'analyze request ',
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'content_block_start',
    index: 1,
    session_id: sessionId,
    content_block: {
      type: 'tool_use',
      id: 'toolu_runtime',
      name: 'bash',
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'content_block_delta',
    index: 1,
    session_id: sessionId,
    delta: {
      type: 'input_json_delta',
      partial_json: '{\"cmd\":\"pwd\"}',
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'content_block_stop',
    index: 1,
    session_id: sessionId,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: \`\${mode}:\${sessionId}:\${stdin.includes('Runtime context:') ? 'bootstrap' : 'raw'}:\${dangerous ? 'dangerous' : 'safe'}\`,
  }) + '\\n');
  process.exit(0);
  });
  process.stdin.resume();
} else {
  process.stderr.write(\`unexpected args: \${args.join(' ')}\\n\`);
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  return path.join(packageDir, 'package.json');
}

function resolveFakeClaudeCliPath(packageJsonPath) {
  return path.join(path.dirname(packageJsonPath), 'cli.js');
}

async function withEnv(entries, callback) {
  const keys = Object.keys(entries);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(entries)) {
    process.env[key] = value;
  }

  try {
    await callback();
  } finally {
    for (const key of keys) {
      const original = previous.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
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

test('tribunal channel can use role-specific workspaces', async () => {
  const projectRoot = createProject();
  const baseWorkspacePath = path.join(projectRoot, 'workspace');
  const ownerWorkspacePath = path.join(projectRoot, 'owner-space');
  const reviewerWorkspacePath = path.join(projectRoot, 'reviewer-space');
  const arbiterWorkspacePath = path.join(projectRoot, 'arbiter-space');
  fs.mkdirSync(baseWorkspacePath, { recursive: true });
  fs.mkdirSync(ownerWorkspacePath, { recursive: true });
  fs.mkdirSync(reviewerWorkspacePath, { recursive: true });
  fs.mkdirSync(arbiterWorkspacePath, { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    command: `node ${inspectFixturePath}`,
  });
  config.agents.reviewer = buildAgentDefinition(projectRoot, 'reviewer', {
    name: 'reviewer',
    agent: 'command',
    command: `node ${inspectFixturePath}`,
  });
  config.agents.arbiter = buildAgentDefinition(projectRoot, 'arbiter', {
    name: 'arbiter',
    agent: 'command',
    command: `node ${inspectFixturePath}`,
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    mode: 'tribunal',
    discordChannelId: '123',
    workspace: 'workspace',
    ownerWorkspace: 'owner-space',
    reviewerWorkspace: 'reviewer-space',
    arbiterWorkspace: 'arbiter-space',
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
    prompt: 'inspect runtime',
    workdir: baseWorkspacePath,
    onRoleMessage: async (entry) => {
      events.push({
        role: entry.role,
        content: entry.content,
      });
    },
  });

  assert.equal(result.role, 'arbiter');
  assert.match(events.find((entry) => entry.role === 'owner')?.content || '', new RegExp(`workdir=${ownerWorkspacePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
  assert.match(events.find((entry) => entry.role === 'reviewer')?.content || '', new RegExp(`workdir=${reviewerWorkspacePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
  assert.match(events.find((entry) => entry.role === 'arbiter')?.content || '', new RegExp(`workdir=${arbiterWorkspacePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
});

test('single channel reuses Claude CLI sessions per channel role', async () => {
  const projectRoot = createProject();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'claude-code',
    model: 'claude-sonnet-4-6',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    mode: 'single',
    discordChannelId: '123',
    workspace: 'workspace',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const fakePackageJson = createFakeClaudeAgentSdkBundle();
  const fakeCliPath = resolveFakeClaudeCliPath(fakePackageJson);
  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_CLI: fakeCliPath,
    },
    async () => {
      const loaded = loadConfig(projectRoot);
      const channel = getChannel(loaded, 'main');

      const first = await executeChannelTurn({
        projectRoot,
        config: loaded,
        channel,
        prompt: 'first',
        workdir: workspacePath,
      });
      assert.match(first.content, /^new:[0-9a-f-]{36}:bootstrap:dangerous$/u);

      const sessionsAfterFirst = await listRuntimeRoleSessions(projectRoot, {
        channelName: 'main',
      });
      assert.equal(sessionsAfterFirst.length, 1);
      assert.equal(sessionsAfterFirst[0].runtimeBackend, 'claude-cli');
      assert.match(sessionsAfterFirst[0].runtimeSessionId || '', /^[0-9a-f-]{36}$/u);

      const second = await executeChannelTurn({
        projectRoot,
        config: loaded,
        channel,
        prompt: 'second',
        workdir: workspacePath,
      });
      assert.equal(
        second.content,
        `resume:${sessionsAfterFirst[0].runtimeSessionId}:raw:dangerous`,
      );

      const sessionsAfterSecond = await listRuntimeRoleSessions(projectRoot, {
        channelName: 'main',
      });
      assert.equal(sessionsAfterSecond[0].runtimeSessionId, sessionsAfterFirst[0].runtimeSessionId);
      assert.equal(sessionsAfterSecond[0].runCount, 2);
    },
  );
});

test('single channel reuses external Claude CLI sessions per channel role', async () => {
  const projectRoot = createProject();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'claude-code',
    model: 'claude-sonnet-4-6',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    mode: 'single',
    discordChannelId: '123',
    workspace: 'workspace',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const fakePackageJson = createFakeClaudeAgentSdkBundle();
  const fakeCliPath = resolveFakeClaudeCliPath(fakePackageJson);
  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_CLI: fakeCliPath,
    },
    async () => {
      const loaded = loadConfig(projectRoot);
      const channel = getChannel(loaded, 'main');

      const first = await executeChannelTurn({
        projectRoot,
        config: loaded,
        channel,
        prompt: 'first',
        workdir: workspacePath,
      });
      assert.match(first.content, /^new:[0-9a-f-]{36}:bootstrap:dangerous$/u);

      const sessionsAfterFirst = await listRuntimeRoleSessions(projectRoot, {
        channelName: 'main',
      });
      assert.equal(sessionsAfterFirst.length, 1);
      assert.equal(sessionsAfterFirst[0].runtimeBackend, 'claude-cli');
      assert.match(sessionsAfterFirst[0].runtimeSessionId || '', /^[0-9a-f-]{36}$/u);

      const second = await executeChannelTurn({
        projectRoot,
        config: loaded,
        channel,
        prompt: 'second',
        workdir: workspacePath,
      });
      assert.equal(
        second.content,
        `resume:${sessionsAfterFirst[0].runtimeSessionId}:raw:dangerous`,
      );

      const sessionsAfterSecond = await listRuntimeRoleSessions(projectRoot, {
        channelName: 'main',
      });
      assert.equal(sessionsAfterSecond[0].runtimeSessionId, sessionsAfterFirst[0].runtimeSessionId);
      assert.equal(sessionsAfterSecond[0].runCount, 2);
    },
  );
});

test('single channel forwards Claude stream events with role metadata', async () => {
  const projectRoot = createProject();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'claude-code',
    model: 'claude-sonnet-4-6',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    mode: 'single',
    discordChannelId: '123',
    workspace: 'workspace',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const fakePackageJson = createFakeClaudeAgentSdkBundle();
  const fakeCliPath = resolveFakeClaudeCliPath(fakePackageJson);
  const streamEvents = [];
  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_CLI: fakeCliPath,
    },
    async () => {
      const loaded = loadConfig(projectRoot);
      const channel = getChannel(loaded, 'main');

      await executeChannelTurn({
        projectRoot,
        config: loaded,
        channel,
        prompt: 'stream this',
        workdir: workspacePath,
        onStreamEvent: async (event) => {
          streamEvents.push(event);
        },
      });
    },
  );

  assert.deepEqual(
    streamEvents.map((event) => ({
      role: event.role,
      agentName: event.agentName,
      agentType: event.agentType,
      kind: event.kind,
      phase: event.phase || null,
      toolName: event.toolName || null,
      text: event.text || '',
    })),
    [
      {
        role: 'owner',
        agentName: 'owner',
        agentType: 'claude-code',
        kind: 'thinking',
        phase: null,
        toolName: null,
        text: 'analyze request ',
      },
      {
        role: 'owner',
        agentName: 'owner',
        agentType: 'claude-code',
        kind: 'tool',
        phase: 'start',
        toolName: 'bash',
        text: '',
      },
      {
        role: 'owner',
        agentName: 'owner',
        agentType: 'claude-code',
        kind: 'tool',
        phase: 'input',
        toolName: 'bash',
        text: '{"cmd":"pwd"}',
      },
      {
        role: 'owner',
        agentName: 'owner',
        agentType: 'claude-code',
        kind: 'tool',
        phase: 'stop',
        toolName: 'bash',
        text: '',
      },
    ],
  );
});
