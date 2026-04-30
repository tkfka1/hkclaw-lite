import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatStorageGi,
  inspectStorage,
  normalizeStorageGi,
  parseStorageGi,
  resizeStorage,
  STORAGE_DEFAULT_GIB,
  STORAGE_INCREMENTS_GIB,
  STORAGE_MIN_GIB,
} from '../src/storage-control.js';

test('storage sizes parse as Gi and reject values below the product floor', () => {
  assert.equal(STORAGE_MIN_GIB, 25);
  assert.equal(STORAGE_DEFAULT_GIB, 25);
  assert.deepEqual(STORAGE_INCREMENTS_GIB, [25, 50, 100]);
  assert.equal(parseStorageGi('25Gi'), 25);
  assert.equal(parseStorageGi('25gb'), 25);
  assert.equal(parseStorageGi('1Ti'), 1024);
  assert.equal(formatStorageGi(25), '25Gi');
  assert.throws(() => normalizeStorageGi('24Gi'), /at least 25Gi/u);
  assert.throws(() => normalizeStorageGi('abc'), /storage size in Gi/u);
});

test('storage inspection and resize use the configured PVCs through kubectl', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-storage-test-'));
  const kubectlPath = path.join(tempDir, 'kubectl');
  const logPath = path.join(tempDir, 'kubectl-calls.jsonl');
  fs.writeFileSync(
    kubectlPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HKCLAW_LITE_TEST_KUBECTL_LOG, JSON.stringify(args) + '\\n');

if (args.includes('get') && args.includes('pvc')) {
  const claimName = args[args.indexOf('pvc') + 1];
  const storage = claimName.includes('workspace') ? '40Gi' : '25Gi';
  process.stdout.write(JSON.stringify({
    spec: { resources: { requests: { storage } } },
    status: { phase: 'Bound', capacity: { storage } },
  }));
  process.exit(0);
}

if (args.includes('patch') && args.includes('pvc')) {
  process.stdout.write('patched\\n');
  process.exit(0);
}

process.stderr.write('unexpected kubectl args: ' + args.join(' ') + '\\n');
process.exit(2);
`,
    { mode: 0o755 },
  );

  const env = {
    ...process.env,
    PATH: `${tempDir}:${process.env.PATH || ''}`,
    HKCLAW_LITE_TEST_KUBECTL_LOG: logPath,
    HKCLAW_LITE_STORAGE_NAMESPACE: 'hkclaw-test',
    HKCLAW_LITE_STORAGE_STATE_PVC: 'hkclaw-state',
    HKCLAW_LITE_STORAGE_WORKSPACE_PVC: 'hkclaw-workspace',
  };

  const status = await inspectStorage(env);
  assert.equal(status.namespace, 'hkclaw-test');
  assert.equal(status.minGi, 25);
  assert.equal(status.targets.find((target) => target.name === 'state')?.currentGi, 25);
  assert.equal(status.targets.find((target) => target.name === 'workspace')?.currentGi, 40);

  await assert.rejects(() => resizeStorage({ target: 'state', sizeGi: 24 }, env), /at least 25Gi/u);
  await assert.rejects(
    () => resizeStorage({ target: 'workspace', sizeGi: 25 }, env),
    /smaller than current size/u,
  );

  const resized = await resizeStorage({ target: 'workspace', sizeGi: 50 }, env);
  assert.equal(resized.target.name, 'workspace');
  assert.equal(resized.target.claimName, 'hkclaw-workspace');

  const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const patchCall = calls.find((args) => args.includes('patch'));
  assert.deepEqual(patchCall.slice(0, 5), ['-n', 'hkclaw-test', 'patch', 'pvc', 'hkclaw-workspace']);
  assert.match(patchCall.at(-1), /"storage":"50Gi"/u);
});
