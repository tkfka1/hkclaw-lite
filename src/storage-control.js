import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { assert, resolveExecutable, toErrorMessage } from './utils.js';

export const STORAGE_MIN_GIB = 25;
export const STORAGE_DEFAULT_GIB = 25;
export const STORAGE_INCREMENTS_GIB = [25, 50, 100];
export const STORAGE_TARGETS = [
  {
    name: 'state',
    label: '상태 저장소',
    envKey: 'HKCLAW_LITE_STORAGE_STATE_PVC',
    suffix: 'state',
  },
  {
    name: 'workspace',
    label: '워크스페이스',
    envKey: 'HKCLAW_LITE_STORAGE_WORKSPACE_PVC',
    suffix: 'workspace',
  },
];

const KUBERNETES_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

export function normalizeStorageGi(value, fieldName = 'storage') {
  const parsed = parseStorageGi(value);
  assert(Number.isInteger(parsed), `${fieldName} must be a storage size in Gi.`);
  assert(parsed >= STORAGE_MIN_GIB, `${fieldName} must be at least ${STORAGE_MIN_GIB}Gi.`);
  return parsed;
}

export function parseStorageGi(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return NaN;
  }

  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(ti|tib|tb|gi|gib|gb|g)?$/iu);
  if (!match) {
    return NaN;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NaN;
  }

  const unit = String(match[2] || 'gi').toLowerCase();
  if (unit === 'ti' || unit === 'tib' || unit === 'tb') {
    return Math.ceil(amount * 1024);
  }
  return Math.ceil(amount);
}

export function formatStorageGi(sizeGi) {
  return `${normalizeStorageGi(sizeGi)}Gi`;
}

export async function inspectStorage(env = process.env) {
  const namespace = resolveStorageNamespace(env);
  const targets = await Promise.all(
    STORAGE_TARGETS.map(async (target) => inspectStorageTarget(target, namespace, env)),
  );
  return {
    available: targets.some((target) => target.available),
    namespace,
    minGi: STORAGE_MIN_GIB,
    defaultGi: STORAGE_DEFAULT_GIB,
    incrementsGi: STORAGE_INCREMENTS_GIB,
    targets,
  };
}

export async function resizeStorage(input = {}, env = process.env) {
  const target = resolveStorageTarget(input.target);
  const sizeGi = normalizeStorageGi(input.sizeGi ?? input.size ?? input.storage, 'storage');
  const namespace = resolveStorageNamespace(env);
  const claimName = resolveStorageClaimName(target, env);
  const current = await inspectStorageTarget(target, namespace, env);
  assert(
    !(current.available && Number.isInteger(current.currentGi) && sizeGi < current.currentGi),
    `storage cannot be smaller than current size (${current.currentGi}Gi).`,
  );
  await runKubectl(
    [
      '-n',
      namespace,
      'patch',
      'pvc',
      claimName,
      '--type',
      'merge',
      '-p',
      JSON.stringify({
        spec: {
          resources: {
            requests: {
              storage: `${sizeGi}Gi`,
            },
          },
        },
      }),
    ],
    env,
  );
  const status = await inspectStorageTarget(target, namespace, env);
  return {
    namespace,
    target: status,
    minGi: STORAGE_MIN_GIB,
    defaultGi: STORAGE_DEFAULT_GIB,
    incrementsGi: STORAGE_INCREMENTS_GIB,
  };
}

async function inspectStorageTarget(target, namespace, env) {
  const claimName = resolveStorageClaimName(target, env);
  const base = {
    name: target.name,
    label: target.label,
    claimName,
    namespace,
    minGi: STORAGE_MIN_GIB,
    defaultGi: STORAGE_DEFAULT_GIB,
    currentGi: null,
    requestedSize: '',
    available: false,
    error: '',
  };

  try {
    const output = await runKubectl(['-n', namespace, 'get', 'pvc', claimName, '-o', 'json'], env);
    const payload = JSON.parse(output);
    const requestedSize = payload?.spec?.resources?.requests?.storage || '';
    return {
      ...base,
      requestedSize,
      currentGi: parseStorageGi(requestedSize),
      available: true,
      phase: payload?.status?.phase || '',
      capacity: payload?.status?.capacity?.storage || '',
    };
  } catch (error) {
    return {
      ...base,
      error: toErrorMessage(error),
    };
  }
}

function resolveStorageTarget(name) {
  const normalized = String(name || '').trim() || 'state';
  const target = STORAGE_TARGETS.find((entry) => entry.name === normalized);
  assert(target, `Unknown storage target "${normalized}".`);
  return target;
}

function resolveStorageNamespace(env) {
  return (
    String(
      env.HKCLAW_LITE_STORAGE_NAMESPACE ||
        env.HKCLAW_LITE_K8S_NAMESPACE ||
        env.POD_NAMESPACE ||
        env.KUBERNETES_NAMESPACE ||
        readServiceAccountNamespace() ||
        'default',
    ).trim() || 'default'
  );
}

function resolveStorageClaimName(target, env) {
  const releaseName = String(env.HKCLAW_LITE_RELEASE_NAME || 'hkclaw-lite').trim() || 'hkclaw-lite';
  return String(env[target.envKey] || `${releaseName}-${target.suffix}`).trim();
}

function readServiceAccountNamespace() {
  try {
    return fs.readFileSync(KUBERNETES_NAMESPACE_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

function runKubectl(args, env) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      ...(env || {}),
    };
    const kubectl = resolveExecutable(childEnv.HKCLAW_LITE_KUBECTL || 'kubectl', {
      pathValue: childEnv.PATH || '',
    });
    if (!kubectl) {
      reject(new Error('kubectl을 찾지 못했습니다.'));
      return;
    }

    const child = spawn(kubectl, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(errorOutput || output || `kubectl failed with exit code ${code}.`));
        return;
      }
      resolve(output);
    });
  });
}
