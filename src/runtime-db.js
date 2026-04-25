import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { getProjectLayout } from './store.js';
import { assert, ensureDir, timestamp, toErrorMessage } from './utils.js';

const SQLITE_PROMISE = {
  current: null,
};

const DB_CACHE = new Map();
const KAKAO_RELAY_SESSION_TTL_MS = 5 * 60 * 1000;
const KAKAO_RELAY_PAIRING_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

export async function recordRuntimeUsageEvent(projectRoot, entry = {}) {
  const usage = normalizeUsageEntry(entry?.usage);
  if (!usage) {
    return null;
  }

  const db = await getRuntimeDb(projectRoot);
  const recordedAt = normalizeNullableString(entry?.recordedAt) || timestamp();
  db.prepare(
    `
      INSERT INTO runtime_usage_events (
        agent_type,
        agent_name,
        channel_name,
        role,
        source,
        model,
        runtime_backend,
        input_tokens,
        output_tokens,
        total_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        recorded_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    normalizeNullableString(entry?.agentType),
    normalizeNullableString(entry?.agentName),
    normalizeNullableString(entry?.channelName),
    normalizeNullableString(entry?.role),
    normalizeNullableString(entry?.source) || 'unknown',
    normalizeNullableString(entry?.model),
    normalizeNullableString(entry?.runtimeBackend),
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
    recordedAt,
  );

  return {
    ...usage,
    recordedAt,
  };
}

export async function listRuntimeUsageHistory(
  projectRoot,
  {
    days = 90,
    agentType = null,
  } = {},
) {
  const db = await getRuntimeDb(projectRoot);
  const normalizedDays = Number.isInteger(days) && days > 0 ? days : 90;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (normalizedDays - 1));
  const sinceIso = since.toISOString();

  const rows = agentType
    ? db
        .prepare(
          `
            SELECT
              DATE(recorded_at) AS usage_date,
              agent_type,
              COUNT(*) AS recorded_events,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
              COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
              MAX(recorded_at) AS last_recorded_at
            FROM runtime_usage_events
            WHERE recorded_at >= ? AND agent_type = ?
            GROUP BY usage_date, agent_type
            ORDER BY usage_date ASC, agent_type ASC
          `,
        )
        .all(sinceIso, agentType)
    : db
        .prepare(
          `
            SELECT
              DATE(recorded_at) AS usage_date,
              agent_type,
              COUNT(*) AS recorded_events,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
              COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
              MAX(recorded_at) AS last_recorded_at
            FROM runtime_usage_events
            WHERE recorded_at >= ?
            GROUP BY usage_date, agent_type
            ORDER BY usage_date ASC, agent_type ASC
          `,
        )
        .all(sinceIso);

  return rows.map((row) => ({
    date: row.usage_date,
    agentType: row.agent_type,
    recordedEvents: row.recorded_events,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    lastRecordedAt: row.last_recorded_at ?? null,
  }));
}

export async function listRuntimeUsageBreakdown(
  projectRoot,
  {
    days = 90,
    field = 'agentType',
  } = {},
) {
  const fieldMap = {
    agentType: {
      column: 'agent_type',
      key: 'agentType',
    },
    agentName: {
      column: 'agent_name',
      key: 'agentName',
    },
    model: {
      column: 'model',
      key: 'model',
    },
  };
  const selected = fieldMap[field];
  if (!selected) {
    throw new Error(`Unsupported runtime usage breakdown field "${field}".`);
  }

  const db = await getRuntimeDb(projectRoot);
  const normalizedDays = Number.isInteger(days) && days > 0 ? days : 90;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (normalizedDays - 1));
  const sinceIso = since.toISOString();

  const rows = db
    .prepare(
      `
        SELECT
          ${selected.column} AS group_value,
          COUNT(*) AS recorded_events,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
          COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
          MAX(recorded_at) AS last_recorded_at
        FROM runtime_usage_events
        WHERE recorded_at >= ?
        GROUP BY ${selected.column}
        ORDER BY total_tokens DESC, recorded_events DESC, group_value ASC
      `,
    )
    .all(sinceIso);

  return rows.map((row) => ({
    [selected.key]: row.group_value ?? null,
    recordedEvents: row.recorded_events,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    lastRecordedAt: row.last_recorded_at ?? null,
  }));
}

export async function summarizeRuntimeUsage(projectRoot, { agentType = null } = {}) {
  const db = await getRuntimeDb(projectRoot);
  const rows = agentType
    ? db
        .prepare(
          `
            SELECT
              agent_type,
              COUNT(*) AS recorded_events,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
              COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
              MAX(recorded_at) AS last_recorded_at
            FROM runtime_usage_events
            WHERE agent_type = ?
            GROUP BY agent_type
          `,
        )
        .all(agentType)
    : db
        .prepare(
          `
            SELECT
              agent_type,
              COUNT(*) AS recorded_events,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
              COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
              MAX(recorded_at) AS last_recorded_at
            FROM runtime_usage_events
            GROUP BY agent_type
          `,
        )
        .all();

  return Object.fromEntries(
    rows.map((row) => [
      row.agent_type,
      {
        recordedEvents: row.recorded_events,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
        cacheCreationInputTokens: row.cache_creation_input_tokens,
        cacheReadInputTokens: row.cache_read_input_tokens,
        lastRecordedAt: row.last_recorded_at ?? null,
      },
    ]),
  );
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

export async function createKakaoRelaySession(projectRoot) {
  const db = await getRuntimeDb(projectRoot);
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashKakaoRelayToken(sessionToken);
  const pairingCode = createKakaoRelayPairingCode();
  const now = timestamp();
  const expiresAt = new Date(Date.now() + KAKAO_RELAY_SESSION_TTL_MS).toISOString();

  db.prepare(
    `
      INSERT INTO kakao_relay_sessions (
        token_hash,
        pairing_code,
        status,
        expires_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, 'pending_pairing', ?, ?, ?)
    `,
  ).run(tokenHash, pairingCode, expiresAt, now, now);

  return {
    sessionToken,
    tokenHash,
    pairingCode,
    expiresIn: Math.floor(KAKAO_RELAY_SESSION_TTL_MS / 1000),
    status: 'pending_pairing',
    expiresAt,
  };
}

export async function findKakaoRelaySessionByToken(projectRoot, sessionToken) {
  const tokenHash = hashKakaoRelayToken(sessionToken);
  if (!tokenHash) {
    return null;
  }
  const db = await getRuntimeDb(projectRoot);
  expireKakaoRelaySessions(db);
  const row = db
    .prepare(
      `
        SELECT
          token_hash,
          pairing_code,
          status,
          paired_conversation_key,
          expires_at,
          paired_at,
          created_at,
          updated_at
        FROM kakao_relay_sessions
        WHERE token_hash = ?
      `,
    )
    .get(tokenHash);
  return row ? mapKakaoRelaySessionRow(row) : null;
}

export async function getKakaoRelaySessionStatus(projectRoot, sessionToken) {
  const session = await findKakaoRelaySessionByToken(projectRoot, sessionToken);
  if (!session) {
    return null;
  }
  const userId = session.pairedConversationKey
    ? session.pairedConversationKey.split(':').slice(1).join(':') || null
    : null;
  return {
    status: session.status,
    pairedAt: session.pairedAt,
    kakaoUserId: userId,
  };
}

export async function upsertKakaoRelayConversation(
  projectRoot,
  {
    conversationKey,
    channelId,
    userId,
    callbackUrl = null,
    callbackExpiresAt = null,
  },
) {
  const db = await getRuntimeDb(projectRoot);
  const now = timestamp();
  const existing = db
    .prepare(
      `
        SELECT
          conversation_key,
          channel_id,
          user_id,
          token_hash,
          state,
          last_callback_url,
          last_callback_expires_at,
          paired_at,
          created_at,
          updated_at
        FROM kakao_relay_conversations
        WHERE conversation_key = ?
      `,
    )
    .get(conversationKey);

  db.prepare(
    `
      INSERT INTO kakao_relay_conversations (
        conversation_key,
        channel_id,
        user_id,
        token_hash,
        state,
        last_callback_url,
        last_callback_expires_at,
        paired_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        channel_id = excluded.channel_id,
        user_id = excluded.user_id,
        last_callback_url = excluded.last_callback_url,
        last_callback_expires_at = excluded.last_callback_expires_at,
        updated_at = excluded.updated_at
    `,
  ).run(
    conversationKey,
    normalizeNullableString(channelId) || 'default',
    normalizeNullableString(userId),
    existing?.token_hash || null,
    existing?.state || 'unpaired',
    normalizeNullableString(callbackUrl),
    normalizeNullableString(callbackExpiresAt),
    existing?.paired_at || null,
    existing?.created_at || now,
    now,
  );

  const row = db
    .prepare(
      `
        SELECT
          conversation_key,
          channel_id,
          user_id,
          token_hash,
          state,
          last_callback_url,
          last_callback_expires_at,
          paired_at,
          created_at,
          updated_at
        FROM kakao_relay_conversations
        WHERE conversation_key = ?
      `,
    )
    .get(conversationKey);
  return row ? mapKakaoRelayConversationRow(row) : null;
}

export async function pairKakaoRelayConversation(projectRoot, { pairingCode, conversationKey }) {
  const db = await getRuntimeDb(projectRoot);
  expireKakaoRelaySessions(db);
  const code = String(pairingCode || '').trim().toUpperCase();
  if (!code) {
    return null;
  }
  const session = db
    .prepare(
      `
        SELECT
          token_hash,
          pairing_code,
          status,
          paired_conversation_key,
          expires_at,
          paired_at,
          created_at,
          updated_at
        FROM kakao_relay_sessions
        WHERE pairing_code = ?
          AND status = 'pending_pairing'
      `,
    )
    .get(code);
  if (!session) {
    return null;
  }

  const now = timestamp();
  db.prepare(
    `
      UPDATE kakao_relay_sessions
      SET status = 'paired',
          paired_conversation_key = ?,
          paired_at = ?,
          updated_at = ?
      WHERE token_hash = ?
    `,
  ).run(conversationKey, now, now, session.token_hash);

  db.prepare(
    `
      UPDATE kakao_relay_conversations
      SET token_hash = ?,
          state = 'paired',
          paired_at = COALESCE(paired_at, ?),
          updated_at = ?
      WHERE conversation_key = ?
    `,
  ).run(session.token_hash, now, now, conversationKey);

  return {
    ...mapKakaoRelaySessionRow(session),
    status: 'paired',
    pairedConversationKey: conversationKey,
    pairedAt: now,
  };
}

export async function unpairKakaoRelayConversation(projectRoot, conversationKey) {
  const db = await getRuntimeDb(projectRoot);
  const conversation = db
    .prepare(
      `
        SELECT token_hash
        FROM kakao_relay_conversations
        WHERE conversation_key = ?
      `,
    )
    .get(conversationKey);
  const now = timestamp();
  db.prepare(
    `
      UPDATE kakao_relay_conversations
      SET state = 'unpaired',
          token_hash = NULL,
          updated_at = ?
      WHERE conversation_key = ?
    `,
  ).run(now, conversationKey);
  if (conversation?.token_hash) {
    db.prepare(
      `
        UPDATE kakao_relay_sessions
        SET status = 'disconnected',
            updated_at = ?
        WHERE token_hash = ?
      `,
    ).run(now, conversation.token_hash);
  }
}

export async function createKakaoRelayInboundMessage(
  projectRoot,
  {
    tokenHash,
    conversationKey,
    kakaoPayload,
    normalized,
    callbackUrl = null,
    callbackExpiresAt = null,
  },
) {
  const db = await getRuntimeDb(projectRoot);
  const id = crypto.randomUUID();
  const now = timestamp();
  db.prepare(
    `
      INSERT INTO kakao_relay_messages (
        id,
        token_hash,
        conversation_key,
        kakao_payload_json,
        normalized_json,
        callback_url,
        callback_expires_at,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `,
  ).run(
    id,
    tokenHash,
    conversationKey,
    JSON.stringify(kakaoPayload || {}),
    JSON.stringify(normalized || {}),
    normalizeNullableString(callbackUrl),
    normalizeNullableString(callbackExpiresAt),
    now,
  );

  return {
    id,
    tokenHash,
    conversationKey,
    kakaoPayload: kakaoPayload || {},
    normalized: normalized || {},
    callbackUrl: normalizeNullableString(callbackUrl),
    callbackExpiresAt: normalizeNullableString(callbackExpiresAt),
    status: 'queued',
    createdAt: now,
  };
}

export async function getKakaoRelayInboundMessageForToken(projectRoot, { tokenHash, messageId }) {
  const db = await getRuntimeDb(projectRoot);
  const row = db
    .prepare(
      `
        SELECT
          id,
          token_hash,
          conversation_key,
          kakao_payload_json,
          normalized_json,
          callback_url,
          callback_expires_at,
          status,
          created_at,
          replied_at,
          error_text
        FROM kakao_relay_messages
        WHERE id = ?
          AND token_hash = ?
      `,
    )
    .get(messageId, tokenHash);
  return row ? mapKakaoRelayMessageRow(row) : null;
}

export async function markKakaoRelayMessageReplied(projectRoot, messageId) {
  const db = await getRuntimeDb(projectRoot);
  db.prepare(
    `
      UPDATE kakao_relay_messages
      SET status = 'sent',
          replied_at = ?,
          error_text = NULL
      WHERE id = ?
    `,
  ).run(timestamp(), messageId);
}

export async function markKakaoRelayMessageFailed(projectRoot, { messageId, error }) {
  const db = await getRuntimeDb(projectRoot);
  db.prepare(
    `
      UPDATE kakao_relay_messages
      SET status = 'failed',
          error_text = ?
      WHERE id = ?
    `,
  ).run(toErrorMessage(error), messageId);
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

export async function getManagedServiceEnvSnapshot(projectRoot, { platform, agentName }) {
  const db = await getRuntimeDb(projectRoot);
  const row = db
    .prepare(
      `
        SELECT env_json
        FROM managed_service_env_snapshots
        WHERE platform = ?
          AND agent_name = ?
      `,
    )
    .get(normalizeManagedServicePlatform(platform), normalizeManagedServiceAgentName(agentName));

  if (!row?.env_json) {
    return null;
  }

  try {
    return normalizeManagedServiceEnvSnapshot(JSON.parse(row.env_json));
  } catch {
    return null;
  }
}

export async function setManagedServiceEnvSnapshot(projectRoot, { platform, agentName, env }) {
  const db = await getRuntimeDb(projectRoot);
  const normalizedPlatform = normalizeManagedServicePlatform(platform);
  const normalizedAgentName = normalizeManagedServiceAgentName(agentName);
  const normalizedEnv = normalizeManagedServiceEnvSnapshot(env);
  db.prepare(
    `
      INSERT INTO managed_service_env_snapshots (
        platform,
        agent_name,
        env_json,
        updated_at
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, agent_name) DO UPDATE SET
        env_json = excluded.env_json,
        updated_at = excluded.updated_at
    `,
  ).run(
    normalizedPlatform,
    normalizedAgentName,
    JSON.stringify(normalizedEnv),
    timestamp(),
  );
  return normalizedEnv;
}

export async function deleteManagedServiceEnvSnapshot(projectRoot, { platform, agentName }) {
  const db = await getRuntimeDb(projectRoot);
  db.prepare(
    `
      DELETE FROM managed_service_env_snapshots
      WHERE platform = ?
        AND agent_name = ?
    `,
  ).run(normalizeManagedServicePlatform(platform), normalizeManagedServiceAgentName(agentName));
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
    CREATE TABLE IF NOT EXISTS managed_service_env_snapshots (
      platform TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      env_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (platform, agent_name)
    );
    CREATE TABLE IF NOT EXISTS runtime_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_type TEXT NOT NULL,
      agent_name TEXT,
      channel_name TEXT,
      role TEXT,
      source TEXT NOT NULL,
      model TEXT,
      runtime_backend TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kakao_relay_sessions (
      token_hash TEXT PRIMARY KEY,
      pairing_code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      paired_conversation_key TEXT,
      expires_at TEXT NOT NULL,
      paired_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kakao_relay_conversations (
      conversation_key TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT,
      token_hash TEXT,
      state TEXT NOT NULL,
      last_callback_url TEXT,
      last_callback_expires_at TEXT,
      paired_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (token_hash) REFERENCES kakao_relay_sessions(token_hash) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS kakao_relay_messages (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      kakao_payload_json TEXT NOT NULL,
      normalized_json TEXT NOT NULL,
      callback_url TEXT,
      callback_expires_at TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      replied_at TEXT,
      error_text TEXT,
      FOREIGN KEY (token_hash) REFERENCES kakao_relay_sessions(token_hash) ON DELETE CASCADE,
      FOREIGN KEY (conversation_key) REFERENCES kakao_relay_conversations(conversation_key) ON DELETE CASCADE
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
    CREATE INDEX IF NOT EXISTS managed_service_env_snapshots_updated_at_idx
      ON managed_service_env_snapshots(updated_at DESC);
    CREATE INDEX IF NOT EXISTS runtime_usage_events_agent_type_idx
      ON runtime_usage_events(agent_type, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS kakao_relay_sessions_pairing_code_idx
      ON kakao_relay_sessions(pairing_code);
    CREATE INDEX IF NOT EXISTS kakao_relay_sessions_status_idx
      ON kakao_relay_sessions(status, expires_at);
    CREATE INDEX IF NOT EXISTS kakao_relay_conversations_token_idx
      ON kakao_relay_conversations(token_hash, updated_at DESC);
    CREATE INDEX IF NOT EXISTS kakao_relay_messages_token_idx
      ON kakao_relay_messages(token_hash, created_at DESC);
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

function normalizeManagedServicePlatform(platform) {
  const normalized = String(platform || '').trim().toLowerCase();
  assert(
    normalized === 'discord' || normalized === 'telegram' || normalized === 'kakao',
    'platform must be discord, telegram, or kakao.',
  );
  return normalized;
}

function normalizeManagedServiceAgentName(agentName) {
  const normalized = String(agentName || '').trim();
  assert(normalized, 'agentName is required.');
  return normalized;
}

function hashKakaoRelayToken(token) {
  const normalized = normalizeNullableString(token);
  return normalized ? crypto.createHash('sha256').update(normalized).digest('hex') : '';
}

function createKakaoRelayPairingCode() {
  let output = '';
  for (let index = 0; index < 8; index += 1) {
    const randomIndex = crypto.randomInt(0, KAKAO_RELAY_PAIRING_CODE_CHARS.length);
    output += KAKAO_RELAY_PAIRING_CODE_CHARS[randomIndex];
  }
  return `${output.slice(0, 4)}-${output.slice(4)}`;
}

function expireKakaoRelaySessions(db) {
  db.prepare(
    `
      UPDATE kakao_relay_sessions
      SET status = 'expired',
          updated_at = ?
      WHERE status = 'pending_pairing'
        AND expires_at <= ?
    `,
  ).run(timestamp(), timestamp());
}

function mapKakaoRelaySessionRow(row) {
  return {
    tokenHash: row.token_hash,
    pairingCode: row.pairing_code,
    status: row.status,
    pairedConversationKey: row.paired_conversation_key ?? null,
    expiresAt: row.expires_at,
    pairedAt: row.paired_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapKakaoRelayConversationRow(row) {
  return {
    conversationKey: row.conversation_key,
    channelId: row.channel_id,
    userId: row.user_id ?? null,
    tokenHash: row.token_hash ?? null,
    state: row.state,
    lastCallbackUrl: row.last_callback_url ?? null,
    lastCallbackExpiresAt: row.last_callback_expires_at ?? null,
    pairedAt: row.paired_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapKakaoRelayMessageRow(row) {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    conversationKey: row.conversation_key,
    kakaoPayload: parseRuntimeJson(row.kakao_payload_json, {}),
    normalized: parseRuntimeJson(row.normalized_json, {}),
    callbackUrl: row.callback_url ?? null,
    callbackExpiresAt: row.callback_expires_at ?? null,
    status: row.status,
    createdAt: row.created_at,
    repliedAt: row.replied_at ?? null,
    errorText: row.error_text ?? null,
  };
}

function parseRuntimeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeManagedServiceEnvSnapshot(env) {
  const snapshot = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (typeof key !== 'string' || !key) {
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    snapshot[key] = String(value);
  }
  return Object.fromEntries(
    Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)),
  );
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

function normalizeUsageEntry(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = normalizeUsageInteger(usage.inputTokens);
  const outputTokens = normalizeUsageInteger(usage.outputTokens);
  const totalTokens = normalizeUsageInteger(usage.totalTokens);
  const cacheCreationInputTokens = normalizeUsageInteger(usage.cacheCreationInputTokens);
  const cacheReadInputTokens = normalizeUsageInteger(usage.cacheReadInputTokens);

  if (
    inputTokens === null &&
    outputTokens === null &&
    totalTokens === null &&
    cacheCreationInputTokens === null &&
    cacheReadInputTokens === null
  ) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens:
      totalTokens ??
      (inputTokens !== null || outputTokens !== null
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : null),
    cacheCreationInputTokens: cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: cacheReadInputTokens ?? 0,
  };
}

function normalizeUsageInteger(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return Math.round(numeric);
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
