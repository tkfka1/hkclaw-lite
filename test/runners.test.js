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

test('runAgentTurn uses the bundled Claude Code ACP runtime override', async () => {
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
          model: 'claude-sonnet-4-20250514',
          permissionMode: 'acceptEdits',
        },
        prompt: 'Return exactly OK.',
        rawPrompt: 'Return exactly OK.',
        workdir: 'workspace',
        sharedEnv: {},
      });

      assert.deepEqual(JSON.parse(output), {
        model: 'claude-sonnet-4-20250514',
        permissionMode: 'acceptEdits',
        dangerous: false,
      });
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
