import fs from 'node:fs';
import path from 'node:path';

import { getProjectLayout } from './store.js';
import { assert, readJson, timestamp, writeJson } from './utils.js';

export const DISCORD_ROLE_NAMES = ['owner', 'reviewer', 'arbiter'];

const DISCORD_STATUS_FILENAME = 'discord-status.json';
const DISCORD_HEARTBEAT_STALE_MS = 45_000;
const ROLE_TOKEN_ENV_KEYS = {
  owner: [
    'OWNER_BOT_TOKEN',
    'OWNER_DISCORD_BOT_TOKEN',
    'HKCLAW_LITE_OWNER_BOT_TOKEN',
  ],
  reviewer: [
    'REVIEWER_BOT_TOKEN',
    'REVIEWER_DISCORD_BOT_TOKEN',
    'HKCLAW_LITE_REVIEWER_BOT_TOKEN',
  ],
  arbiter: [
    'ARBITER_BOT_TOKEN',
    'ARBITER_DISCORD_BOT_TOKEN',
    'HKCLAW_LITE_ARBITER_BOT_TOKEN',
  ],
};

export function getDiscordStatusPath(projectRoot) {
  return path.join(getProjectLayout(projectRoot).toolRoot, DISCORD_STATUS_FILENAME);
}

export function parseDotEnv(source) {
  const output = {};
  for (const rawLine of String(source || '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

export function readProjectEnvEntries(projectRoot, envFile = null) {
  const envFilePath = envFile
    ? path.resolve(projectRoot, envFile)
    : path.join(projectRoot, '.env');

  if (!fs.existsSync(envFilePath)) {
    return {
      envFilePath,
      entries: {},
    };
  }

  return {
    envFilePath,
    entries: parseDotEnv(fs.readFileSync(envFilePath, 'utf8')),
  };
}

export function loadProjectEnvFile(projectRoot, envFile = null, targetEnv = process.env) {
  const { envFilePath, entries } = readProjectEnvEntries(projectRoot, envFile);
  for (const [key, value] of Object.entries(entries)) {
    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
    }
  }
  return {
    envFilePath,
    entries,
  };
}

export function resolveDiscordRoleTokens(env, options = {}) {
  const output = Object.fromEntries(
    DISCORD_ROLE_NAMES.map((role) => {
      const resolved = resolveRoleToken(env, role);
      return [role, resolved.token];
    }),
  );

  assert(output.owner, 'OWNER_BOT_TOKEN is required.');
  if (options.requireReviewerAndArbiter) {
    assert(output.reviewer, 'REVIEWER_BOT_TOKEN is required for tribunal channels.');
    assert(output.arbiter, 'ARBITER_BOT_TOKEN is required for tribunal channels.');
  }

  return output;
}

export function inspectDiscordRoleTokens(
  projectRoot,
  {
    envFile = null,
    baseEnv = process.env,
    requireReviewerAndArbiter = false,
    runtimeStatus = null,
  } = {},
) {
  const { envFilePath, entries } = readProjectEnvEntries(projectRoot, envFile);
  const mergedEnv = {
    ...entries,
    ...baseEnv,
  };

  return {
    envFilePath,
    roles: Object.fromEntries(
      DISCORD_ROLE_NAMES.map((role) => {
        const resolved = resolveRoleToken(mergedEnv, role);
        const runtimeRole = runtimeStatus?.roles?.[role] || {};
        const configured = Boolean(resolved.token || runtimeRole.tokenConfigured);
        return [
          role,
          {
            configured,
            required: role === 'owner' || requireReviewerAndArbiter,
            envKey: resolved.envKey || runtimeRole.envKey || null,
            source: resolveTokenSource({
              envKey: resolved.envKey,
              envEntries: entries,
              baseEnv,
              runtimeConfigured: runtimeRole.tokenConfigured,
            }),
            tag: runtimeRole.tag || '',
            userId: runtimeRole.userId || '',
            connected: Boolean(runtimeRole.connected),
          },
        ];
      }),
    ),
  };
}

export function readDiscordServiceStatus(projectRoot) {
  return readJson(getDiscordStatusPath(projectRoot), null);
}

export function writeDiscordServiceStatus(projectRoot, value) {
  writeJson(getDiscordStatusPath(projectRoot), value);
}

export function buildDiscordServiceSnapshot(
  projectRoot,
  rawStatus = readDiscordServiceStatus(projectRoot),
) {
  const emptyRoles = buildServiceRoleSummary();
  if (!rawStatus) {
    return {
      state: 'stopped',
      label: '중지',
      running: false,
      pid: null,
      startedAt: null,
      stoppedAt: null,
      heartbeatAt: null,
      envFilePath: null,
      lastError: null,
      roles: emptyRoles,
    };
  }

  const pidAlive =
    Number.isInteger(rawStatus.pid) && rawStatus.pid > 0 ? isPidAlive(rawStatus.pid) : false;
  const heartbeatFresh = isHeartbeatFresh(rawStatus.heartbeatAt);

  let state = 'stopped';
  if (rawStatus.running && pidAlive && heartbeatFresh) {
    state = 'running';
  } else if (rawStatus.running) {
    state = 'stale';
  }

  return {
    state,
    label: localizeDiscordServiceState(state),
    running: state === 'running',
    stale: state === 'stale',
    pid: rawStatus.pid || null,
    pidAlive,
    heartbeatFresh,
    startedAt: rawStatus.startedAt || null,
    stoppedAt: rawStatus.stoppedAt || null,
    heartbeatAt: rawStatus.heartbeatAt || null,
    envFilePath: rawStatus.envFilePath || null,
    lastError: rawStatus.lastError || null,
    roles: buildServiceRoleSummary(rawStatus.roles),
  };
}

export function createDiscordServiceStatus(projectRoot, options = {}) {
  return {
    version: 1,
    projectRoot,
    pid: process.pid,
    running: Boolean(options.running),
    startedAt: options.startedAt || timestamp(),
    stoppedAt: options.stoppedAt || null,
    heartbeatAt: options.heartbeatAt || timestamp(),
    envFilePath: options.envFilePath || null,
    lastError: options.lastError || null,
    roles: buildServiceRoleSummary(options.roles),
  };
}

function resolveRoleToken(env, role) {
  const envKey = ROLE_TOKEN_ENV_KEYS[role].find((key) => String(env[key] || '').trim());
  return {
    envKey: envKey || null,
    token: envKey ? String(env[envKey]).trim() : '',
  };
}

function resolveTokenSource({ envKey, envEntries, baseEnv, runtimeConfigured }) {
  if (envKey) {
    if (baseEnv[envKey] !== undefined) {
      return '환경 변수';
    }
    if (envEntries[envKey] !== undefined) {
      return '.env';
    }
  }
  if (runtimeConfigured) {
    return 'discord serve';
  }
  return '없음';
}

function buildServiceRoleSummary(input = {}) {
  return Object.fromEntries(
    DISCORD_ROLE_NAMES.map((role) => {
      const source = input?.[role] || {};
      return [
        role,
        {
          tokenConfigured: Boolean(source.tokenConfigured),
          connected: Boolean(source.connected),
          envKey: source.envKey || null,
          tag: source.tag || '',
          userId: source.userId || '',
        },
      ];
    }),
  );
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isHeartbeatFresh(heartbeatAt) {
  if (!heartbeatAt) {
    return false;
  }
  const parsed = Date.parse(heartbeatAt);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return Date.now() - parsed <= DISCORD_HEARTBEAT_STALE_MS;
}

function localizeDiscordServiceState(state) {
  if (state === 'running') {
    return '가동 중';
  }
  if (state === 'stale') {
    return '끊김';
  }
  return '중지';
}
