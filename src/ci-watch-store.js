import fs from 'node:fs';
import path from 'node:path';

import { getProjectLayout } from './store.js';
import {
  assert,
  ensureDir,
  isSafeIdentifier,
  readJson,
  timestamp,
  writeJson,
} from './utils.js';

export function createCiWatcherId() {
  const now = new Date();
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const randomSuffix = Math.random().toString(16).slice(2, 8);
  return `ci-${iso.toLowerCase()}-${randomSuffix}`;
}

export function getCiWatcherPath(projectRoot, watcherId) {
  const layout = getProjectLayout(projectRoot);
  return path.join(layout.watchersRoot, `${watcherId}.json`);
}

export function getCiWatcherLogPath(projectRoot, watcherId) {
  const layout = getProjectLayout(projectRoot);
  return path.join(layout.watchersRoot, `${watcherId}.log`);
}

export function saveCiWatcher(projectRoot, watcher) {
  const normalized = normalizeCiWatcher(watcher);
  const filePath = getCiWatcherPath(projectRoot, normalized.id);
  ensureDir(path.dirname(filePath));
  writeJson(filePath, normalized);
  return normalized;
}

export function loadCiWatcher(projectRoot, watcherId) {
  const filePath = getCiWatcherPath(projectRoot, watcherId);
  const watcher = readJson(filePath, null);
  assert(watcher, `Unknown CI watcher "${watcherId}".`);
  return normalizeCiWatcher(watcher);
}

export function listCiWatchers(projectRoot) {
  const layout = getProjectLayout(projectRoot);
  ensureDir(layout.watchersRoot);
  return fs
    .readdirSync(layout.watchersRoot)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) =>
      normalizeCiWatcher(
        readJson(path.join(layout.watchersRoot, entry)),
      ),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function normalizeCiWatcher(watcher) {
  assert(watcher && typeof watcher === 'object', 'CI watcher state must be an object.');
  assert(isSafeIdentifier(watcher.id), 'CI watcher id is invalid.');
  assert(typeof watcher.provider === 'string' && watcher.provider, 'CI watcher provider is required.');
  assert(watcher.request && typeof watcher.request === 'object', 'CI watcher request is required.');

  const createdAt = watcher.createdAt || timestamp();
  const updatedAt = watcher.updatedAt || createdAt;

  return {
    id: watcher.id,
    provider: watcher.provider,
    label: watcher.label || watcher.provider,
    request: watcher.request,
    intervalMs: watcher.intervalMs,
    timeoutMs: watcher.timeoutMs,
    status: watcher.status || 'starting',
    createdAt,
    updatedAt,
    startedAt: watcher.startedAt || null,
    completedAt: watcher.completedAt || null,
    stoppedAt: watcher.stoppedAt || null,
    pid: watcher.pid || null,
    attempts: watcher.attempts || 0,
    lastSummary: watcher.lastSummary || null,
    resultSummary: watcher.resultSummary || null,
    completionMessage: watcher.completionMessage || null,
    error: watcher.error || null,
    logPath: watcher.logPath || null,
  };
}
