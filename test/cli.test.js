import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, 'bin', 'hkclaw-lite.js');
const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'echo-assistant.mjs');

function createProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-test-'));
}

function runCli(cwd, args, options = {}) {
  return spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    input: options.input,
  });
}

function buildCommandAgentAnswers({
  name = 'worker',
  env = '',
  command = `node ${fixturePath}`,
} = {}) {
  return [
    name,
    '5',
    '.',
    '',
    '',
    '',
    '',
    '',
    '',
    env,
    command,
    '',
  ].join('\n');
}

function buildDashboardAnswers({
  name = 'ops',
  scope = '1',
  monitors = '',
} = {}) {
  const answers = [name, scope];
  if (scope === '2') {
    answers.push(monitors);
  }
  answers.push('', '', '');
  return answers.join('\n');
}

function buildChannelAnswers({
  name = 'discord-main',
  discordChannelId = '123456789012345678',
  guildId = '987654321098765432',
  agentChoice = '1',
  description = '',
} = {}) {
  return [name, discordChannelId, guildId, agentChoice, description].join('\n');
}

test('init creates v3 project metadata', () => {
  const cwd = createProject();
  const result = runCli(cwd, ['init']);

  assert.equal(result.status, 0, result.stderr);
  const configPath = path.join(cwd, '.hkclaw-lite', 'config.json');
  assert.equal(fs.existsSync(configPath), true);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.version, 3);
  assert.deepEqual(config.agents, {});
  assert.deepEqual(config.channels, {});
  assert.deepEqual(config.dashboards, {});
});

test('add agent and channel use question flow and channel chat persists transcript', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);

  const addAgent = runCli(cwd, ['add', 'agent'], {
    input: buildCommandAgentAnswers({
      name: 'worker',
      env: 'FOO=bar',
    }),
  });
  assert.equal(addAgent.status, 0, addAgent.stderr);
  assert.match(addAgent.stdout, /Added agent "worker"/u);

  const showAgent = runCli(cwd, ['show', 'agent', 'worker']);
  assert.equal(showAgent.status, 0, showAgent.stderr);
  const agent = JSON.parse(showAgent.stdout);
  assert.equal(agent.agent, 'command');
  assert.equal(agent.env.FOO, 'bar');

  const addChannel = runCli(cwd, ['add', 'channel'], {
    input: buildChannelAnswers({
      name: 'discord-main',
      agentChoice: '1',
      description: 'main discord room',
    }),
  });
  assert.equal(addChannel.status, 0, addChannel.stderr);
  assert.match(addChannel.stdout, /Added channel "discord-main"/u);

  const showChannel = runCli(cwd, ['show', 'channel', 'discord-main']);
  assert.equal(showChannel.status, 0, showChannel.stderr);
  const channel = JSON.parse(showChannel.stdout);
  assert.equal(channel.agent, 'worker');
  assert.equal(channel.discordChannelId, '123456789012345678');

  const first = runCli(cwd, ['chat', '--channel', 'discord-main', '--message', 'first turn']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /response=FIRST TURN/u);

  const second = runCli(cwd, ['chat', '--channel', 'discord-main', '--message', 'second turn']);
  assert.equal(second.status, 0, second.stderr);

  const sessionShow = runCli(cwd, ['session', 'show', 'worker', 'channel-discord-main']);
  assert.equal(sessionShow.status, 0, sessionShow.stderr);
  assert.match(sessionShow.stdout, /agent=worker/u);
  assert.match(sessionShow.stdout, /first turn/u);
  assert.match(sessionShow.stdout, /second turn/u);
});

test('add dashboard and edit agent keep dashboard references aligned', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);

  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({ name: 'worker' }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'channel'], {
      input: buildChannelAnswers({ name: 'discord-main', agentChoice: '1' }),
    }).status,
    0,
  );

  const addDashboard = runCli(cwd, ['add', 'dashboard'], {
    input: buildDashboardAnswers({
      name: 'ops',
      scope: '2',
      monitors: 'worker',
    }),
  });
  assert.equal(addDashboard.status, 0, addDashboard.stderr);

  const editAgent = runCli(cwd, ['edit', 'agent', 'worker'], {
    input: [
      'worker-renamed',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ].join('\n'),
  });
  assert.equal(editAgent.status, 0, editAgent.stderr);

  const showDashboard = runCli(cwd, ['show', 'dashboard', 'ops']);
  assert.equal(showDashboard.status, 0, showDashboard.stderr);
  const dashboard = JSON.parse(showDashboard.stdout);
  assert.deepEqual(dashboard.monitors, ['worker-renamed']);

  const showChannel = runCli(cwd, ['show', 'channel', 'discord-main']);
  assert.equal(showChannel.status, 0, showChannel.stderr);
  const channel = JSON.parse(showChannel.stdout);
  assert.equal(channel.agent, 'worker-renamed');

  const renderDashboard = runCli(cwd, ['dashboard', 'ops', '--once']);
  assert.equal(renderDashboard.status, 0, renderDashboard.stderr);
  assert.match(renderDashboard.stdout, /worker-renamed/u);
  assert.match(renderDashboard.stdout, /discord-main/u);
});

test('run command is removed and status renders agents and channels', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({ name: 'worker' }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'channel'], {
      input: buildChannelAnswers({ name: 'discord-main', agentChoice: '1' }),
    }).status,
    0,
  );

  const removedRun = runCli(cwd, ['run', 'worker', 'hello']);
  assert.notEqual(removedRun.status, 0);
  assert.match(removedRun.stderr, /run command was removed/u);

  const status = runCli(cwd, ['status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /agents=1/u);
  assert.match(status.stdout, /channels=1/u);
  assert.match(status.stdout, /worker/u);
  assert.match(status.stdout, /mapped=discord-main/u);
  assert.match(status.stdout, /type=command/u);

  const channelStatus = runCli(cwd, ['status', 'channel', 'discord-main']);
  assert.equal(channelStatus.status, 0, channelStatus.stderr);
  assert.match(channelStatus.stdout, /agent=worker/u);
  assert.match(channelStatus.stdout, /discordChannelId=123456789012345678/u);
});
