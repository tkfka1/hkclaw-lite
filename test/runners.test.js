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

function createFakeClaudeAgentSdkBundle() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-runners-claude-sdk-'));
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
    `export function query({ options = {} }) {
  async function* run() {
    yield {
      type: 'result',
      subtype: 'success',
      result: JSON.stringify({
        model: options.model || null,
        permissionMode: options.permissionMode || null,
        dangerous: Boolean(options.allowDangerouslySkipPermissions),
      }),
    };
  }

  const iterator = run();
  iterator.close = () => {};
  return iterator;
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
    { mode: 0o755 },
  );
  return path.join(packageDir, 'package.json');
}

function createFakeCodexNativeBundle() {
  const rootDir = createTempDir();
  const packageDir = path.join(rootDir, '@openai', 'codex');
  const bundleDir = path.join(rootDir, '@openai', 'codex-linux-x64');
  const bundledScriptPath = path.join(packageDir, 'bin', 'codex.js');
  const nativeBinaryPath = path.join(
    bundleDir,
    'vendor',
    'x86_64-unknown-linux-musl',
    'codex',
    'codex',
  );
  const rgPath = path.join(
    bundleDir,
    'vendor',
    'x86_64-unknown-linux-musl',
    'path',
    'rg',
  );

  fs.mkdirSync(path.dirname(bundledScriptPath), { recursive: true });
  fs.mkdirSync(path.dirname(nativeBinaryPath), { recursive: true });
  fs.mkdirSync(path.dirname(rgPath), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@openai/codex',
      version: '0.0.0-test',
      bin: {
        codex: './bin/codex.js',
      },
    }),
  );
  fs.writeFileSync(bundledScriptPath, '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.writeFileSync(nativeBinaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(rgPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  return path.join(packageDir, 'package.json');
}

function createFakeGeminiCliBundle() {
  const rootDir = createTempDir();
  const packageDir = path.join(rootDir, '@google', 'gemini-cli');
  const scriptPath = path.join(packageDir, 'bundle', 'gemini.js');

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@google/gemini-cli',
      version: '0.0.0-test',
      type: 'module',
      bin: {
        gemini: './bundle/gemini.js',
      },
    }),
  );
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const payload = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  googleCloudAccessToken: process.env.GOOGLE_CLOUD_ACCESS_TOKEN || '',
  googleGenAiUseGca: process.env.GOOGLE_GENAI_USE_GCA || '',
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
    { mode: 0o755 },
  );

  return path.join(packageDir, 'package.json');
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

test('resolveManagedAgentCli uses the bundled package json override', () => {
  const dir = createTempDir();
  const packageDir = path.join(dir, '@openai', 'codex');
  const bundledScriptPath = path.join(packageDir, 'bin', 'codex.js');

  fs.mkdirSync(path.dirname(bundledScriptPath), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@openai/codex',
      version: '0.0.0-test',
      bin: {
        codex: './bin/codex.js',
      },
    }),
  );
  fs.writeFileSync(bundledScriptPath, '#!/usr/bin/env node\n', 'utf8');

  const resolved = resolveManagedAgentCli('codex', {
    HKCLAW_LITE_CODEX_CLI_PACKAGE_JSON: path.join(packageDir, 'package.json'),
  });

  assert.equal(resolved?.source, 'bundled');
  assert.equal(resolved?.command, process.execPath);
  assert.deepEqual(resolved?.argsPrefix, [bundledScriptPath]);
});

test('resolveManagedAgentCli prefers the bundled Codex native binary when available', () => {
  const fakePackageJson = createFakeCodexNativeBundle();

  const resolved = resolveManagedAgentCli('codex', {
    HKCLAW_LITE_CODEX_CLI_PACKAGE_JSON: fakePackageJson,
    PATH: '/usr/bin',
  });

  assert.equal(resolved?.source, 'bundled');
  assert.match(resolved?.command || '', /codex-linux-x64\/vendor\/x86_64-unknown-linux-musl\/codex\/codex$/u);
  assert.deepEqual(resolved?.argsPrefix, []);
  assert.match(resolved?.envPatch?.PATH || '', /^.+codex-linux-x64\/vendor\/x86_64-unknown-linux-musl\/path/u);
  assert.equal(resolved?.envPatch?.CODEX_MANAGED_BY_NPM, '1');
});

test('resolveManagedAgentCli ignores PATH when the bundled cli is missing', () => {
  const dir = createTempDir();
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\n', 'utf8');

  const resolved = resolveManagedAgentCli('codex', {
    HKCLAW_LITE_CODEX_CLI_PACKAGE_JSON: path.join(dir, 'missing', 'package.json'),
    PATH: dir,
    PATHEXT: '.CMD',
  });

  assert.equal(resolved, null);
});

test('runAgentTurn uses the bundled Claude Code CLI runtime override', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakePackageJson = createFakeClaudeAgentSdkBundle();

  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_AGENT_SDK_PACKAGE_JSON: fakePackageJson,
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
        sharedEnv: {},
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

test('runAgentTurn strips Gemini env-based auth overrides before invoking the bundled cli', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakePackageJson = createFakeGeminiCliBundle();

  await withEnv(
    {
      HKCLAW_LITE_GEMINI_CLI_PACKAGE_JSON: fakePackageJson,
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
        sharedEnv: {
          GEMINI_API_KEY: 'shared-gemini-key',
          GOOGLE_API_KEY: 'shared-google-key',
        },
      });

      const parsed = JSON.parse(output);
      assert.equal(parsed.geminiApiKey, '');
      assert.equal(parsed.googleApiKey, '');
      assert.equal(parsed.googleApplicationCredentials, '');
      assert.equal(parsed.googleCloudAccessToken, '');
      assert.equal(parsed.googleGenAiUseGca, '');
    },
  );
});

test('runAgentTurn returns Claude usage metadata when captureRuntimeMetadata is enabled', async () => {
  const projectRoot = createTempDir();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fakePackageJson = createFakeClaudeAgentSdkBundle();

  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_AGENT_SDK_PACKAGE_JSON: fakePackageJson,
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
        sharedEnv: {},
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
