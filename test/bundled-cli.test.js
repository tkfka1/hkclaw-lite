import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildBundledCliOverlayEnv,
  getBundledCliPackageJsonPath,
  normalizeBundledCliAgentTypes,
  updateBundledClis,
} from '../src/bundled-cli.js';
import { inspectAgentRuntime } from '../src/runners.js';
import { initProject } from '../src/store.js';

function createTempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-bundles-test-'));
  initProject(projectRoot);
  return projectRoot;
}

function createFakeNpmCommand() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-fake-npm-'));
  const scriptPath = path.join(rootDir, 'fake-npm.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'install') {
  console.error('expected install');
  process.exit(2);
}
const prefixIndex = args.indexOf('--prefix');
const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : '';
if (!prefix) {
  console.error('missing --prefix');
  process.exit(3);
}

const packages = args.filter((arg) =>
  arg.startsWith('@openai/codex@') ||
  arg.startsWith('@anthropic-ai/claude-agent-sdk@') ||
  arg.startsWith('@google/gemini-cli@')
);

for (const spec of packages) {
  const separator = spec.lastIndexOf('@');
  const packageName = spec.slice(0, separator);
  const requestedVersion = spec.slice(separator + 1);
  const version = requestedVersion === 'latest' ? '9.9.9-test' : requestedVersion;
  const packageDir = path.join(prefix, 'node_modules', ...packageName.split('/'));
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  const binaryName = packageName.includes('gemini') ? 'gemini' : packageName.includes('claude') ? 'claude' : 'codex';
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version,
      type: 'module',
      bin: {
        [binaryName]: './bin/cli.js'
      },
      exports: {
        '.': './index.mjs'
      }
    }),
  );
  fs.writeFileSync(path.join(packageDir, 'bin', 'cli.js'), '#!/usr/bin/env node\\n');
  fs.writeFileSync(path.join(packageDir, 'index.mjs'), 'export function query() {}\\n');
}

process.stdout.write('fake npm installed ' + packages.length + ' package(s)\\n');
`,
    {
      mode: 0o755,
    },
  );
  return scriptPath;
}

test('normalizeBundledCliAgentTypes accepts aliases and all', () => {
  assert.deepEqual(normalizeBundledCliAgentTypes(['codex', 'gemini']), ['codex', 'gemini-cli']);
  assert.deepEqual(normalizeBundledCliAgentTypes(['all']), ['codex', 'claude-code', 'gemini-cli']);
});

test('updateBundledClis installs a project-local overlay and runtime inspection prefers it', async () => {
  const projectRoot = createTempProject();
  const fakeNpm = createFakeNpmCommand();

  const result = await updateBundledClis(projectRoot, {
    agentTypes: ['codex'],
    version: 'latest',
    npmCommand: fakeNpm,
    timeoutMs: 10_000,
  });

  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].packageName, '@openai/codex');
  assert.equal(result.packages[0].installedVersion, '9.9.9-test');

  const env = buildBundledCliOverlayEnv(projectRoot, {});
  assert.equal(env.HKCLAW_LITE_CODEX_CLI_PACKAGE_JSON, getBundledCliPackageJsonPath(projectRoot, 'codex'));

  const runtime = inspectAgentRuntime(projectRoot, {
    agent: 'codex',
    workdir: '.',
  });
  assert.equal(runtime.ready, true);
  assert.equal(runtime.packageName, '@openai/codex');
  assert.equal(runtime.packageVersion, '9.9.9-test');
  assert.match(runtime.detail, /bundled-clis/u);
});
