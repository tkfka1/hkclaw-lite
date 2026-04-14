import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCommandExecutionSpec } from '../src/runners.js';
import { resolveExecutable, resolvePreferredCli } from '../src/utils.js';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-runners-test-'));
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

test('resolvePreferredCli prefers a bundled package binary over PATH', () => {
  const dir = createTempDir();
  const packageDir = path.join(dir, 'node_modules', '@openai', 'codex');
  const bundledScriptPath = path.join(packageDir, 'bin', 'codex.js');
  const pathShim = path.join(dir, 'codex.cmd');

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
  fs.writeFileSync(pathShim, '@echo off\r\n', 'utf8');

  const resolved = resolvePreferredCli('codex', {
    packageName: '@openai/codex',
    pathValue: dir,
    platform: 'win32',
    pathext: '.CMD',
    resolvePackageJson: (request) => {
      assert.equal(request, '@openai/codex/package.json');
      return path.join(packageDir, 'package.json');
    },
  });

  assert.equal(resolved?.source, 'bundled');
  assert.equal(resolved?.command, process.execPath);
  assert.deepEqual(resolved?.argsPrefix, [bundledScriptPath]);
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
