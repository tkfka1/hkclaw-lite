import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildProjectEnv, getProjectEnvFilePaths, parseDotEnv } from '../src/project-env.js';

test('parseDotEnv supports export syntax, quotes, and inline comments', () => {
  const parsed = parseDotEnv(`
export FIRST=value
SECOND="two words"
THIRD='three words'
FOURTH=four # comment
INVALID LINE
`);

  assert.deepEqual(parsed, {
    FIRST: 'value',
    SECOND: 'two words',
    THIRD: 'three words',
    FOURTH: 'four',
  });
});

test('buildProjectEnv merges project env files under root and .hkclaw-lite without overriding real env', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-project-env-'));
  fs.mkdirSync(path.join(projectRoot, '.hkclaw-lite'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.env'), 'ROOT_ONLY=root\nSHARED=root-value\n');
  fs.writeFileSync(
    path.join(projectRoot, '.hkclaw-lite', '.env'),
    'TOOL_ONLY=tool\nSHARED=tool-value\n',
  );

  assert.deepEqual(getProjectEnvFilePaths(projectRoot), [
    path.join(projectRoot, '.env'),
    path.join(projectRoot, '.hkclaw-lite', '.env'),
  ]);

  const merged = buildProjectEnv(projectRoot, {
    SHARED: 'process-value',
    PROCESS_ONLY: 'process',
  });

  assert.equal(merged.ROOT_ONLY, 'root');
  assert.equal(merged.TOOL_ONLY, 'tool');
  assert.equal(merged.SHARED, 'process-value');
  assert.equal(merged.PROCESS_ONLY, 'process');
});
