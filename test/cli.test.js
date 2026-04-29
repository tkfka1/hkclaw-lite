import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { saveCiWatcher } from '../src/ci-watch-store.js';
import { buildPromptEnvelope } from '../src/prompt.js';
import { DEFAULT_CHANNEL_WORKSPACE } from '../src/constants.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  buildConnectorDefinition,
  initProject,
  loadConfig,
  saveConfig,
} from '../src/store.js';

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
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
  });
}

function buildCommandAgentAnswers({
  name = 'worker',
  platformChoice = '1',
  platformToken = 'discord-token',
  skills = '',
  contextFiles = '',
  fallbackAgent = '',
  command = `node ${fixturePath}`,
} = {}) {
  return [
    name,
    '5',
    platformChoice,
    '',
    '',
    '',
    '',
    '',
    skills,
    contextFiles,
    fallbackAgent,
    platformToken,
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
  platformChoice = '1',
  discordChannelId = '123456789012345678',
  guildId = '987654321098765432',
  telegramChatId = '-1001234567890',
  telegramThreadId = '',
  connectorChoice = '',
  workspace = DEFAULT_CHANNEL_WORKSPACE,
  channelMode = '1',
  agentChoice = '1',
  reviewer = '',
  arbiter = '',
  reviewRounds = '',
  description = '',
} = {}) {
  const answers = [name, platformChoice];
  answers.push(connectorChoice);
  if (platformChoice === '2') {
    answers.push(telegramChatId, telegramThreadId);
  } else {
    answers.push(discordChannelId, guildId);
  }
  answers.push(workspace, channelMode, agentChoice);
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
  assert.deepEqual(config.connectors, {});
  assert.deepEqual(config.agents, {});
  assert.deepEqual(config.channels, {});
  assert.deepEqual(config.dashboards, {});
});

test('channels can reference a reusable messaging connector', () => {
  const cwd = createProject();
  initProject(cwd);
  assert.equal(
    buildConnectorDefinition('inferredKakao', {
      kakaoRelayUrl: 'https://relay.example/',
    }).type,
    'kakao',
  );
  assert.throws(
    () =>
      buildConnectorDefinition('discordMain', {
        type: 'discord',
        discordToken: 'discord-token',
      }),
    /KakaoTalk-only/u,
  );
  const config = loadConfig(cwd);
  config.agents.owner = buildAgentDefinition(cwd, 'owner', {
    name: 'owner',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'discord',
  });
  const directDiscordChannel = buildChannelDefinition(cwd, config, 'discordDm', {
    targetType: 'direct',
    discordUserId: '111222333444555666',
    workspace: '~',
    agent: 'owner',
  });
  assert.equal(directDiscordChannel.targetType, 'direct');
  assert.equal(directDiscordChannel.discordUserId, '111222333444555666');
  assert.equal(directDiscordChannel.discordChannelId, undefined);
  const directTelegramChannel = buildChannelDefinition(cwd, config, 'telegramDm', {
    platform: 'telegram',
    targetType: 'direct',
    telegramChatId: '987654321',
    telegramThreadId: 'should-clear',
    workspace: '~',
    agent: 'owner',
  });
  assert.equal(directTelegramChannel.targetType, 'direct');
  assert.equal(directTelegramChannel.telegramChatId, '987654321');
  assert.equal(directTelegramChannel.telegramThreadId, undefined);
  config.connectors.kakaoMain = buildConnectorDefinition('kakaoMain', {
    type: 'kakao',
    kakaoRelayUrl: 'https://relay.example/',
  });
  config.channels.kakao = buildChannelDefinition(cwd, config, 'kakao', {
    name: 'kakao',
    platform: 'kakao',
    connector: 'kakaoMain',
    kakaoChannelId: '*',
    workspace: '~',
    agent: 'owner',
  });
  saveConfig(cwd, config);

  const loaded = loadConfig(cwd);
  assert.equal(loaded.channels.kakao.connector, 'kakaoMain');
  assert.equal(loaded.connectors.kakaoMain.type, 'kakao');
  assert.throws(
    () =>
      buildChannelDefinition(cwd, loaded, 'kakao-duplicate', {
        name: 'kakao-duplicate',
        platform: 'kakao',
        connector: 'kakaoMain',
        kakaoChannelId: '*',
        workspace: '~',
        agent: 'owner',
      }),
    /overlaps with "kakao"/u,
  );

  const blockedRemove = runCli(cwd, ['remove', 'connector', 'kakaoMain', '--yes']);
  assert.notEqual(blockedRemove.status, 0);
  assert.match(blockedRemove.stderr, /referenced by channels: kakao/u);

  const editConnector = runCli(cwd, ['edit', 'connector', 'kakaoMain'], {
    input: ['kakaoOps', 'Ops Kakao account', 'https://relay2.example/', '', ''].join('\n'),
  });
  assert.equal(editConnector.status, 0, editConnector.stderr);

  const renamed = loadConfig(cwd);
  assert.equal(renamed.channels.kakao.connector, 'kakaoOps');
  assert.equal(renamed.connectors.kakaoOps.description, 'Ops Kakao account');
  assert.equal(renamed.connectors.kakaoMain, undefined);

  assert.equal(runCli(cwd, ['remove', 'channel', 'kakao', '--yes']).status, 0);
  assert.equal(runCli(cwd, ['remove', 'connector', 'kakaoOps', '--yes']).status, 0);
  assert.equal(loadConfig(cwd).connectors.kakaoOps, undefined);
});

test('topology plan and apply create reusable agent connector channel mappings', () => {
  const cwd = createProject();
  initProject(cwd);
  const topologyPath = path.join(cwd, 'topology.json');
  fs.writeFileSync(
    topologyPath,
    JSON.stringify(
      {
        version: 1,
        agents: [
          {
            name: 'auto-owner',
            agent: 'command',
            platform: 'kakao',
            command: `node ${fixturePath}`,
          },
        ],
        connectors: [
          {
            name: 'auto-kakao',
            type: 'kakao',
            description: 'test kakao connector',
            kakaoRelayUrl: 'https://relay.example/',
          },
        ],
        channels: [
          {
            name: 'auto-kakao-main',
            platform: 'kakao',
            connector: 'auto-kakao',
            kakaoChannelId: '*',
            workspace: '.',
            agent: 'auto-owner',
          },
        ],
      },
      null,
      2,
    ),
  );

  const plan = runCli(cwd, ['topology', 'plan', '--file', topologyPath]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /Topology plan: changes=3 actor=operator/u);
  assert.match(plan.stdout, /create agent "auto-owner"/u);
  assert.match(plan.stdout, /create connector "auto-kakao"/u);
  assert.match(plan.stdout, /create channel "auto-kakao-main"/u);
  assert.deepEqual(loadConfig(cwd).agents, {});

  const apply = runCli(cwd, ['topology', 'apply', '--file', topologyPath, '--yes']);
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Topology apply: changes=3 actor=operator/u);

  const config = loadConfig(cwd);
  assert.equal(config.agents['auto-owner'].agent, 'command');
  assert.equal(config.connectors['auto-kakao'].type, 'kakao');
  assert.equal(config.channels['auto-kakao-main'].connector, 'auto-kakao');

  const secondApply = runCli(cwd, ['topology', 'apply', '--file', topologyPath, '--yes']);
  assert.equal(secondApply.status, 0, secondApply.stderr);
  assert.match(secondApply.stdout, /Topology apply: changes=0 actor=operator/u);
  assert.match(secondApply.stdout, /noop agent "auto-owner"/u);

  const exported = runCli(cwd, ['topology', 'export']);
  assert.equal(exported.status, 0, exported.stderr);
  const exportedSpec = JSON.parse(exported.stdout);
  assert.equal(exportedSpec.version, 1);
  assert.equal(exportedSpec.agents[0].name, 'auto-owner');
  assert.equal(exportedSpec.connectors[0].name, 'auto-kakao');
  assert.equal(exportedSpec.channels[0].name, 'auto-kakao-main');
});

test('topology apply enforces agent management policy', () => {
  const cwd = createProject();
  initProject(cwd);
  const topologyPath = path.join(cwd, 'topology.json');
  fs.writeFileSync(
    topologyPath,
    JSON.stringify(
      {
        version: 1,
        agents: [
          {
            name: 'auto-target',
            agent: 'command',
            platform: 'discord',
            command: `node ${fixturePath}`,
          },
        ],
      },
      null,
      2,
    ),
  );

  const config = loadConfig(cwd);
  config.agents.manager = buildAgentDefinition(cwd, 'manager', {
    name: 'manager',
    agent: 'command',
    platform: 'discord',
    command: `node ${fixturePath}`,
  });
  saveConfig(cwd, config);

  const denied = runCli(cwd, ['topology', 'apply', '--file', topologyPath, '--yes'], {
    env: { HKCLAW_LITE_AGENT_NAME: 'manager' },
  });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /not allowed to apply topology changes/u);

  const allowedConfig = loadConfig(cwd);
  allowedConfig.agents.manager = buildAgentDefinition(cwd, 'manager', {
    ...allowedConfig.agents.manager,
    name: 'manager',
    managementPolicy: {
      canPlan: true,
      canApply: true,
      allowedActions: ['agent:upsert'],
      allowedNamePrefixes: ['auto-'],
      allowedPlatforms: ['discord'],
      maxChangesPerApply: 2,
    },
  });
  saveConfig(cwd, allowedConfig);

  const allowed = runCli(cwd, ['topology', 'apply', '--file', topologyPath, '--yes'], {
    env: { HKCLAW_LITE_AGENT_NAME: 'manager' },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /actor=agent:manager/u);
  assert.equal(loadConfig(cwd).agents['auto-target'].agent, 'command');
});

test('topology rejects inline secrets and redacts secret env refs', () => {
  const cwd = createProject();
  initProject(cwd);
  const inlinePath = path.join(cwd, 'inline-secret.json');
  fs.writeFileSync(
    inlinePath,
    JSON.stringify({
      version: 1,
      connectors: [
        {
          name: 'auto-kakao',
          type: 'kakao',
          kakaoRelayToken: 'super-secret-token',
        },
      ],
    }),
  );

  const inline = runCli(cwd, ['topology', 'plan', '--file', inlinePath]);
  assert.notEqual(inline.status, 0);
  assert.match(inline.stderr, /Inline secret field connectors\[0\]\.kakaoRelayToken is not allowed/u);

  const refPath = path.join(cwd, 'secret-ref.json');
  fs.writeFileSync(
    refPath,
    JSON.stringify({
      version: 1,
      connectors: [
        {
          name: 'auto-kakao',
          type: 'kakao',
          secretRefs: {
            kakaoRelayTokenEnv: 'HKCLAW_TEST_KAKAO_TOKEN',
          },
        },
      ],
    }),
  );

  const apply = runCli(cwd, ['topology', 'apply', '--file', refPath, '--yes'], {
    env: { HKCLAW_TEST_KAKAO_TOKEN: 'resolved-secret-token' },
  });
  assert.equal(apply.status, 0, apply.stderr);
  assert.doesNotMatch(apply.stdout, /resolved-secret-token/u);
  assert.equal(loadConfig(cwd).connectors['auto-kakao'].kakaoRelayToken, 'resolved-secret-token');

  const exported = runCli(cwd, ['topology', 'export']);
  assert.equal(exported.status, 0, exported.stderr);
  assert.doesNotMatch(exported.stdout, /resolved-secret-token/u);
  assert.match(exported.stdout, /"kakaoRelayToken": "\*\*\*"/u);
});

test('add agent auto-initializes project metadata when missing', () => {
  const cwd = createProject();

  const addAgent = runCli(cwd, ['add', 'agent'], {
    input: buildCommandAgentAnswers({
      name: 'worker',
    }),
  });

  assert.equal(addAgent.status, 0, addAgent.stderr);
  assert.match(addAgent.stdout, /Added agent "worker"/u);

  const configPath = path.join(cwd, '.hkclaw-lite', 'config.json');
  assert.equal(fs.existsSync(configPath), true);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.version, 3);
  assert.ok(config.agents.worker);
});

test('legacy Claude dangerous flag is normalized into bypassPermissions', () => {
  const cwd = createProject();

  const definition = buildAgentDefinition(cwd, 'claude-agent', {
    name: 'claude-agent',
    agent: 'claude-code',
    dangerous: true,
  });

  assert.equal(definition.permissionMode, 'bypassPermissions');
  assert.equal('dangerous' in definition, false);
});

test('add agent and channel use question flow and store mapping', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);

  const addAgent = runCli(cwd, ['add', 'agent'], {
    input: buildCommandAgentAnswers({
      name: 'worker',
    }),
  });
  assert.equal(addAgent.status, 0, addAgent.stderr);
  assert.match(addAgent.stdout, /Added agent "worker"/u);

  const showAgent = runCli(cwd, ['show', 'agent', 'worker']);
  assert.equal(showAgent.status, 0, showAgent.stderr);
  const agent = JSON.parse(showAgent.stdout);
  assert.equal(agent.agent, 'command');
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
  assert.match(help.stdout, /Most commands auto-create \.hkclaw-lite/u);
  assert.match(help.stdout, /Installing the package never starts a process by itself\./u);
  assert.match(help.stdout, /hkclaw-lite admin\s+Start the web admin server/u);
  assert.match(help.stdout, /hkclaw-lite run \.\.\.\s+Execute one one-shot turn/u);
  assert.match(help.stdout, /hkclaw-lite admin \[--root DIR\] \[--host 127\.0\.0\.1\] \[--port 5687\] \[--foreground\]/u);
  assert.match(help.stdout, /hkclaw-lite discord serve \[--root DIR\]/u);
});

test('admin command can delegate Homebrew installs to launchd service automatically', () => {
  const cwd = createProject();
  const fakeBrewPath = path.join(cwd, 'brew');
  const logPath = path.join(cwd, 'brew.log');
  fs.writeFileSync(
    fakeBrewPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexit 0\n`,
    { mode: 0o755 },
  );

  const result = runCli(cwd, ['admin'], {
    env: {
      HKCLAW_LITE_ADMIN_AUTO_SERVICE: 'always',
      HKCLAW_LITE_BREW_COMMAND: fakeBrewPath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Homebrew service started: hkclaw-lite/u);
  assert.match(result.stdout, /http:\/\/0\.0\.0\.0:5687/u);
  assert.match(fs.readFileSync(logPath, 'utf8'), /services start hkclaw-lite/u);
  assert.equal(fs.existsSync(path.join(cwd, '.hkclaw-lite', 'config.json')), false);
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
  assert.match(second.stdout, /hasHistoryNeedle=n\/a/u);
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

test('env command is rejected', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);
  const result = runCli(cwd, ['env', 'list']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /env command was removed/u);
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

test('prompt envelope injects topology guidance only for policy-enabled agents', () => {
  const cwd = createProject();
  const baseChannel = {
    name: 'discord-main',
    discordChannelId: '123',
    workspace: '.',
  };

  const unmanagedPrompt = buildPromptEnvelope({
    projectRoot: cwd,
    agent: {
      name: 'worker',
      agent: 'command',
    },
    channel: baseChannel,
    userPrompt: 'hello',
  });
  assert.doesNotMatch(unmanagedPrompt, /Topology management:/u);

  const managedPrompt = buildPromptEnvelope({
    projectRoot: cwd,
    agent: {
      name: 'manager',
      agent: 'command',
      managementPolicy: {
        canPlan: true,
        canApply: false,
      },
    },
    channel: baseChannel,
    userPrompt: 'hello',
  });
  assert.match(managedPrompt, /Topology management:/u);
  assert.match(managedPrompt, /hkclaw-lite topology plan --file/u);
  assert.match(managedPrompt, /not allowed to apply topology changes/u);
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
  assert.equal(fs.statSync(path.join(destination, 'workspace')).isDirectory(), true);
});
