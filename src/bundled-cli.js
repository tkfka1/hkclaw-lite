import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { getProjectLayout } from './store.js';
import {
  assert,
  ensureDir,
  toErrorMessage,
  writeJson,
} from './utils.js';

export const MANAGED_AGENT_RUNTIMES = {
  codex: {
    kind: 'cli',
    binaryName: 'codex',
    packageName: '@openai/codex',
    packageJsonEnv: 'HKCLAW_LITE_CODEX_CLI_PACKAGE_JSON',
    label: 'Codex CLI',
  },
  'claude-code': {
    kind: 'sdk',
    binaryName: 'claude',
    packageName: '@anthropic-ai/claude-agent-sdk',
    packageJsonEnv: 'HKCLAW_LITE_CLAUDE_AGENT_SDK_PACKAGE_JSON',
    label: 'Claude Code CLI',
  },
  'gemini-cli': {
    kind: 'cli',
    binaryName: 'gemini',
    packageName: '@google/gemini-cli',
    packageJsonEnv: 'HKCLAW_LITE_GEMINI_CLI_PACKAGE_JSON',
    label: 'Gemini CLI',
  },
};

export const BUNDLED_CLI_AGENT_TYPES = Object.freeze(Object.keys(MANAGED_AGENT_RUNTIMES));

const DEFAULT_BUNDLED_CLI_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const BUNDLED_CLI_UPDATE_ENV = 'HKCLAW_LITE_NPM_COMMAND';
const PACKAGE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const activeUpdates = new Map();

export function getBundledCliOverlayRoot(projectRoot) {
  return path.join(getProjectLayout(projectRoot).toolRoot, 'bundled-clis');
}

export function getBundledCliPackageJsonPath(projectRoot, agentType) {
  const runtime = MANAGED_AGENT_RUNTIMES[agentType];
  if (!runtime) {
    return '';
  }
  return path.join(
    getBundledCliOverlayRoot(projectRoot),
    'node_modules',
    ...runtime.packageName.split('/'),
    'package.json',
  );
}

export function buildBundledCliOverlayEnv(projectRoot, baseEnv = process.env) {
  const nextEnv = { ...(baseEnv || {}) };
  for (const agentType of BUNDLED_CLI_AGENT_TYPES) {
    const runtime = MANAGED_AGENT_RUNTIMES[agentType];
    if (String(nextEnv[runtime.packageJsonEnv] || '').trim()) {
      continue;
    }
    const packageJsonPath = getBundledCliPackageJsonPath(projectRoot, agentType);
    if (isRegularFile(packageJsonPath)) {
      nextEnv[runtime.packageJsonEnv] = packageJsonPath;
    }
  }
  return nextEnv;
}

export function readBundledCliOverlayStatus(projectRoot) {
  const overlayRoot = getBundledCliOverlayRoot(projectRoot);
  const entries = {};
  for (const agentType of BUNDLED_CLI_AGENT_TYPES) {
    const runtime = MANAGED_AGENT_RUNTIMES[agentType];
    const packageJsonPath = getBundledCliPackageJsonPath(projectRoot, agentType);
    const packageJson = readPackageJson(packageJsonPath);
    entries[agentType] = {
      agentType,
      label: runtime.label,
      packageName: runtime.packageName,
      packageJsonEnv: runtime.packageJsonEnv,
      packageJsonPath,
      overlayInstalled: Boolean(packageJson),
      overlayVersion: packageJson?.version || '',
    };
  }
  return {
    overlayRoot,
    entries,
  };
}

export function normalizeBundledCliAgentTypes(input) {
  const rawValues = Array.isArray(input)
    ? input
    : input === undefined || input === null || input === ''
      ? ['all']
      : [input];
  const values = rawValues
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const selected = values.length ? values : ['all'];
  if (selected.some((value) => ['all', '*'].includes(value))) {
    return [...BUNDLED_CLI_AGENT_TYPES];
  }

  const aliases = {
    claude: 'claude-code',
    gemini: 'gemini-cli',
  };
  const output = [];
  for (const value of selected) {
    const key = value.toLowerCase();
    const normalized = aliases[key] || key;
    assert(
      BUNDLED_CLI_AGENT_TYPES.includes(normalized),
      `Unsupported bundled CLI agent type "${value}".`,
    );
    if (!output.includes(normalized)) {
      output.push(normalized);
    }
  }
  return output;
}

export async function updateBundledClis(
  projectRoot,
  {
    agentTypes = ['all'],
    version = 'latest',
    npmCommand = process.env[BUNDLED_CLI_UPDATE_ENV] || 'npm',
    timeoutMs = DEFAULT_BUNDLED_CLI_UPDATE_TIMEOUT_MS,
  } = {},
) {
  const selectedAgentTypes = normalizeBundledCliAgentTypes(agentTypes);
  const normalizedVersion = normalizeBundleVersion(version);
  const lockKey = path.resolve(projectRoot);
  assert(!activeUpdates.has(lockKey), 'Bundled CLI update is already running.');

  const updatePromise = runBundledCliUpdate(projectRoot, {
    agentTypes: selectedAgentTypes,
    version: normalizedVersion,
    npmCommand,
    timeoutMs,
  });
  activeUpdates.set(lockKey, updatePromise);
  try {
    return await updatePromise;
  } finally {
    activeUpdates.delete(lockKey);
  }
}

async function runBundledCliUpdate(
  projectRoot,
  {
    agentTypes,
    version,
    npmCommand,
    timeoutMs,
  },
) {
  const overlayRoot = getBundledCliOverlayRoot(projectRoot);
  ensureBundledCliOverlayPackage(overlayRoot);

  const specs = agentTypes.map((agentType) => {
    const runtime = MANAGED_AGENT_RUNTIMES[agentType];
    return `${runtime.packageName}@${version}`;
  });
  const args = [
    'install',
    '--prefix',
    overlayRoot,
    '--omit=dev',
    '--package-lock=false',
    '--save-exact',
    '--no-audit',
    '--no-fund',
    ...specs,
  ];
  const startedAt = new Date().toISOString();
  const execution = await runUpdateCommand(npmCommand, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    },
    timeoutMs,
  });
  const finishedAt = new Date().toISOString();
  const packages = agentTypes.map((agentType) => {
    const runtime = MANAGED_AGENT_RUNTIMES[agentType];
    const packageJsonPath = getBundledCliPackageJsonPath(projectRoot, agentType);
    const packageJson = readPackageJson(packageJsonPath);
    return {
      agentType,
      label: runtime.label,
      packageName: runtime.packageName,
      requestedVersion: version,
      installedVersion: packageJson?.version || '',
      packageJsonPath,
      ok: Boolean(packageJson?.version),
    };
  });

  assert(
    packages.every((entry) => entry.ok),
    'Bundled CLI update finished but one or more package manifests are missing.',
  );

  return {
    ok: execution.exitCode === 0,
    overlayRoot,
    command: [npmCommand, ...args].join(' '),
    packages,
    output: execution.output || '(출력 없음)',
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    startedAt,
    finishedAt,
  };
}

function ensureBundledCliOverlayPackage(overlayRoot) {
  ensureDir(overlayRoot);
  const packageJsonPath = path.join(overlayRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    return;
  }
  writeJson(packageJsonPath, {
    private: true,
    name: 'hkclaw-lite-bundled-clis',
    description: 'Project-local hkclaw-lite bundled CLI overlay.',
    dependencies: {},
  });
}

function normalizeBundleVersion(value) {
  const version = String(value || 'latest').trim() || 'latest';
  assert(
    PACKAGE_VERSION_RE.test(version),
    'Bundled CLI version must be an npm dist-tag or exact version.',
  );
  return version;
}

function runUpdateCommand(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      const output = [
        Buffer.concat(stdout).toString('utf8').trim(),
        Buffer.concat(stderr).toString('utf8').trim(),
      ].filter(Boolean).join('\n').trim();
      if (exitCode !== 0 || timedOut) {
        const error = new Error(
          timedOut
            ? `Bundled CLI update timed out after ${timeoutMs}ms.`
            : `Bundled CLI update failed with exit code ${exitCode}: ${output || '(출력 없음)'}`,
        );
        error.result = {
          output,
          exitCode,
          signal: signal || null,
          timedOut,
        };
        reject(error);
        return;
      }
      resolve({
        output,
        exitCode,
        signal: signal || null,
        timedOut,
      });
    });
  }).catch((error) => {
    const result = error?.result || {};
    throw Object.assign(new Error(toErrorMessage(error)), {
      output: result.output || '',
      exitCode: result.exitCode ?? 1,
      signal: result.signal || null,
      timedOut: Boolean(result.timedOut),
    });
  });
}

function readPackageJson(filePath) {
  if (!isRegularFile(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
