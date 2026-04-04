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

test('init creates project metadata', () => {
  const cwd = createProject();
  const result = runCli(cwd, ['init']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Initialized hkclaw-lite/u);
  assert.equal(
    fs.existsSync(path.join(cwd, '.hkclaw-lite', 'config.json')),
    true,
  );
});

test('service update preserves env when env flags are omitted', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);

  const add = runCli(cwd, [
    'service',
    'add',
    'worker',
    '--agent',
    'command',
    '--command',
    `node ${fixturePath}`,
    '--env',
    'FOO=bar',
  ]);
  assert.equal(add.status, 0, add.stderr);

  const update = runCli(cwd, [
    'service',
    'update',
    'worker',
    '--model',
    'mock-model',
  ]);
  assert.equal(update.status, 0, update.stderr);

  const show = runCli(cwd, ['service', 'show', 'worker']);
  assert.equal(show.status, 0, show.stderr);

  const service = JSON.parse(show.stdout);
  assert.equal(service.env.FOO, 'bar');
  assert.equal(service.model, 'mock-model');
});

test('run with session persists transcript and status reports service', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);

  const add = runCli(cwd, [
    'service',
    'add',
    'worker',
    '--agent',
    'command',
    '--command',
    `node ${fixturePath}`,
  ]);
  assert.equal(add.status, 0, add.stderr);

  const run = runCli(cwd, ['run', 'worker', 'hello world', '--session', 'demo']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /response=HELLO WORLD/u);
  assert.match(run.stdout, /session=demo/u);

  const sessionShow = runCli(cwd, ['session', 'show', 'worker', 'demo']);
  assert.equal(sessionShow.status, 0, sessionShow.stderr);
  assert.match(sessionShow.stdout, /hello world/u);
  assert.match(sessionShow.stdout, /response=HELLO WORLD/u);

  const status = runCli(cwd, ['status', 'worker']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /agent=command/u);
  assert.match(status.stdout, /sessions=1/u);
});

test('chat with explicit session appends turns', () => {
  const cwd = createProject();
  assert.equal(runCli(cwd, ['init']).status, 0);
  assert.equal(
    runCli(cwd, [
      'service',
      'add',
      'worker',
      '--agent',
      'command',
      '--command',
      `node ${fixturePath}`,
    ]).status,
    0,
  );

  const first = runCli(cwd, [
    'chat',
    'worker',
    '--session',
    'thread',
    '--message',
    'first turn',
  ]);
  assert.equal(first.status, 0, first.stderr);

  const second = runCli(cwd, [
    'chat',
    'worker',
    '--session',
    'thread',
    '--message',
    'second turn',
  ]);
  assert.equal(second.status, 0, second.stderr);

  const sessionShow = runCli(cwd, ['session', 'show', 'worker', 'thread']);
  assert.equal(sessionShow.status, 0, sessionShow.stderr);
  assert.match(sessionShow.stdout, /first turn/u);
  assert.match(sessionShow.stdout, /second turn/u);
});
