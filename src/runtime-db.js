import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { getProjectLayout } from './store.js';
import { ensureDir, timestamp, toErrorMessage } from './utils.js';

const SQLITE_PROMISE = {
  current: null,
};

const DB_CACHE = new Map();

export async function startRuntimeRun(projectRoot, { channel, prompt, workdir }) {
  const db = await getRuntimeDb(projectRoot);
  const runId = crypto.randomUUID();
  const startedAt = timestamp();
  const maxRounds = channel?.mode === 'tribunal' ? channel?.reviewRounds || 2 : 1;

  db.prepare(
    `
      INSERT INTO runtime_runs (
        run_id,
        channel_name,
        discord_channel_id,
        mode,
        workspace,
        owner_agent,
        reviewer_agent,
        arbiter_agent,
        prompt,
        status,
        active_role,
        current_round,
        max_rounds,
        started_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    runId,
    normalizeNullableString(channel?.name),
    normalizeNullableString(channel?.discordChannelId),
    normalizeNullableString(channel?.mode || 'single'),
    normalizeNullableString(workdir),
    normalizeNullableString(channel?.agent),
    normalizeNullableString(channel?.reviewer),
    normalizeNullableString(channel?.arbiter),
    String(prompt || ''),
    'queued',
    null,
    0,
    maxRounds,
    startedAt,
  );

  insertRunEvent(db, runId, {
    status: 'queued',
    note: 'Run created.',
    createdAt: startedAt,
  });

  return {
    runId,
    startedAt,
    maxRounds,
  };
}

export async function transitionRuntimeRun(
  projectRoot,
  runId,
  {
    status,
    activeRole = undefined,
    currentRound = undefined,
    maxRounds = undefined,
    reviewerVerdict = undefined,
    finalDisposition = undefined,
    note = null,
  } = {},
) {
  const db = await getRuntimeDb(projectRoot);
  const current = db
    .prepare(
      `
        SELECT
          status,
          active_role,
          current_round,
          max_rounds,
          reviewer_verdict,
          final_disposition
        FROM runtime_runs
        WHERE run_id = ?
      `,
    )
    .get(runId);

  if (!current) {
    return;
  }

  const nextStatus = status ?? current.status;
  const nextActiveRole = activeRole === undefined ? current.active_role : activeRole;
  const nextCurrentRound =
    currentRound === undefined ? current.current_round : currentRound;
  const nextMaxRounds = maxRounds === undefined ? current.max_rounds : maxRounds;
  const nextReviewerVerdict =
    reviewerVerdict === undefined ? current.reviewer_verdict : reviewerVerdict;
  const nextFinalDisposition =
    finalDisposition === undefined ? current.final_disposition : finalDisposition;

  db.prepare(
    `
      UPDATE runtime_runs
      SET status = ?,
          active_role = ?,
          current_round = ?,
          max_rounds = ?,
          reviewer_verdict = ?,
          final_disposition = ?
      WHERE run_id = ?
    `,
  ).run(
    normalizeNullableString(nextStatus),
    normalizeNullableString(nextActiveRole),
    nextCurrentRound,
    nextMaxRounds,
    normalizeNullableString(nextReviewerVerdict),
    normalizeNullableString(nextFinalDisposition),
    runId,
  );

  insertRunEvent(db, runId, {
    status: nextStatus,
    role: nextActiveRole,
    round: nextCurrentRound,
    maxRounds: nextMaxRounds,
    verdict: nextReviewerVerdict,
    note,
  });
}

export async function recordRuntimeRoleMessage(projectRoot, runId, entry) {
  const db = await getRuntimeDb(projectRoot);
  db.prepare(
    `
      INSERT INTO runtime_role_messages (
        run_id,
        role,
        agent_name,
        content,
        final,
        round,
        max_rounds,
        verdict,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    runId,
    normalizeNullableString(entry?.role),
    normalizeNullableString(entry?.agent?.name),
    String(entry?.content || ''),
    entry?.final ? 1 : 0,
    entry?.round ?? null,
    entry?.maxRounds ?? null,
    normalizeNullableString(entry?.verdict),
    timestamp(),
  );
}

export async function enqueueRuntimeOutboxEvent(projectRoot, { runId, channel, entry }) {
  const db = await getRuntimeDb(projectRoot);
  db.prepare(
    `
      INSERT INTO runtime_outbox_events (
        run_id,
        channel_name,
        discord_channel_id,
        role,
        agent_name,
        content,
        final,
        round,
        max_rounds,
        verdict,
        created_at,
        dispatched_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
  ).run(
    runId,
    normalizeNullableString(channel?.name),
    normalizeNullableString(channel?.discordChannelId),
    normalizeNullableString(entry?.role),
    normalizeNullableString(entry?.agent?.name),
    String(entry?.content || ''),
    entry?.final ? 1 : 0,
    entry?.round ?? null,
    entry?.maxRounds ?? null,
    normalizeNullableString(entry?.verdict),
    timestamp(),
  );
}

export async function recordRuntimeRoleSession(projectRoot, { channel, runId, entry }) {
  const db = await getRuntimeDb(projectRoot);
  const now = timestamp();
  const channelName = normalizeNullableString(channel?.name) || 'unknown';
  const role = normalizeNullableString(entry?.role) || 'unknown';
  const sessionKey = `${channelName}:${role}`;
  const existing = db
    .prepare(
      `
        SELECT run_count, created_at
        FROM runtime_role_sessions
        WHERE session_key = ?
      `,
    )
    .get(sessionKey);

  db.prepare(
    `
      INSERT INTO runtime_role_sessions (
        session_key,
        channel_name,
        role,
        agent_name,
        mode,
        session_policy,
        run_count,
        last_run_id,
        last_status,
        last_verdict,
        last_prompt_at,
        last_completed_at,
        runtime_backend,
        runtime_session_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        agent_name = excluded.agent_name,
        mode = excluded.mode,
        session_policy = excluded.session_policy,
        run_count = excluded.run_count,
        last_run_id = excluded.last_run_id,
        last_status = excluded.last_status,
        last_verdict = excluded.last_verdict,
        last_prompt_at = excluded.last_prompt_at,
        last_completed_at = excluded.last_completed_at,
        runtime_backend = excluded.runtime_backend,
        runtime_session_id = excluded.runtime_session_id,
        updated_at = excluded.updated_at
    `,
  ).run(
    sessionKey,
    channelName,
    role,
    normalizeNullableString(entry?.agent?.name),
    normalizeNullableString(entry?.mode || channel?.mode || 'single'),
    role === 'arbiter' ? 'ephemeral' : 'sticky',
    Number(existing?.run_count || 0) + 1,
    runId,
    entry?.final ? 'completed' : 'emitted',
    normalizeNullableString(entry?.verdict),
    now,
    entry?.final ? now : null,
    normalizeNullableString(entry?.runtimeBackend),
    normalizeNullableString(entry?.runtimeSessionId),
    existing?.created_at || now,
    now,
  );
}

export async function getRuntimeRoleSession(projectRoot, { channelName, role }) {
  const db = await getRuntimeDb(projectRoot);
  const normalizedChannelName = normalizeNullableString(channelName);
  const normalizedRole = normalizeNullableString(role);
  if (!normalizedChannelName || !normalizedRole) {
    return null;
  }

  const sessionKey = `${normalizedChannelName}:${normalizedRole}`;
  const row = db
    .prepare(
      `
        SELECT
          session_key,
          channel_name,
          role,
          agent_name,
          mode,
          session_policy,
          run_count,
          last_run_id,
          last_status,
          last_verdict,
          last_prompt_at,
          last_completed_at,
          runtime_backend,
          runtime_session_id,
          created_at,
          updated_at
        FROM runtime_role_sessions
        WHERE session_key = ?
      `,
    )
    .get(sessionKey);

  if (!row) {
    return null;
  }

  return {
    sessionKey: row.session_key,
    channelName: row.channel_name,
    role: row.role,
    agentName: row.agent_name,
    mode: row.mode,
    sessionPolicy: row.session_policy,
    runCount: row.run_count,
    lastRunId: row.last_run_id,
    lastStatus: row.last_status,
    lastVerdict: row.last_verdict ?? null,
    lastPromptAt: row.last_prompt_at ?? null,
    lastCompletedAt: row.last_completed_at ?? null,
    runtimeBackend: row.runtime_backend ?? null,
    runtimeSessionId: row.runtime_session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function clearRuntimeRoleSessions(
  projectRoot,
  { channelName = null, role = null, runtimeBackend = null } = {},
) {
  const db = await getRuntimeDb(projectRoot);
  const predicates = [];
  const values = [];

  const normalizedChannelName = normalizeNullableString(channelName);
  if (normalizedChannelName) {
    predicates.push('channel_name = ?');
    values.push(normalizedChannelName);
  }

  const normalizedRole = normalizeNullableString(role);
  if (normalizedRole) {
    predicates.push('role = ?');
    values.push(normalizedRole);
  }

  const normalizedRuntimeBackend = normalizeNullableString(runtimeBackend);
  if (normalizedRuntimeBackend) {
    predicates.push('runtime_backend = ?');
    values.push(normalizedRuntimeBackend);
  }

  const whereClause = predicates.length > 0 ? ` WHERE ${predicates.join(' AND ')}` : '';
  const result = db.prepare(`DELETE FROM runtime_role_sessions${whereClause}`).run(...values);
  return Number(result?.changes || 0);
}

export async function completeRuntimeRun(projectRoot, runId, result) {
  const db = await getRuntimeDb(projectRoot);
  const completedAt = timestamp();
  db.prepare(
    `
      UPDATE runtime_runs
      SET status = ?,
          active_role = NULL,
          completed_at = ?,
          reviewer_verdict = ?,
          final_disposition = ?,
          result_role = ?,
          result_agent = ?,
          result_content = ?,
          error_text = NULL
      WHERE run_id = ?
    `,
  ).run(
    'completed',
    completedAt,
    normalizeNullableString(result?.reviewerVerdict),
    normalizeNullableString(result?.runtimeFinalDisposition || 'completed'),
    normalizeNullableString(result?.role),
    normalizeNullableString(result?.agent?.name),
    String(result?.content || ''),
    runId,
  );

  insertRunEvent(db, runId, {
    status: 'completed',
    role: result?.role,
    verdict: result?.reviewerVerdict,
    note: result?.runtimeFinalDisposition || 'Run completed.',
    createdAt: completedAt,
  });
}

export async function failRuntimeRun(projectRoot, runId, error) {
  const db = await getRuntimeDb(projectRoot);
  const completedAt = timestamp();
  db.prepare(
    `
      UPDATE runtime_runs
      SET status = ?,
          active_role = NULL,
          completed_at = ?,
          error_text = ?
      WHERE run_id = ?
    `,
  ).run('failed', completedAt, toErrorMessage(error), runId);

  insertRunEvent(db, runId, {
    status: 'failed',
    note: toErrorMessage(error),
    createdAt: completedAt,
  });
}

export async function listRecentRuntimeRuns(projectRoot, { limit = 20 } = {}) {
  const db = await getRuntimeDb(projectRoot);
  return db
    .prepare(
      `
        SELECT
          run_id,
          channel_name,
          discord_channel_id,
          mode,
          workspace,
          owner_agent,
          reviewer_agent,
          arbiter_agent,
          prompt,
          status,
          active_role,
          current_round,
          max_rounds,
          reviewer_verdict,
          final_disposition,
          started_at,
          completed_at,
          result_role,
          result_agent,
          result_content,
          error_text
        FROM runtime_runs
        ORDER BY started_at DESC, rowid DESC
        LIMIT ?
      `,
    )
    .all(limit)
    .map(mapRuntimeRunRow);
}

export async function listRuntimeRunEvents(projectRoot, runId) {
  const db = await getRuntimeDb(projectRoot);
  return db
    .prepare(
      `
        SELECT
          status,
          role,
          round,
          max_rounds,
          verdict,
          note,
          created_at
        FROM runtime_run_events
        WHERE run_id = ?
        ORDER BY id ASC
      `,
    )
    .all(runId)
    .map((row) => ({
      status: row.status,
      role: row.role ?? undefined,
      round: row.round ?? undefined,
      maxRounds: row.max_rounds ?? undefined,
      verdict: row.verdict ?? undefined,
      note: row.note ?? undefined,
      createdAt: row.created_at,
    }));
}

export async function listRuntimeRoleMessages(projectRoot, runId) {
  const db = await getRuntimeDb(projectRoot);
  return db
    .prepare(
      `
        SELECT
          role,
          agent_name,
          content,
          final,
          round,
          max_rounds,
          verdict,
          created_at
        FROM runtime_role_messages
        WHERE run_id = ?
        ORDER BY id ASC
      `,
    )
    .all(runId)
    .map((row) => ({
      role: row.role,
      agentName: row.agent_name,
      content: row.content,
      final: Boolean(row.final),
      round: row.round ?? undefined,
      maxRounds: row.max_rounds ?? undefined,
      verdict: row.verdict ?? undefined,
      createdAt: row.created_at,
    }));
}

export async function listRuntimeRoleSessions(
  projectRoot,
  { channelName = null, limit = 20 } = {},
) {
  const db = await getRuntimeDb(projectRoot);
  const rows = channelName
    ? db
        .prepare(
          `
            SELECT
              session_key,
              channel_name,
              role,
              agent_name,
              mode,
              session_policy,
              run_count,
              last_run_id,
              last_status,
              last_verdict,
              last_prompt_at,
              last_completed_at,
              runtime_backend,
              runtime_session_id,
              created_at,
              updated_at
            FROM runtime_role_sessions
            WHERE channel_name = ?
            ORDER BY updated_at DESC, session_key ASC
            LIMIT ?
          `,
        )
        .all(channelName, limit)
    : db
        .prepare(
          `
            SELECT
              session_key,
              channel_name,
              role,
              agent_name,
              mode,
              session_policy,
              run_count,
              last_run_id,
              last_status,
              last_verdict,
              last_prompt_at,
              last_completed_at,
              runtime_backend,
              runtime_session_id,
              created_at,
              updated_at
            FROM runtime_role_sessions
            ORDER BY updated_at DESC, session_key ASC
            LIMIT ?
          `,
        )
        .all(limit);

  return rows.map((row) => ({
    sessionKey: row.session_key,
    channelName: row.channel_name,
    role: row.role,
    agentName: row.agent_name,
    mode: row.mode,
    sessionPolicy: row.session_policy,
    runCount: row.run_count,
    lastRunId: row.last_run_id,
    lastStatus: row.last_status,
    lastVerdict: row.last_verdict ?? null,
    lastPromptAt: row.last_prompt_at ?? null,
    lastCompletedAt: row.last_completed_at ?? null,
    runtimeBackend: row.runtime_backend ?? null,
    runtimeSessionId: row.runtime_session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listPendingRuntimeOutboxEvents(
  projectRoot,
  { runId = null, limit = 100 } = {},
) {
  const db = await getRuntimeDb(projectRoot);
  const rows = runId
    ? db
        .prepare(
          `
            SELECT
              id,
              run_id,
              channel_name,
              discord_channel_id,
              role,
              agent_name,
              content,
              final,
              round,
              max_rounds,
              verdict,
              created_at
            FROM runtime_outbox_events
            WHERE dispatched_at IS NULL
              AND run_id = ?
            ORDER BY id ASC
            LIMIT ?
          `,
        )
        .all(runId, limit)
    : db
        .prepare(
          `
            SELECT
              id,
              run_id,
              channel_name,
              discord_channel_id,
              role,
              agent_name,
              content,
              final,
              round,
              max_rounds,
              verdict,
              created_at
            FROM runtime_outbox_events
            WHERE dispatched_at IS NULL
            ORDER BY id ASC
            LIMIT ?
          `,
        )
        .all(limit);

  return rows.map((row) => ({
    eventId: row.id,
    runId: row.run_id,
    channelName: row.channel_name,
    discordChannelId: row.discord_channel_id,
    role: row.role,
    agent: row.agent_name ? { name: row.agent_name } : null,
    content: row.content,
    final: Boolean(row.final),
    round: row.round ?? undefined,
    maxRounds: row.max_rounds ?? undefined,
    verdict: row.verdict ?? undefined,
    createdAt: row.created_at,
  }));
}

export async function markRuntimeOutboxEventDispatched(projectRoot, eventId) {
  const db = await getRuntimeDb(projectRoot);
  db.prepare(
    `
      UPDATE runtime_outbox_events
      SET dispatched_at = ?
      WHERE id = ?
    `,
  ).run(timestamp(), eventId);
}

export async function listRecentRoleSessionContext(
  projectRoot,
  {
    channelName,
    role,
    excludeRunId = null,
    limit = 3,
  },
) {
  const db = await getRuntimeDb(projectRoot);
  const baseQuery = `
    SELECT
      rr.run_id,
      rr.prompt,
      rr.started_at,
      rr.completed_at,
      rr.reviewer_verdict,
      rm.agent_name,
      rm.content,
      rm.verdict
    FROM runtime_role_messages rm
    JOIN runtime_runs rr
      ON rr.run_id = rm.run_id
    JOIN (
      SELECT run_id, role, MAX(id) AS latest_id
      FROM runtime_role_messages
      GROUP BY run_id, role
    ) latest
      ON latest.latest_id = rm.id
    WHERE rr.channel_name = ?
      AND rm.role = ?
      AND rr.status = 'completed'
  `;

  const rows = excludeRunId
    ? db
        .prepare(
          `${baseQuery}
            AND rr.run_id <> ?
            ORDER BY rr.started_at DESC, rm.id DESC
            LIMIT ?
          `,
        )
        .all(channelName, role, excludeRunId, limit)
    : db
        .prepare(
          `${baseQuery}
            ORDER BY rr.started_at DESC, rm.id DESC
            LIMIT ?
          `,
        )
        .all(channelName, role, limit);

  return rows.map((row) => ({
    runId: row.run_id,
    prompt: row.prompt,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    reviewerVerdict: row.reviewer_verdict ?? row.verdict ?? null,
    agentName: row.agent_name ?? null,
    content: row.content,
  }));
}

export async function bootstrapAdminAuth(projectRoot, { password, passwordFile } = {}) {
  const db = await getRuntimeDb(projectRoot);
  const existing = db
    .prepare(
      `
        SELECT password_hash
        FROM admin_auth_config
        WHERE id = 1
      `,
    )
    .get();
  if (existing?.password_hash) {
    return {
      enabled: true,
      storage: 'sqlite',
      migrated: false,
    };
  }

  const bootstrapPassword = normalizeBootstrapPassword(password, passwordFile);
  if (!bootstrapPassword) {
    return {
      enabled: false,
      storage: 'sqlite',
      migrated: false,
    };
  }

  const migratedFrom = normalizeBootstrapPassword(password)
    ? 'env'
    : passwordFile
      ? 'file'
      : 'unknown';
  const now = timestamp();
  db.prepare(
    `
      INSERT INTO admin_auth_config (
        id,
        password_hash,
        updated_at,
        migrated_from
      )
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        password_hash = excluded.password_hash,
        updated_at = excluded.updated_at,
        migrated_from = excluded.migrated_from
    `,
  ).run(hashAdminPassword(bootstrapPassword), now, migratedFrom);

  return {
    enabled: true,
    storage: 'sqlite',
    migrated: true,
    migratedFrom,
  };
}

export async function getAdminAuthStatus(projectRoot) {
  const db = await getRuntimeDb(projectRoot);
  const row = db
    .prepare(
      `
        SELECT password_hash
        FROM admin_auth_config
        WHERE id = 1
      `,
    )
    .get();
  return {
    enabled: Boolean(row?.password_hash),
    storage: 'sqlite',
  };
}

export async function verifyAdminPassword(projectRoot, password) {
  const db = await getRuntimeDb(projectRoot);
  const row = db
    .prepare(
      `
        SELECT password_hash
        FROM admin_auth_config
        WHERE id = 1
      `,
    )
    .get();
  if (!row?.password_hash) {
    return false;
  }
  return verifyAdminPasswordHash(row.password_hash, password);
}

export async function setAdminPassword(projectRoot, password) {
  const db = await getRuntimeDb(projectRoot);
  const now = timestamp();
  db.prepare(
    `
      INSERT INTO admin_auth_config (
        id,
        password_hash,
        updated_at,
        migrated_from
      )
      VALUES (1, ?, ?, 'ui')
      ON CONFLICT(id) DO UPDATE SET
        password_hash = excluded.password_hash,
        updated_at = excluded.updated_at
    `,
  ).run(hashAdminPassword(password), now);
  db.prepare('DELETE FROM admin_auth_sessions').run();
}

export async function createAdminSession(projectRoot, { ttlMs }) {
  const db = await getRuntimeDb(projectRoot);
  const token = crypto.randomBytes(24).toString('base64url');
  const createdAt = timestamp();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(
    `
      INSERT INTO admin_auth_sessions (
        token,
        created_at,
        expires_at
      )
      VALUES (?, ?, ?)
    `,
  ).run(token, createdAt, expiresAt);
  return {
    token,
    createdAt,
    expiresAt,
  };
}

export async function isAdminSessionValid(projectRoot, token) {
  if (!token) {
    return false;
  }
  const db = await getRuntimeDb(projectRoot);
  expireAdminSessions(db);
  const row = db
    .prepare(
      `
        SELECT token
        FROM admin_auth_sessions
        WHERE token = ?
      `,
    )
    .get(token);
  return Boolean(row?.token);
}

export async function deleteAdminSession(projectRoot, token) {
  if (!token) {
    return;
  }
  const db = await getRuntimeDb(projectRoot);
  db.prepare(
    `
      DELETE FROM admin_auth_sessions
      WHERE token = ?
    `,
  ).run(token);
}

async function getRuntimeDb(projectRoot) {
  const dbPath = path.join(getProjectLayout(projectRoot).toolRoot, 'runtime.db');
  const cached = DB_CACHE.get(dbPath);
  if (cached) {
    return cached;
  }

  const { DatabaseSync } = await loadSqlite();
  ensureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS runtime_runs (
      run_id TEXT PRIMARY KEY,
      channel_name TEXT,
      discord_channel_id TEXT,
      mode TEXT NOT NULL,
      workspace TEXT,
      owner_agent TEXT,
      reviewer_agent TEXT,
      arbiter_agent TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      result_role TEXT,
      result_agent TEXT,
      result_content TEXT,
      error_text TEXT
    );
    CREATE TABLE IF NOT EXISTS runtime_role_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_name TEXT,
      content TEXT NOT NULL,
      final INTEGER NOT NULL DEFAULT 0,
      round INTEGER,
      max_rounds INTEGER,
      verdict TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runtime_runs(run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS runtime_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      role TEXT,
      round INTEGER,
      max_rounds INTEGER,
      verdict TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runtime_runs(run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS runtime_role_sessions (
      session_key TEXT PRIMARY KEY,
      channel_name TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_name TEXT,
      mode TEXT NOT NULL,
      session_policy TEXT NOT NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      last_run_id TEXT,
      last_status TEXT,
      last_verdict TEXT,
      last_prompt_at TEXT,
      last_completed_at TEXT,
      runtime_backend TEXT,
      runtime_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_outbox_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      channel_name TEXT,
      discord_channel_id TEXT,
      role TEXT NOT NULL,
      agent_name TEXT,
      content TEXT NOT NULL,
      final INTEGER NOT NULL DEFAULT 0,
      round INTEGER,
      max_rounds INTEGER,
      verdict TEXT,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      FOREIGN KEY (run_id) REFERENCES runtime_runs(run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS admin_auth_config (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      password_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      migrated_from TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_auth_sessions (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runtime_runs_started_at_idx
      ON runtime_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS runtime_role_messages_run_id_idx
      ON runtime_role_messages(run_id, id);
    CREATE INDEX IF NOT EXISTS runtime_run_events_run_id_idx
      ON runtime_run_events(run_id, id);
    CREATE INDEX IF NOT EXISTS runtime_role_sessions_channel_name_idx
      ON runtime_role_sessions(channel_name, updated_at DESC);
    CREATE INDEX IF NOT EXISTS runtime_outbox_events_pending_idx
      ON runtime_outbox_events(dispatched_at, id);
    CREATE INDEX IF NOT EXISTS admin_auth_sessions_expires_at_idx
      ON admin_auth_sessions(expires_at);
  `);

  ensureRunColumn(db, 'active_role', 'TEXT');
  ensureRunColumn(db, 'current_round', 'INTEGER NOT NULL DEFAULT 0');
  ensureRunColumn(db, 'max_rounds', 'INTEGER NOT NULL DEFAULT 1');
  ensureRunColumn(db, 'reviewer_verdict', 'TEXT');
  ensureRunColumn(db, 'final_disposition', 'TEXT');
  ensureRoleSessionColumn(db, 'runtime_backend', 'TEXT');
  ensureRoleSessionColumn(db, 'runtime_session_id', 'TEXT');

  DB_CACHE.set(dbPath, db);
  return db;
}

function ensureRunColumn(db, columnName, columnSql) {
  const columns = db.prepare(`PRAGMA table_info(runtime_runs)`).all();
  if (columns.some((entry) => entry.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE runtime_runs ADD COLUMN ${columnName} ${columnSql}`);
}

function ensureRoleSessionColumn(db, columnName, columnSql) {
  const columns = db.prepare(`PRAGMA table_info(runtime_role_sessions)`).all();
  if (columns.some((entry) => entry.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE runtime_role_sessions ADD COLUMN ${columnName} ${columnSql}`);
}

function insertRunEvent(db, runId, entry) {
  db.prepare(
    `
      INSERT INTO runtime_run_events (
        run_id,
        status,
        role,
        round,
        max_rounds,
        verdict,
        note,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    runId,
    normalizeNullableString(entry?.status),
    normalizeNullableString(entry?.role),
    entry?.round ?? null,
    entry?.maxRounds ?? null,
    normalizeNullableString(entry?.verdict),
    normalizeNullableString(entry?.note),
    entry?.createdAt || timestamp(),
  );
}

async function loadSqlite() {
  if (!SQLITE_PROMISE.current) {
    SQLITE_PROMISE.current = importSqliteWithoutWarning();
  }
  return SQLITE_PROMISE.current;
}

async function importSqliteWithoutWarning() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function patchedEmitWarning(warning, ...args) {
    const warningType =
      typeof args[0] === 'string' ? args[0] : args[0]?.type || args[0]?.name;
    const warningMessage =
      typeof warning === 'string' ? warning : warning?.message || '';

    if (
      warningType === 'ExperimentalWarning' &&
      /SQLite is an experimental feature/u.test(String(warningMessage))
    ) {
      return;
    }

    return originalEmitWarning.call(this, warning, ...args);
  };

  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function mapRuntimeRunRow(row) {
  return {
    runId: row.run_id,
    channelName: row.channel_name,
    discordChannelId: row.discord_channel_id,
    mode: row.mode,
    workspace: row.workspace,
    ownerAgent: row.owner_agent,
    reviewerAgent: row.reviewer_agent,
    arbiterAgent: row.arbiter_agent,
    prompt: row.prompt,
    status: row.status,
    activeRole: row.active_role ?? null,
    currentRound: row.current_round ?? 0,
    maxRounds: row.max_rounds ?? 1,
    reviewerVerdict: row.reviewer_verdict ?? null,
    finalDisposition: row.final_disposition ?? null,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    resultRole: row.result_role ?? null,
    resultAgent: row.result_agent ?? null,
    resultContent: row.result_content ?? null,
    error: row.error_text ?? null,
  };
}

function normalizeNullableString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBootstrapPassword(password, passwordFile = null) {
  if (typeof password === 'string' && password.trim()) {
    return password.trim();
  }
  if (passwordFile && path.isAbsolute(passwordFile) && getFilePassword(passwordFile)) {
    return getFilePassword(passwordFile);
  }
  if (passwordFile && getFilePassword(passwordFile)) {
    return getFilePassword(passwordFile);
  }
  return null;
}

function getFilePassword(passwordFile) {
  try {
    if (!fs.existsSync(passwordFile)) {
      return null;
    }
    const value = fs.readFileSync(passwordFile, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

function verifyAdminPasswordHash(storedHash, password) {
  const [scheme, saltValue, hashValue] = String(storedHash || '').split('$');
  if (scheme !== 'scrypt' || !saltValue || !hashValue) {
    return false;
  }
  const expected = Buffer.from(hashValue, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltValue, 'base64url'), expected.length);
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

function expireAdminSessions(db) {
  db.prepare(
    `
      DELETE FROM admin_auth_sessions
      WHERE expires_at <= ?
    `,
  ).run(timestamp());
}
