import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { saveCiWatcher } from '../src/ci-watch-store.js';
import { buildPromptEnvelope } from '../src/prompt.js';
import { DEFAULT_CHANNEL_WORKSPACE } from '../src/constants.js';

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, 'bin', 'hkclaw-lite.js');
const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'echo-assistant.mjs');
const failFixturePath = path.join(repoRoot, 'test', 'fixtures', 'fail-agent.mjs');
const inspectFixturePath = path.join(repoRoot, 'test', 'fixtures', 'inspect-agent.mjs');
const blockingReviewerFixturePath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'blocking-reviewer.mjs',
);
const arbiterFixturePath = path.join(repoRoot, 'test', 'fixtures', 'arbiter-agent.mjs');
const invalidReviewerFixturePath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'invalid-reviewer.mjs',
);

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
  skills = '',
  contextFiles = '',
  fallbackAgent = '',
  env = '',
  command = `node ${fixturePath}`,
} = {}) {
  return [
    name,
    '5',
    '',
    '',
    '',
    '',
    '',
    skills,
    contextFiles,
    fallbackAgent,
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
  answers.push('', '');
  return answers.join('\n');
}

function buildChannelAnswers({
  name = 'discord-main',
  discordChannelId = '123456789012345678',
  guildId = '987654321098765432',
  workspace = DEFAULT_CHANNEL_WORKSPACE,
  channelMode = '1',
  agentChoice = '1',
  reviewer = '',
  arbiter = '',
  reviewRounds = '',
  description = '',
} = {}) {
  const answers = [name, discordChannelId, guildId, workspace, channelMode, agentChoice];
  if (channelMode === '2' || channelMode === 'tribunal') {
    answers.push(reviewer, arbiter, reviewRounds);
  }
  answers.push(description);
  return answers.join('\n');
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

test('add agent and channel use question flow and store mapping', () => {
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
  assert.equal('workdir' in agent, false);

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
  assert.equal(channel.mode, 'single');
  assert.equal(channel.agent, 'worker');
  assert.equal(channel.discordChannelId, '123456789012345678');
  assert.equal(channel.workspace, DEFAULT_CHANNEL_WORKSPACE);
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

test('run command executes a mapped channel and status renders agents and channels', () => {
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

  const run = runCli(cwd, ['run', '--channel', 'discord-main', '--message', 'hello']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /response=HELLO/u);

  const status = runCli(cwd, ['status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /agents=1/u);
  assert.match(status.stdout, /channels=1/u);
  assert.match(status.stdout, /worker/u);
  assert.match(status.stdout, /mapped=discord-main/u);
  assert.match(status.stdout, /workspaces=~/u);
  assert.match(status.stdout, /type=command/u);

  const channelStatus = runCli(cwd, ['status', 'channel', 'discord-main']);
  assert.equal(channelStatus.status, 0, channelStatus.stderr);
  assert.match(channelStatus.stdout, /mode=single/u);
  assert.match(channelStatus.stdout, /agent=worker/u);
  assert.match(channelStatus.stdout, /discordChannelId=123456789012345678/u);
  assert.match(channelStatus.stdout, /workspace=~/u);
});

test('help omits chat and session commands and documents the admin port', () => {
  const cwd = createProject();
  const help = runCli(cwd, ['help']);

  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /hkclaw-lite chat /u);
  assert.doesNotMatch(help.stdout, /hkclaw-lite session /u);
  assert.match(help.stdout, /hkclaw-lite run /u);
  assert.match(help.stdout, /hkclaw-lite admin \[--root DIR\] \[--host 127\.0\.0\.1\] \[--port 4622\]/u);
  assert.match(help.stdout, /hkclaw-lite discord serve \[--root DIR\] \[--env-file \.env\]/u);
});

test('run command injects prompt envelope, raw prompt, and channel workspace', () => {
  const cwd = createProject();
  const skillDir = path.join(cwd, 'skills', 'reviewer');
  const contextDir = path.join(cwd, 'context');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Reviewer Skill\n');
  fs.writeFileSync(path.join(contextDir, 'workspace.md'), 'workspace context\n');

  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'worker',
        skills: 'skills/reviewer',
        contextFiles: 'context/workspace.md',
        command: `node ${inspectFixturePath}`,
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'channel'], {
      input: buildChannelAnswers({
        name: 'discord-main',
        workspace: '.',
        agentChoice: '1',
      }),
    }).status,
    0,
  );

  const result = runCli(cwd, ['run', '--channel', 'discord-main', '--message', 'inspect me']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /hasSkills=true/u);
  assert.match(result.stdout, /hasContext=true/u);
  assert.match(result.stdout, /hasRuntime=true/u);
  assert.match(result.stdout, /hasSession=false/u);
  assert.match(result.stdout, /hasChannel=true/u);
  assert.match(result.stdout, /raw=inspect me/u);
  assert.match(
    result.stdout,
    new RegExp(`workdir=${cwd.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'),
  );
});

test('run command injects recent owner session history on repeated channel turns', () => {
  const cwd = createProject();

  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'worker',
        env: 'HKCLAW_LITE_EXPECT_HISTORY_NEEDLE=first request for memory',
        command: `node ${inspectFixturePath}`,
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'channel'], {
      input: buildChannelAnswers({
        name: 'discord-main',
        workspace: '.',
        agentChoice: '1',
      }),
    }).status,
    0,
  );

  const first = runCli(cwd, ['run', '--channel', 'discord-main', '--message', 'first request for memory']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /hasSession=false/u);

  const second = runCli(cwd, ['run', '--channel', 'discord-main', '--message', 'second request now']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /hasSession=true/u);
  assert.match(second.stdout, /hasHistoryNeedle=true/u);
  assert.match(second.stdout, /raw=second request now/u);
});

test('run command falls back to fallbackAgent when the primary agent fails', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'backup',
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'primary',
        fallbackAgent: 'backup',
        command: `node ${failFixturePath}`,
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'channel'], {
      input: buildChannelAnswers({
        name: 'discord-main',
        agentChoice: 'primary',
      }),
    }).status,
    0,
  );

  const result = runCli(cwd, ['run', '--channel', 'discord-main', '--message', 'fallback please']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /response=FALLBACK PLEASE/u);
});

test('run command routes direct owner execution through tribunal channel policy', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'owner',
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'reviewer',
        command: `node ${blockingReviewerFixturePath}`,
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'arbiter',
        command: `node ${arbiterFixturePath}`,
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'channel'], {
      input: buildChannelAnswers({
        name: 'tribunal-main',
        channelMode: '2',
        agentChoice: 'owner',
        reviewer: 'reviewer',
        arbiter: 'arbiter',
        reviewRounds: '1',
      }),
    }).status,
    0,
  );

  const result = runCli(cwd, ['run', 'owner', '--message', 'decide now']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /arbiter-final/u);
});

test('run command routes invalid reviewer verdicts to the arbiter', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'owner',
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'reviewer',
        command: `node ${invalidReviewerFixturePath}`,
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'arbiter',
        command: `node ${arbiterFixturePath}`,
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'channel'], {
      input: buildChannelAnswers({
        name: 'tribunal-main',
        channelMode: '2',
        agentChoice: 'owner',
        reviewer: 'reviewer',
        arbiter: 'arbiter',
        reviewRounds: '2',
      }),
    }).status,
    0,
  );

  const result = runCli(cwd, ['run', '--channel', 'tribunal-main', '--message', 'decide now']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /arbiter-final/u);
});

test('legacy agent workdir migrates to channel workspace on load', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);

  const legacyWorkdir = path.join(cwd, 'legacy-space');
  fs.mkdirSync(legacyWorkdir, { recursive: true });

  const configPath = path.join(cwd, '.hkclaw-lite', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.agents.worker = {
    agent: 'command',
    command: `node ${fixturePath}`,
    workdir: 'legacy-space',
  };
  config.channels.main = {
    discordChannelId: '123456789012345678',
    agent: 'worker',
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const showAgent = runCli(cwd, ['show', 'agent', 'worker']);
  assert.equal(showAgent.status, 0, showAgent.stderr);
  assert.equal('workdir' in JSON.parse(showAgent.stdout), false);

  const showChannel = runCli(cwd, ['show', 'channel', 'main']);
  assert.equal(showChannel.status, 0, showChannel.stderr);
  assert.equal(JSON.parse(showChannel.stdout).mode, 'single');
  assert.equal(JSON.parse(showChannel.stdout).workspace, 'legacy-space');
});

test('shared env can be managed from CLI', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, ['env', 'set', 'GITHUB_TOKEN=global-gh', 'GITLAB_TOKEN=global-gl']).status,
    0,
  );

  const envList = runCli(cwd, ['env', 'list']);
  assert.equal(envList.status, 0, envList.stderr);
  assert.match(envList.stdout, /GITHUB_TOKEN=global-gh/u);
  assert.match(envList.stdout, /GITLAB_TOKEN=global-gl/u);

  const unset = runCli(cwd, ['env', 'unset', 'GITLAB_TOKEN']);
  assert.equal(unset.status, 0, unset.stderr);
  const envListAfterUnset = runCli(cwd, ['env', 'list']);
  assert.equal(envListAfterUnset.status, 0, envListAfterUnset.stderr);
  assert.doesNotMatch(envListAfterUnset.stdout, /GITLAB_TOKEN=/u);
});

test('agent fallback is stored and shown in status', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'backup',
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'primary',
        fallbackAgent: 'backup',
        command: `node ${failFixturePath}`,
      }),
    }).status,
    0,
  );

  const showAgent = runCli(cwd, ['show', 'agent', 'primary']);
  assert.equal(showAgent.status, 0, showAgent.stderr);
  const agent = JSON.parse(showAgent.stdout);
  assert.equal(agent.fallbackAgent, 'backup');

  const status = runCli(cwd, ['status', 'agent', 'primary']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /fallback=backup/u);
});

test('remove agent blocks fallback references', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'backup',
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'primary',
        fallbackAgent: 'backup',
        command: `node ${failFixturePath}`,
      }),
    }).status,
    0,
  );

  const remove = runCli(cwd, ['remove', 'agent', 'backup', '--yes']);
  assert.notEqual(remove.status, 0);
  assert.match(remove.stderr, /fallback agents: primary/u);
});

test('tribunal channel stores reviewer and arbiter config', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'owner',
        command: `node ${fixturePath}`,
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'reviewer',
        command: `node ${fixturePath}`,
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'arbiter',
        command: `node ${fixturePath}`,
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(cwd, ['add', 'channel'], {
      input: buildChannelAnswers({
        name: 'tribunal-main',
        channelMode: '2',
        agentChoice: 'owner',
        reviewer: 'reviewer',
        arbiter: 'arbiter',
        reviewRounds: '2',
      }),
    }).status,
    0,
  );

  const channelStatus = runCli(cwd, ['status', 'channel', 'tribunal-main']);
  assert.equal(channelStatus.status, 0, channelStatus.stderr);
  assert.match(channelStatus.stdout, /mode=tribunal/u);
  assert.match(channelStatus.stdout, /reviewer=reviewer/u);
  assert.match(channelStatus.stdout, /reviewRounds=2/u);
});

test('add agent stores skill paths and context files', () => {
  const cwd = createProject();
  const skillDir = path.join(cwd, 'skills', 'reviewer');
  const contextDir = path.join(cwd, 'context');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '# Reviewer Skill\n\nAlways explain the relevant tradeoff.\n',
  );
  fs.writeFileSync(
    path.join(contextDir, 'workspace.md'),
    'Monorepo layout:\n- apps/web\n- packages/api\n',
  );

  assert.equal(runCli(cwd, ['init']).status, 0);

  const addAgent = runCli(cwd, ['add', 'agent'], {
    input: buildCommandAgentAnswers({
      name: 'worker',
      skills: 'skills/reviewer',
      contextFiles: 'context/workspace.md',
    }),
  });
  assert.equal(addAgent.status, 0, addAgent.stderr);

  const showAgent = runCli(cwd, ['show', 'agent', 'worker']);
  assert.equal(showAgent.status, 0, showAgent.stderr);
  const agent = JSON.parse(showAgent.stdout);
  assert.deepEqual(agent.skills, ['skills/reviewer']);
  assert.deepEqual(agent.contextFiles, ['context/workspace.md']);
});

test('prompt envelope injects skills and baseline context separately', () => {
  const cwd = createProject();
  const skillDir = path.join(cwd, 'skills', 'reviewer');
  const contextDir = path.join(cwd, 'context');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '# Reviewer Skill\n\nAlways explain the relevant tradeoff.\n',
  );
  fs.writeFileSync(
    path.join(contextDir, 'workspace.md'),
    'Monorepo layout:\n- apps/web\n- packages/api\n',
  );

  const prompt = buildPromptEnvelope({
    projectRoot: cwd,
    agent: {
      name: 'worker',
      agent: 'command',
      skills: ['skills/reviewer'],
      contextFiles: ['context/workspace.md'],
    },
    channel: {
      name: 'discord-main',
      discordChannelId: '123',
      workspace: '.',
    },
    userPrompt: 'review the API package',
  });

  assert.match(prompt, /Installed skills:/u);
  assert.match(prompt, /Reviewer Skill/u);
  assert.match(prompt, /Always explain the relevant tradeoff\./u);
  assert.match(prompt, /Baseline context:/u);
  assert.match(prompt, /Monorepo layout:/u);
  assert.match(prompt, /packages\/api/u);
  assert.match(prompt, /workdir:/u);
});

test('backup export and import restore config, project assets, and watcher state', () => {
  const source = createProject();
  const destination = createProject();
  const skillDir = path.join(source, 'skills', 'reviewer');
  const contextDir = path.join(source, 'context');
  const workdir = path.join(source, 'workspace');
  const backupPath = path.join(source, 'backups', 'project.json');

  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Reviewer Skill\n');
  fs.writeFileSync(path.join(contextDir, 'workspace.md'), 'workspace context\n');

  assert.equal(runCli(source, ['init']).status, 0);
  assert.equal(
    runCli(source, ['env', 'set', 'GITHUB_TOKEN=backup-gh']).status,
    0,
  );
  assert.equal(
    runCli(source, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'worker',
        skills: 'skills/reviewer',
        contextFiles: 'context/workspace.md',
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(source, ['add', 'channel'], {
      input: buildChannelAnswers({
        name: 'discord-main',
        workspace: 'workspace',
        agentChoice: '1',
      }),
    }).status,
    0,
  );

  saveCiWatcher(source, {
    id: 'ci-demo',
    provider: 'github',
    label: 'owner/repo#1',
    request: {
      repo: 'owner/repo',
      runId: '1',
    },
    status: 'completed',
    updatedAt: '2026-04-06T00:00:00.000Z',
    resultSummary: 'completed',
    completionMessage: 'completed',
  });
  fs.writeFileSync(
    path.join(source, '.hkclaw-lite', 'watchers', 'ci-demo.log'),
    'watch log\n',
  );

  const exportResult = runCli(source, ['backup', 'export', backupPath]);
  assert.equal(exportResult.status, 0, exportResult.stderr);
  assert.equal(fs.existsSync(backupPath), true);

  const importResult = runCli(destination, ['backup', 'import', backupPath]);
  assert.equal(importResult.status, 0, importResult.stderr);

  const showAgent = runCli(destination, ['show', 'agent', 'worker']);
  assert.equal(showAgent.status, 0, showAgent.stderr);
  const importedAgent = JSON.parse(showAgent.stdout);
  assert.deepEqual(importedAgent.skills, ['skills/reviewer']);
  assert.deepEqual(importedAgent.contextFiles, ['context/workspace.md']);

  const envList = runCli(destination, ['env', 'list']);
  assert.equal(envList.status, 0, envList.stderr);
  assert.match(envList.stdout, /GITHUB_TOKEN=backup-gh/u);

  assert.equal(
    fs.readFileSync(path.join(destination, 'skills', 'reviewer', 'SKILL.md'), 'utf8'),
    '# Reviewer Skill\n',
  );
  assert.equal(
    fs.readFileSync(path.join(destination, 'context', 'workspace.md'), 'utf8'),
    'workspace context\n',
  );
  assert.equal(fs.statSync(path.join(destination, 'workspace')).isDirectory(), true);
  assert.equal(
    fs.readFileSync(path.join(destination, '.hkclaw-lite', 'watchers', 'ci-demo.log'), 'utf8'),
    'watch log\n',
  );

  const watcherList = runCli(destination, ['ci', 'list']);
  assert.equal(watcherList.status, 0, watcherList.stderr);
  assert.match(watcherList.stdout, /ci-demo/u);
});

test('migrate copies hkclaw-lite state from another project root', () => {
  const source = createProject();
  const destination = createProject();
  const workdir = path.join(source, 'workspace');
  fs.mkdirSync(workdir, { recursive: true });

  assert.equal(runCli(source, ['init']).status, 0);
  assert.equal(
    runCli(source, ['env', 'set', 'GITLAB_TOKEN=migrate-gl']).status,
    0,
  );
  assert.equal(
    runCli(source, ['add', 'agent'], {
      input: buildCommandAgentAnswers({
        name: 'worker',
      }),
    }).status,
    0,
  );
  assert.equal(
    runCli(source, ['add', 'channel'], {
      input: buildChannelAnswers({
        name: 'discord-main',
        workspace: 'workspace',
        agentChoice: '1',
      }),
    }).status,
    0,
  );

  const migrateResult = runCli(destination, ['migrate', '--from', source]);
  assert.equal(migrateResult.status, 0, migrateResult.stderr);

  const showChannel = runCli(destination, ['show', 'channel', 'discord-main']);
  assert.equal(showChannel.status, 0, showChannel.stderr);
  assert.equal(JSON.parse(showChannel.stdout).mode, 'single');
  assert.equal(JSON.parse(showChannel.stdout).workspace, 'workspace');

  const envList = runCli(destination, ['env', 'list']);
  assert.equal(envList.status, 0, envList.stderr);
  assert.match(envList.stdout, /GITLAB_TOKEN=migrate-gl/u);
  assert.equal(fs.statSync(path.join(destination, 'workspace')).isDirectory(), true);
});
