import fs from 'node:fs';
import path from 'node:path';

import { getProjectLayout } from './store.js';
import {
  assert,
  ensureDir,
  humanDate,
  isSafeIdentifier,
  readJson,
  timestamp,
  writeJson,
} from './utils.js';

export function createSessionId() {
  const now = new Date();
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const randomSuffix = Math.random().toString(16).slice(2, 8);
  return `${iso.toLowerCase()}-${randomSuffix}`;
}

export function resolveSessionId(projectRoot, serviceName, { requested, useLast }) {
  if (requested) {
    assert(
      isSafeIdentifier(requested),
      'Session id may only contain letters, numbers, dot, underscore, and dash.',
    );
    return requested;
  }
  if (useLast) {
    const sessions = listSessions(projectRoot, serviceName);
    assert(sessions.length > 0, `No sessions found for service "${serviceName}".`);
    return sessions[0].id;
  }
  return createSessionId();
}

export function getSessionPath(projectRoot, serviceName, sessionId) {
  const layout = getProjectLayout(projectRoot);
  return path.join(layout.sessionsRoot, serviceName, `${sessionId}.json`);
}

export function listSessions(projectRoot, serviceName = null) {
  const layout = getProjectLayout(projectRoot);
  if (!fs.existsSync(layout.sessionsRoot)) {
    return [];
  }

  const serviceNames = serviceName
    ? [serviceName]
    : fs.readdirSync(layout.sessionsRoot).sort();

  const sessions = [];
  for (const currentService of serviceNames) {
    const serviceDir = path.join(layout.sessionsRoot, currentService);
    if (!fs.existsSync(serviceDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(serviceDir).sort()) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(serviceDir, entry);
      const session = readJson(filePath);
      if (!session) {
        continue;
      }
      sessions.push({
        id: session.id,
        service: session.service,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        turnCount: countTurns(session),
      });
    }
  }

  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function loadSession(projectRoot, serviceName, sessionId) {
  const filePath = getSessionPath(projectRoot, serviceName, sessionId);
  const session = readJson(filePath, null);
  if (!session) {
    return createEmptySession(serviceName, sessionId);
  }
  return session;
}

export function loadExistingSession(projectRoot, serviceName, sessionId) {
  const filePath = getSessionPath(projectRoot, serviceName, sessionId);
  assert(fs.existsSync(filePath), `Unknown session "${sessionId}" for "${serviceName}".`);
  return loadSession(projectRoot, serviceName, sessionId);
}

export function saveSession(projectRoot, session) {
  const filePath = getSessionPath(projectRoot, session.service, session.id);
  ensureDir(path.dirname(filePath));
  writeJson(filePath, session);
}

export function deleteSession(projectRoot, serviceName, sessionId) {
  const filePath = getSessionPath(projectRoot, serviceName, sessionId);
  assert(fs.existsSync(filePath), `Unknown session "${sessionId}" for "${serviceName}".`);
  fs.rmSync(filePath);
}

export function clearSession(projectRoot, serviceName, sessionId) {
  const nextSession = createEmptySession(serviceName, sessionId);
  saveSession(projectRoot, nextSession);
  return nextSession;
}

export function appendTurn(session, userContent, assistantContent) {
  const nextTimestamp = timestamp();
  session.messages.push({
    role: 'user',
    content: userContent,
    createdAt: nextTimestamp,
  });
  session.messages.push({
    role: 'assistant',
    content: assistantContent,
    createdAt: timestamp(),
  });
  session.updatedAt = timestamp();
  return session;
}

export function formatSession(session) {
  if (session.messages.length === 0) {
    return `session=${session.id} service=${session.service}\n(empty)`;
  }
  const lines = [`session=${session.id} service=${session.service}`];
  for (const message of session.messages) {
    lines.push(
      `[${humanDate(message.createdAt)}] ${message.role}`,
      indent(message.content),
    );
  }
  return lines.join('\n');
}

function createEmptySession(serviceName, sessionId) {
  const now = timestamp();
  return {
    id: sessionId,
    service: serviceName,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function countTurns(session) {
  return Math.floor((session.messages?.length || 0) / 2);
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
