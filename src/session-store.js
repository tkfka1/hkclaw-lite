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

export function resolveSessionId(projectRoot, agentName, { requested, useLast }) {
  if (requested) {
    assert(
      isSafeIdentifier(requested),
      'Session id may only contain letters, numbers, dot, underscore, and dash.',
    );
    return requested;
  }
  if (useLast) {
    const sessions = listSessions(projectRoot, agentName);
    assert(sessions.length > 0, `No sessions found for agent "${agentName}".`);
    return sessions[0].id;
  }
  return createSessionId();
}

export function getSessionPath(projectRoot, agentName, sessionId) {
  const layout = getProjectLayout(projectRoot);
  return path.join(layout.sessionsRoot, agentName, `${sessionId}.json`);
}

export function listSessions(projectRoot, agentName = null) {
  const layout = getProjectLayout(projectRoot);
  if (!fs.existsSync(layout.sessionsRoot)) {
    return [];
  }

  const agentNames = agentName ? [agentName] : fs.readdirSync(layout.sessionsRoot).sort();
  const sessions = [];

  for (const currentAgentName of agentNames) {
    const agentDir = path.join(layout.sessionsRoot, currentAgentName);
    if (!fs.existsSync(agentDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(agentDir).sort()) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(agentDir, entry);
      const session = normalizeSession(readJson(filePath));
      if (!session) {
        continue;
      }
      sessions.push({
        id: session.id,
        agent: session.agent,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        turnCount: countTurns(session),
      });
    }
  }

  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function summarizeSessions(projectRoot) {
  const summary = {};
  for (const session of listSessions(projectRoot)) {
    const current = summary[session.agent] || {
      count: 0,
      latestUpdatedAt: null,
      latestSessionId: null,
    };
    current.count += 1;
    if (!current.latestUpdatedAt || session.updatedAt > current.latestUpdatedAt) {
      current.latestUpdatedAt = session.updatedAt;
      current.latestSessionId = session.id;
    }
    summary[session.agent] = current;
  }
  return summary;
}

export function loadSession(projectRoot, agentName, sessionId) {
  const filePath = getSessionPath(projectRoot, agentName, sessionId);
  const session = normalizeSession(readJson(filePath, null));
  if (!session) {
    return createEmptySession(agentName, sessionId);
  }
  return session;
}

export function loadExistingSession(projectRoot, agentName, sessionId) {
  const filePath = getSessionPath(projectRoot, agentName, sessionId);
  assert(fs.existsSync(filePath), `Unknown session "${sessionId}" for "${agentName}".`);
  return loadSession(projectRoot, agentName, sessionId);
}

export function saveSession(projectRoot, session) {
  const normalized = normalizeSession(session);
  const filePath = getSessionPath(projectRoot, normalized.agent, normalized.id);
  ensureDir(path.dirname(filePath));
  writeJson(filePath, normalized);
}

export function deleteSession(projectRoot, agentName, sessionId) {
  const filePath = getSessionPath(projectRoot, agentName, sessionId);
  assert(fs.existsSync(filePath), `Unknown session "${sessionId}" for "${agentName}".`);
  fs.rmSync(filePath);
}

export function clearSession(projectRoot, agentName, sessionId) {
  const nextSession = createEmptySession(agentName, sessionId);
  saveSession(projectRoot, nextSession);
  return nextSession;
}

export function appendTurn(session, userContent, assistantContent) {
  const normalized = normalizeSession(session);
  normalized.messages.push({
    role: 'user',
    content: userContent,
    createdAt: timestamp(),
  });
  normalized.messages.push({
    role: 'assistant',
    content: assistantContent,
    createdAt: timestamp(),
  });
  normalized.updatedAt = timestamp();
  return normalized;
}

export function formatSession(session) {
  const normalized = normalizeSession(session);
  if (normalized.messages.length === 0) {
    return `session=${normalized.id} agent=${normalized.agent}\n(empty)`;
  }
  const lines = [`session=${normalized.id} agent=${normalized.agent}`];
  for (const message of normalized.messages) {
    lines.push(
      `[${humanDate(message.createdAt)}] ${message.role}`,
      indent(message.content),
    );
  }
  return lines.join('\n');
}

function createEmptySession(agentName, sessionId) {
  const now = timestamp();
  return {
    id: sessionId,
    agent: agentName,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function normalizeSession(session) {
  if (!session) {
    return null;
  }
  const agent = session.agent || session.service;
  assert(agent, 'Session file is missing an agent name.');
  return {
    ...session,
    agent,
    createdAt: session.createdAt || timestamp(),
    updatedAt: session.updatedAt || session.createdAt || timestamp(),
    messages: Array.isArray(session.messages) ? session.messages : [],
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
