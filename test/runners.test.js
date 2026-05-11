import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildCommandExecutionSpec,
  resolveManagedAgentCli,
  runAgentTurn,
} from '../src/runners.js';
import { resolveExecutable } from '../src/utils.js';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-runners-test-'));
}

function createFakeClaudeCli() {
  const dir = createTempDir();
  const scriptPath = path.join(dir, 'claude.mjs');
  fs.writeFileSync(
    scriptPath,
    `const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'status' && args[2] === '--json') {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    authMethod: 'claudeai',
    apiProvider: 'firstParty',
  }));
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'logout') {
  process.stdout.write('Logged out\\n');
  process.exit(0);
}

if (args.includes('-p') && args.includes('--output-format') && args.includes('stream-json')) {
  if (!args.includes('--verbose')) {
    process.stderr.write('missing --verbose\\n');
    process.exit(1);
  }
  const modelIndex = args.indexOf('--model');
  const permissionIndex = args.indexOf('--permission-mode');
  const sessionIdIndex = args.indexOf('--session-id');
  const resumeIndex = args.indexOf('--resume');
  const effortIndex = args.indexOf('--effort');
  const model = modelIndex >= 0 ? args[modelIndex + 1] : null;
  const permissionMode = permissionIndex >= 0 ? args[permissionIndex + 1] : null;
  const dangerous = args.includes('--dangerously-skip-permissions');
  const sessionId =
    (sessionIdIndex >= 0 ? args[sessionIdIndex + 1] : null) ||
    (resumeIndex >= 0 ? args[resumeIndex + 1] : null) ||
    '11111111-1111-1111-1111-111111111111';

  process.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: model || 'sonnet',
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
      thinking: 'first thought ',
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'content_block_start',
    index: 1,
    session_id: sessionId,
    content_block: {
      type: 'tool_use',
      id: 'toolu_test',
      name: 'bash',
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'content_block_delta',
    index: 1,
    session_id: sessionId,
    delta: {
      type: 'input_json_delta',
      partial_json: '{\"cmd\":\"ls\"}',
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'content_block_stop',
    index: 1,
    session_id: sessionId,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    session_id: sessionId,
    delta: {
      type: 'thinking_delta',
      thinking: 'second thought',
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'content_block_stop',
    index: 0,
    session_id: sessionId,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'message_delta',
    session_id: sessionId,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 2,
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: JSON.stringify({
      model,
      permissionMode,
      dangerous,
      effort: effortIndex >= 0 ? args[effortIndex + 1] : null,
    }),
  }) + '\\n');
  process.exit(0);
}

process.stderr.write(\`unexpected args: \${args.join(' ')}\\n\`);
process.exit(1);
`,
  );
  const cliPath = path.join(dir, 'claude');
  fs.writeFileSync(
    cliPath,
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    { mode: 0o755 },
  );
  return cliPath;
}

function createFakeCodexCli() {
  const dir = createTempDir();
  const scriptPath = path.join(dir, 'codex.mjs');
  fs.writeFileSync(
    scriptPath,
    `import fs from 'node:fs';

const args = process.argv.slice(2);

if (args[0] !== 'exec') {
  process.stderr.write(\`unexpected args: \${args.join(' ')}\\n\`);
  process.exit(1);
}

let outputFile = '';
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '-o') {
    outputFile = args[index + 1] || '';
    index += 1;
  }
}

process.stdin.resume();
process.stdin.on('end', () => {
  if (outputFile) {
    fs.writeFileSync(outputFile, 'OK\\n');
  }
  if (!args.includes('--json')) {
    process.stdout.write('OK\\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    type: 'thread.started',
    thread_id: 'codex-thread-test',
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'reasoning',
      summary: [
        {
          type: 'summary_text',
          text: 'inspect repo ',
        },
      ],
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'function_call',
      name: 'exec_command',
      arguments: '{"cmd":"pwd"}',
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'OK',
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 12,
      cached_input_tokens: 5,
      output_tokens: 3,
    },
  }) + '\\n');
});
process.stdin.on('error', () => process.exit(1));
`,
  );
  const cliPath = path.join(dir, 'codex');
  fs.writeFileSync(
    cliPath,
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    { mode: 0o755 },
  );
  return cliPath;
}

function createFakeGeminiCli() {
  const dir = createTempDir();
  const scriptPath = path.join(dir, 'gemini.mjs');
  fs.writeFileSync(
    scriptPath,
    `import fs from 'node:fs';

const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || '';
const payload = {
  args: process.argv.slice(2),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  googleCloudAccessToken: process.env.GOOGLE_CLOUD_ACCESS_TOKEN || '',
  googleGenAiUseGca: process.env.GOOGLE_GENAI_USE_GCA || '',
  hkclawAgentAccessMode: process.env.HKCLAW_LITE_AGENT_ACCESS_MODE || '',
  hkclawAgentDangerous: process.env.HKCLAW_LITE_AGENT_DANGEROUS || '',
  geminiCliSystemSettingsPath: settingsPath,
  geminiCliSystemSettings: settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : null,
  _meta: {
    quota: {
      token_count: {
        input_tokens: 5,
        output_tokens: 2,
      },
    },
  },
};
process.stdout.write(JSON.stringify(payload));
`,
  );
  const cliPath = path.join(dir, 'gemini');
  fs.writeFileSync(
    cliPath,
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    { mode: 0o755 },
  );
  return cliPath;
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

test('resolveExecutable finds Windows command shims via PATHEXT', () => {
  const dir = createTempDir();
  const shimPath = path.join(dir, 'codex.cmd');
  fs.writeFileSync(shimPath, '@echo off\r\n', 'utf8');

  const resolved = resolveExecutable('codex', {
    platform: 'win32',
    pathValue: dir,
    pathext: '.EXE;.CMD',
  });

  assert.equal(resolved, shimPath);
});

test('resolveManagedAgentCli resolves codex by binary name on PATH', () => {
  const dir = createTempDir();
  const codexPath = path.join(dir, 'codex');
  fs.writeFileSync(codexPath, '#!/usr/bin/env node\n', { mode: 0o755 });

  const resolved = resolveManagedAgentCli('codex', {
    PATH: dir,
  });

  assert.equal(resolved?.source, 'system');
  assert.equal(resolved?.command, codexPath);
  assert.equal(resolved?.packageName, '@openai/codex');
  assert.deepEqual(resolved?.argsPrefix, []);
});

test('resolveManagedAgentCli honors HKCLAW_LITE_CODEX_CLI override', () => {
  const dir = createTempDir();
  const overridePath = path.join(dir, 'my-codex');
  fs.writeFileSync(overridePath, '#!/usr/bin/env node\n', { mode: 0o755 });

  const resolved = resolveManagedAgentCli('codex', {
    HKCLAW_LITE_CODEX_CLI: overridePath,
    PATH: '',
  });

  assert.equal(resolved?.source, 'external');
  assert.equal(resolved?.command, overridePath);
});

test('resolveManagedAgentCli honors HKCLAW_LITE_GEMINI_CLI override', () => {
  const dir = createTempDir();
  const overridePath = path.join(dir, 'my-gemini');
  fs.writeFileSync(overridePath, '#!/usr/bin/env node\n', { mode: 0o755 });

  const resolved = resolveManagedAgentCli('gemini-cli', {
    HKCLAW_LITE_GEMINI_CLI: overridePath,
    PATH: '',
  });

  assert.equal(resolved?.source, 'external');
  assert.equal(resolved?.command, overridePath);
});

test('resolveManagedAgentCli returns null when binary is missing from PATH', () => {
  const dir = createTempDir();

  const resolved = resolveManagedAgentCli('codex', {
    PATH: dir,
  });

  assert.equal(resolved, null);
});

test('runAgentTurn returns Codex CLI usage metadata when captureRuntimeMetadata is enabled', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakeCliPath = createFakeCodexCli();

  await withEnv(
    {
      HKCLAW_LITE_CODEX_CLI: fakeCliPath,
    },
    async () => {
      const output = await runAgentTurn({
        projectRoot,
        agent: {
          name: 'codex-agent',
          agent: 'codex',
          sandbox: 'read-only',
        },
        prompt: 'Return exactly OK.',
        rawPrompt: 'Return exactly OK.',
        workdir: 'workspace',
        captureRuntimeMetadata: true,
      });

      assert.equal(output.text, 'OK');
      assert.deepEqual(output.usage, {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 5,
      });
      assert.deepEqual(output.runtimeMeta, {
        runtimeBackend: 'codex-cli',
        runtimeSessionId: 'codex-thread-test',
      });
    },
  );
});

test('runAgentTurn forwards Codex stream events while preserving the final result', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakeCliPath = createFakeCodexCli();
  const events = [];

  await withEnv(
    {
      HKCLAW_LITE_CODEX_CLI: fakeCliPath,
    },
    async () => {
      const output = await runAgentTurn({
        projectRoot,
        agent: {
          name: 'codex-agent',
          agent: 'codex',
          sandbox: 'read-only',
        },
        prompt: 'Return exactly OK.',
        rawPrompt: 'Return exactly OK.',
        workdir: 'workspace',
        onStreamEvent: async (event) => {
          events.push(event);
        },
      });

      assert.equal(output, 'OK');
    },
  );

  assert.deepEqual(
    events.map((event) => ({
      source: event.source,
      kind: event.kind,
      phase: event.phase || null,
      toolName: event.toolName || null,
      text: event.text || '',
    })),
    [
      {
        source: 'codex-cli',
        kind: 'thinking',
        phase: null,
        toolName: null,
        text: 'inspect repo ',
      },
      {
        source: 'codex-cli',
        kind: 'tool',
        phase: 'stop',
        toolName: 'exec_command',
        text: '{"cmd":"pwd"}',
      },
    ],
  );
});

test('runAgentTurn uses the explicit Claude CLI override', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakeCliPath = createFakeClaudeCli();

  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_CLI: fakeCliPath,
    },
    async () => {
      const output = await runAgentTurn({
        projectRoot,
        agent: {
          name: 'claude-agent',
          agent: 'claude-code',
          model: 'claude-sonnet-4-6',
          permissionMode: 'acceptEdits',
        },
        prompt: 'Return exactly OK.',
        rawPrompt: 'Return exactly OK.',
        workdir: 'workspace',
      });

      assert.deepEqual(JSON.parse(output), {
        model: 'claude-sonnet-4-6',
        permissionMode: 'acceptEdits',
        dangerous: false,
        effort: null,
      });
    },
  );
});

test('runAgentTurn strips Gemini process-env auth overrides and forces managed Google login mode', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakeCliPath = createFakeGeminiCli();

  await withEnv(
    {
      HKCLAW_LITE_GEMINI_CLI: fakeCliPath,
      GEMINI_API_KEY: 'process-gemini-key',
      GOOGLE_API_KEY: 'process-google-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/google-creds.json',
      GOOGLE_CLOUD_ACCESS_TOKEN: 'google-cloud-access-token',
      GOOGLE_GENAI_USE_GCA: 'true',
    },
    async () => {
      const output = await runAgentTurn({
        projectRoot,
        agent: {
          name: 'gemini-agent',
          agent: 'gemini-cli',
        },
        prompt: 'Return exactly OK.',
        rawPrompt: 'Return exactly OK.',
        workdir: 'workspace',
      });

      const parsed = JSON.parse(output);
      assert.equal(parsed.geminiApiKey, '');
      assert.equal(parsed.googleApiKey, '');
      assert.equal(parsed.googleApplicationCredentials, '');
      assert.equal(parsed.googleCloudAccessToken, '');
      assert.equal(parsed.googleGenAiUseGca, 'true');
    },
  );
});

test('runAgentTurn maps Gemini full access to YOLO approval mode', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakeCliPath = createFakeGeminiCli();

  await withEnv(
    {
      HKCLAW_LITE_GEMINI_CLI: fakeCliPath,
    },
    async () => {
      const output = await runAgentTurn({
        projectRoot,
        agent: {
          name: 'gemini-agent',
          agent: 'gemini-cli',
          sandbox: 'danger-full-access',
          dangerous: true,
        },
        prompt: 'Return exactly OK.',
        rawPrompt: 'Return exactly OK.',
        workdir: 'workspace',
      });

      const parsed = JSON.parse(output);
      assert.equal(parsed.args.includes('--approval-mode'), true);
      assert.equal(parsed.args[parsed.args.indexOf('--approval-mode') + 1], 'yolo');
      assert.equal(parsed.args.includes('--skip-trust'), true);
      assert.equal(parsed.hkclawAgentAccessMode, 'danger-full-access');
      assert.equal(parsed.hkclawAgentDangerous, '1');
    },
  );
});

test('runAgentTurn maps Gemini effort to a temporary model config override', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakeCliPath = createFakeGeminiCli();

  await withEnv(
    {
      HKCLAW_LITE_GEMINI_CLI: fakeCliPath,
    },
    async () => {
      const output = await runAgentTurn({
        projectRoot,
        agent: {
          name: 'gemini-agent',
          agent: 'gemini-cli',
          model: 'gemini-2.5-flash',
          effort: 'high',
        },
        prompt: 'Return exactly OK.',
        rawPrompt: 'Return exactly OK.',
        workdir: 'workspace',
      });

      const parsed = JSON.parse(output);
      assert.equal(parsed.args.includes('-m'), true);
      assert.equal(parsed.args[parsed.args.indexOf('-m') + 1], 'gemini-2.5-flash');
      assert.match(parsed.geminiCliSystemSettingsPath, /settings\.json$/u);
      assert.deepEqual(parsed.geminiCliSystemSettings, {
        modelConfigs: {
          customOverrides: [
            {
              match: {
                model: 'gemini-2.5-flash',
              },
              modelConfig: {
                generateContentConfig: {
                  thinkingConfig: {
                    thinkingBudget: 24576,
                  },
                },
              },
            },
          ],
        },
      });
    },
  );
});

test('runAgentTurn returns Claude usage metadata when captureRuntimeMetadata is enabled', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakeCliPath = createFakeClaudeCli();

  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_CLI: fakeCliPath,
    },
    async () => {
      const output = await runAgentTurn({
        projectRoot,
        agent: {
          name: 'claude-agent',
          agent: 'claude-code',
        },
        prompt: 'Return exactly OK.',
        rawPrompt: 'Return exactly OK.',
        workdir: 'workspace',
        captureRuntimeMetadata: true,
      });

      assert.equal(typeof output.text, 'string');
      assert.equal(output.text.length > 0, true);
      assert.deepEqual(output.usage, {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 2,
      });
      assert.equal(output.runtimeMeta?.runtimeBackend, 'claude-cli');
    },
  );
});

test('runAgentTurn forwards Claude stream events while preserving the final result', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakeCliPath = createFakeClaudeCli();
  const events = [];

  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_CLI: fakeCliPath,
    },
    async () => {
      const output = await runAgentTurn({
        projectRoot,
        agent: {
          name: 'claude-agent',
          agent: 'claude-code',
        },
        prompt: 'Return exactly OK.',
        rawPrompt: 'Return exactly OK.',
        workdir: 'workspace',
        onStreamEvent: async (event) => {
          events.push(event);
        },
      });

      assert.equal(typeof output, 'string');
    },
  );

  assert.deepEqual(
    events.map((event) => ({
      kind: event.kind,
      phase: event.phase || null,
      toolName: event.toolName || null,
      text: event.text || '',
    })),
    [
      {
        kind: 'thinking',
        phase: null,
        toolName: null,
        text: 'first thought ',
      },
      {
        kind: 'tool',
        phase: 'start',
        toolName: 'bash',
        text: '',
      },
      {
        kind: 'tool',
        phase: 'input',
        toolName: 'bash',
        text: '{"cmd":"ls"}',
      },
      {
        kind: 'tool',
        phase: 'stop',
        toolName: 'bash',
        text: '',
      },
      {
        kind: 'thinking',
        phase: null,
        toolName: null,
        text: 'second thought',
      },
    ],
  );
});

test('buildCommandExecutionSpec uses cmd.exe on Windows', () => {
  const spec = buildCommandExecutionSpec('node -v', {
    platform: 'win32',
    env: {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    },
  });

  assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(spec.args, ['/d', '/s', '/c', 'node -v']);
});

test('buildCommandExecutionSpec uses the configured shell on POSIX', () => {
  const spec = buildCommandExecutionSpec('node -v', {
    platform: 'linux',
    env: {
      SHELL: '/bin/sh',
    },
  });

  assert.equal(spec.command, '/bin/sh');
  assert.deepEqual(spec.args, ['-lc', 'node -v']);
});
