import fs from 'node:fs';
import crypto from 'node:crypto';

import { executeChannelTurn } from './channel-runtime.js';
import {
  claimRuntimeSchedule,
  completeRuntimeScheduleRun,
  createRuntimeScheduleRun,
  deleteRuntimeSchedule,
  failRuntimeScheduleRun,
  getRuntimeSchedule,
  listDueRuntimeSchedules,
  listRuntimeSchedules,
  renewRuntimeScheduleLease,
  upsertRuntimeSchedule,
} from './runtime-db.js';
import {
  getChannel,
  loadConfig,
  resolveProjectPath,
} from './store.js';
import {
  assert,
  isSafeIdentifier,
  timestamp,
  toErrorMessage,
} from './utils.js';

export const DEFAULT_SCHEDULER_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_SCHEDULER_LEASE_MS = 5 * 60 * 1000;
export const SCHEDULER_ENABLED_ENV = 'HKCLAW_LITE_SCHEDULER';
export const SCHEDULER_POLL_INTERVAL_ENV = 'HKCLAW_LITE_SCHEDULER_POLL_MS';

export async function upsertSchedule(projectRoot, currentNameOrId, input = {}) {
  const config = loadConfig(projectRoot);
  const existing = currentNameOrId
    ? await getRuntimeSchedule(projectRoot, currentNameOrId)
    : null;
  const normalized = normalizeScheduleDefinition(input?.definition || input, {
    config,
    existing,
  });
  return await upsertRuntimeSchedule(projectRoot, currentNameOrId, normalized);
}

export async function deleteSchedule(projectRoot, nameOrId) {
  return await deleteRuntimeSchedule(projectRoot, nameOrId);
}

export async function listSchedules(projectRoot, options = {}) {
  return await listRuntimeSchedules(projectRoot, options);
}

export async function runScheduleNow(
  projectRoot,
  nameOrId,
  {
    leaseMs = DEFAULT_SCHEDULER_LEASE_MS,
    leaseOwner = createSchedulerOwner('manual'),
    executeSchedule = executeRuntimeSchedule,
  } = {},
) {
  const schedule = await getRuntimeSchedule(projectRoot, nameOrId);
  assert(schedule, `Unknown schedule "${nameOrId}".`);
  const now = timestamp();
  const claimed = await claimRuntimeSchedule(projectRoot, schedule.scheduleId, {
    leaseOwner,
    leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
    now,
    dueOnly: false,
    requireEnabled: false,
  });
  assert(
    claimed,
    `Schedule "${schedule.name}" is already running. Wait for the lease to expire or finish.`,
  );

  return await executeClaimedSchedule(projectRoot, claimed, {
    dueAt: now,
    leaseOwner,
    leaseMs,
    manual: true,
    executeSchedule,
    throwOnFailure: true,
  });
}

export async function runDueSchedulesOnce(
  projectRoot,
  {
    now = new Date(),
    maxSchedules = 5,
    leaseMs = DEFAULT_SCHEDULER_LEASE_MS,
    leaseOwner = createSchedulerOwner('worker'),
    executeSchedule = executeRuntimeSchedule,
  } = {},
) {
  const nowDate = normalizeDate(now, 'now');
  const nowIso = nowDate.toISOString();
  const due = await listDueRuntimeSchedules(projectRoot, nowIso, {
    limit: maxSchedules,
  });
  const results = [];

  for (const schedule of due) {
    const claimed = await claimRuntimeSchedule(projectRoot, schedule.scheduleId, {
      leaseOwner,
      leaseExpiresAt: new Date(nowDate.getTime() + leaseMs).toISOString(),
      now: nowIso,
      dueOnly: true,
      requireEnabled: true,
    });
    if (!claimed) {
      results.push({
        scheduleName: schedule.name,
        status: 'skipped',
        skipped: true,
        reason: 'lease-not-acquired',
      });
      continue;
    }

    const result = await executeClaimedSchedule(projectRoot, claimed, {
      dueAt: schedule.nextRunAt || nowIso,
      leaseOwner,
      leaseMs,
      manual: false,
      executeSchedule,
      throwOnFailure: false,
    });
    results.push(result);
  }

  return results;
}

export function startScheduler(
  projectRoot,
  {
    pollIntervalMs = resolveSchedulerPollInterval(),
    leaseMs = DEFAULT_SCHEDULER_LEASE_MS,
    maxSchedules = 5,
    executeSchedule = executeRuntimeSchedule,
    env = process.env,
  } = {},
) {
  if (!isSchedulerEnabled(env?.[SCHEDULER_ENABLED_ENV])) {
    return {
      enabled: false,
      owner: null,
      stop() {},
    };
  }

  const owner = createSchedulerOwner('admin');
  const intervalMs = normalizePositiveMs(pollIntervalMs, DEFAULT_SCHEDULER_POLL_INTERVAL_MS);
  let stopped = false;
  let running = false;
  let timer = null;

  const tick = async () => {
    if (stopped) {
      return;
    }
    if (running) {
      scheduleNextTick();
      return;
    }
    running = true;
    try {
      await runDueSchedulesOnce(projectRoot, {
        maxSchedules,
        leaseMs,
        leaseOwner: owner,
        executeSchedule,
      });
    } catch (error) {
      console.error(`Scheduler tick failed: ${toErrorMessage(error)}`);
    } finally {
      running = false;
      scheduleNextTick();
    }
  };

  const scheduleNextTick = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
  };

  timer = setTimeout(() => {
    void tick();
  }, 0);
  timer.unref?.();

  return {
    enabled: true,
    owner,
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export function normalizeScheduleDefinition(input = {}, { config, existing = null } = {}) {
  const name = normalizeScheduleName(input.name ?? existing?.name);
  const enabledInput =
    input.disabled !== undefined
      ? !normalizeBoolean(input.disabled, false)
      : input.enabled;
  const enabled = normalizeBoolean(enabledInput, existing?.enabled ?? true);
  const targetType = normalizeTargetType(input.targetType ?? input.target ?? existing?.targetType);
  const channelName = normalizeOptionalString(
    input.channelName ??
      input.channel ??
      input['channel-name'] ??
      existing?.channelName,
  );
  assert(targetType === 'channel', 'Only channel schedules are supported.');
  assert(channelName, 'Schedule channel is required.');
  if (config) {
    getChannel(config, channelName);
  }

  const prompt = normalizeOptionalString(
    input.prompt ??
      input.message ??
      input.commandPrompt ??
      input['message'] ??
      existing?.prompt,
  );
  assert(prompt, 'Schedule prompt is required.');

  const scheduleType = inferScheduleType(input, existing);
  const skillName = normalizeOptionalString(
    input.skillName ?? input.skill ?? input['skill-name'] ?? existing?.skillName,
  );
  const normalized = {
    name,
    enabled,
    targetType,
    channelName,
    prompt,
    skillName,
    scheduleType,
    intervalMs: null,
    timeOfDay: null,
    timezone: null,
    nextRunAt: null,
  };

  if (scheduleType === 'interval') {
    normalized.intervalMs = parseDurationMs(
      input.intervalMs ??
        input['interval-ms'] ??
        input.every ??
        input.interval ??
        existing?.intervalMs,
    );
  } else if (scheduleType === 'daily') {
    normalized.timeOfDay = normalizeTimeOfDay(
      input.timeOfDay ??
        input['time-of-day'] ??
        input.daily ??
        existing?.timeOfDay,
    );
    normalized.timezone = normalizeTimezone(
      input.timezone ??
        input.tz ??
        existing?.timezone ??
        getDefaultTimezone(),
    );
  } else {
    throw new Error(`Unsupported schedule type "${scheduleType}".`);
  }

  const explicitNextRunAt = normalizeOptionalString(
    input.nextRunAt ?? input['next-run-at'] ?? input.next,
  );
  if (explicitNextRunAt) {
    normalized.nextRunAt = normalizeIsoDateString(explicitNextRunAt, 'nextRunAt');
  } else if (shouldPreserveNextRunAt(existing, normalized)) {
    normalized.nextRunAt = existing.nextRunAt;
  } else {
    normalized.nextRunAt = computeNextRunAt(normalized, { after: new Date() });
  }

  return normalized;
}

export function computeNextRunAt(schedule, { after = new Date() } = {}) {
  const afterDate = normalizeDate(after, 'after');
  if (schedule?.scheduleType === 'interval') {
    const intervalMs = parseDurationMs(schedule.intervalMs);
    return new Date(afterDate.getTime() + intervalMs).toISOString();
  }
  if (schedule?.scheduleType === 'daily') {
    return computeNextDailyRunAt({
      after: afterDate,
      timeOfDay: normalizeTimeOfDay(schedule.timeOfDay),
      timezone: normalizeTimezone(schedule.timezone || getDefaultTimezone()),
    });
  }
  throw new Error(`Unsupported schedule type "${schedule?.scheduleType || ''}".`);
}

export function parseDurationMs(value) {
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'Schedule interval must be a finite number.');
    const rounded = Math.round(value);
    assert(rounded >= 1000, 'Schedule interval must be at least 1 second.');
    return rounded;
  }
  const text = String(value ?? '').trim();
  assert(text, 'Schedule interval is required.');
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|msec|millisecond|milliseconds|s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)?$/iu);
  assert(match, 'Schedule interval must look like 10m, 1h, 2d, or 60000ms.');
  const amount = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  const multiplier =
    ['ms', 'msec', 'millisecond', 'milliseconds'].includes(unit)
      ? 1
      : ['s', 'sec', 'second', 'seconds'].includes(unit)
        ? 1000
        : ['m', 'min', 'minute', 'minutes'].includes(unit)
          ? 60 * 1000
          : ['h', 'hr', 'hour', 'hours'].includes(unit)
            ? 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;
  const intervalMs = Math.round(amount * multiplier);
  assert(intervalMs >= 1000, 'Schedule interval must be at least 1 second.');
  return intervalMs;
}

export function formatScheduleSummary(schedule) {
  if (schedule?.scheduleType === 'daily') {
    return `daily ${schedule.timeOfDay} ${schedule.timezone || getDefaultTimezone()}`;
  }
  return `every ${formatDurationMs(schedule?.intervalMs || 0)}`;
}

export function formatDurationMs(value) {
  const intervalMs = Number(value || 0);
  if (intervalMs > 0 && intervalMs % (24 * 60 * 60 * 1000) === 0) {
    return `${intervalMs / (24 * 60 * 60 * 1000)}d`;
  }
  if (intervalMs > 0 && intervalMs % (60 * 60 * 1000) === 0) {
    return `${intervalMs / (60 * 60 * 1000)}h`;
  }
  if (intervalMs > 0 && intervalMs % (60 * 1000) === 0) {
    return `${intervalMs / (60 * 1000)}m`;
  }
  if (intervalMs > 0 && intervalMs % 1000 === 0) {
    return `${intervalMs / 1000}s`;
  }
  return `${intervalMs}ms`;
}

async function executeClaimedSchedule(
  projectRoot,
  schedule,
  {
    dueAt,
    leaseOwner,
    leaseMs,
    manual,
    executeSchedule,
    throwOnFailure,
  },
) {
  const scheduleRunId = await createRuntimeScheduleRun(projectRoot, schedule, {
    dueAt,
    leaseOwner,
  });
  const stopHeartbeat = startLeaseHeartbeat(projectRoot, schedule.scheduleId, {
    leaseOwner,
    leaseMs,
  });

  try {
    const result = await executeSchedule(projectRoot, schedule, {
      dueAt,
      manual,
    });
    const nextRunAt = resolvePostRunNextRunAt(schedule, { manual });
    await completeRuntimeScheduleRun(projectRoot, scheduleRunId, {
      scheduleId: schedule.scheduleId,
      runtimeRunId: result?.runId || null,
      nextRunAt,
    });
    return {
      scheduleRunId,
      scheduleName: schedule.name,
      status: 'completed',
      runtimeRunId: result?.runId || null,
      nextRunAt,
      result,
    };
  } catch (error) {
    const nextRunAt = resolvePostRunNextRunAt(schedule, { manual });
    await failRuntimeScheduleRun(projectRoot, scheduleRunId, {
      scheduleId: schedule.scheduleId,
      runtimeRunId: error?.runtimeRunId || null,
      error,
      nextRunAt,
    });
    const failed = {
      scheduleRunId,
      scheduleName: schedule.name,
      status: 'failed',
      runtimeRunId: error?.runtimeRunId || null,
      nextRunAt,
      error: toErrorMessage(error),
    };
    if (throwOnFailure) {
      const nextError = new Error(failed.error);
      nextError.schedule = failed;
      throw nextError;
    }
    return failed;
  } finally {
    stopHeartbeat();
  }
}

function resolvePostRunNextRunAt(schedule, { manual }) {
  if (
    manual &&
    schedule.nextRunAt &&
    new Date(schedule.nextRunAt).getTime() > Date.now()
  ) {
    return schedule.nextRunAt;
  }
  return computeNextRunAt(schedule, { after: new Date() });
}

async function executeRuntimeSchedule(projectRoot, schedule, { dueAt, manual } = {}) {
  assert(schedule?.targetType === 'channel', 'Only channel schedules are supported.');
  const config = loadConfig(projectRoot);
  const channel = getChannel(config, schedule.channelName);
  const workdir = resolveExistingScheduleWorkdir(projectRoot, channel.workspace || channel.workdir);
  return await executeChannelTurn({
    projectRoot,
    config,
    channel,
    prompt: buildScheduledPrompt(schedule, { dueAt, manual }),
    workdir,
  });
}

function buildScheduledPrompt(schedule, { dueAt, manual } = {}) {
  return [
    `Scheduled task: ${schedule.name}`,
    `Trigger: ${manual ? 'manual run' : 'automatic due run'}`,
    dueAt ? `Due at: ${dueAt}` : null,
    schedule.skillName
      ? `Skill hint: use the installed skill "${schedule.skillName}" if it is available to this agent.`
      : null,
    '',
    schedule.prompt,
  ]
    .filter((entry) => entry !== null && entry !== undefined)
    .join('\n');
}

function resolveExistingScheduleWorkdir(projectRoot, workdir) {
  assert(typeof workdir === 'string' && workdir.trim().length > 0, 'Schedule workdir is required.');
  const resolved = resolveProjectPath(projectRoot, workdir);
  assert(fs.existsSync(resolved), `Workdir does not exist: ${resolved}`);
  assert(fs.statSync(resolved).isDirectory(), `Workdir must be a directory: ${resolved}`);
  return resolved;
}

const LEASE_RENEWAL_FAILURE_THRESHOLD = 3;

function startLeaseHeartbeat(projectRoot, scheduleId, { leaseOwner, leaseMs }) {
  const heartbeatMs = Math.max(1000, Math.floor(leaseMs / 2));
  let consecutiveFailures = 0;
  const timer = setInterval(() => {
    void renewRuntimeScheduleLease(projectRoot, scheduleId, {
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
    })
      .then(() => {
        consecutiveFailures = 0;
      })
      .catch((error) => {
        consecutiveFailures += 1;
        console.error(
          `Scheduler lease renewal failed (${consecutiveFailures}/${LEASE_RENEWAL_FAILURE_THRESHOLD}) for schedule ${scheduleId}: ${toErrorMessage(error)}`,
        );
        if (consecutiveFailures >= LEASE_RENEWAL_FAILURE_THRESHOLD) {
          clearInterval(timer);
          console.error(
            `Scheduler lease for ${scheduleId} abandoned after ${LEASE_RENEWAL_FAILURE_THRESHOLD} consecutive renewal failures; another worker may claim it before the in-flight run completes.`,
          );
        }
      });
  }, heartbeatMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function computeNextDailyRunAt({ after, timeOfDay, timezone }) {
  const [hour, minute] = timeOfDay.split(':').map((entry) => Number(entry));
  const local = getZonedDateParts(after, timezone);
  let candidate = zonedTimeToUtc(
    {
      year: local.year,
      month: local.month,
      day: local.day,
      hour,
      minute,
      second: 0,
    },
    timezone,
  );

  if (candidate.getTime() <= after.getTime()) {
    const tomorrow = addCalendarDays(local, 1);
    candidate = zonedTimeToUtc(
      {
        ...tomorrow,
        hour,
        minute,
        second: 0,
      },
      timezone,
    );
  }

  return candidate.toISOString();
}

function zonedTimeToUtc(parts, timezone) {
  let guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0,
  );
  for (let index = 0; index < 4; index += 1) {
    const offset = getTimezoneOffsetMs(new Date(guess), timezone);
    const nextGuess = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second || 0,
    ) - offset;
    if (Math.abs(nextGuess - guess) < 1000) {
      guess = nextGuess;
      break;
    }
    guess = nextGuess;
  }
  return new Date(guess);
}

function getTimezoneOffsetMs(date, timezone) {
  const parts = getZonedDateParts(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

function getZonedDateParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const entries = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: entries.year,
    month: entries.month,
    day: entries.day,
    hour: entries.hour,
    minute: entries.minute,
    second: entries.second,
  };
}

function addCalendarDays(parts, days) {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function shouldPreserveNextRunAt(existing, next) {
  if (!existing?.nextRunAt) {
    return false;
  }
  if (new Date(existing.nextRunAt).getTime() <= Date.now()) {
    return false;
  }
  return (
    existing.enabled === next.enabled &&
    existing.targetType === next.targetType &&
    existing.channelName === next.channelName &&
    existing.scheduleType === next.scheduleType &&
    Number(existing.intervalMs || 0) === Number(next.intervalMs || 0) &&
    String(existing.timeOfDay || '') === String(next.timeOfDay || '') &&
    String(existing.timezone || '') === String(next.timezone || '')
  );
}

function inferScheduleType(input, existing) {
  const explicit = normalizeOptionalString(
    input.scheduleType ?? input['schedule-type'] ?? input.type ?? existing?.scheduleType,
  );
  if (explicit) {
    const normalized = explicit.toLowerCase();
    assert(
      ['interval', 'daily'].includes(normalized),
      'Schedule type must be interval or daily.',
    );
    return normalized;
  }
  if (
    input.intervalMs !== undefined ||
    input['interval-ms'] !== undefined ||
    input.every !== undefined ||
    input.interval !== undefined
  ) {
    return 'interval';
  }
  if (
    input.timeOfDay !== undefined ||
    input['time-of-day'] !== undefined ||
    input.daily !== undefined
  ) {
    return 'daily';
  }
  assert(existing, 'Schedule timing is required. Pass --every or --daily.');
  return existing.scheduleType;
}

function normalizeScheduleName(value) {
  const normalized = normalizeOptionalString(value);
  assert(normalized, 'Schedule name is required.');
  assert(isSafeIdentifier(normalized), 'Schedule name may only contain letters, numbers, dot, underscore, and dash.');
  return normalized;
}

function normalizeTargetType(value) {
  const normalized = normalizeOptionalString(value || 'channel').toLowerCase();
  assert(normalized === 'channel', 'Only channel schedules are supported.');
  return normalized;
}

function normalizeTimeOfDay(value) {
  const normalized = normalizeOptionalString(value);
  assert(normalized, 'Daily schedule time is required.');
  assert(/^([01]\d|2[0-3]):[0-5]\d$/u.test(normalized), 'Daily schedule time must be HH:mm.');
  return normalized;
}

function normalizeTimezone(value) {
  const normalized = normalizeOptionalString(value) || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    throw new Error(`Unsupported timezone "${normalized}".`);
  }
}

function normalizeIsoDateString(value, fieldName) {
  const date = new Date(value);
  assert(!Number.isNaN(date.getTime()), `${fieldName} must be a valid date.`);
  return date.toISOString();
}

function normalizeDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  assert(!Number.isNaN(date.getTime()), `${fieldName} must be a valid date.`);
  return date;
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return Boolean(fallback);
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'y', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'n', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return Boolean(fallback);
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function getDefaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function createSchedulerOwner(prefix) {
  return `${prefix}:${process.pid}:${crypto.randomUUID()}`;
}

function isSchedulerEnabled(value) {
  const normalized = String(value ?? '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'disabled'].includes(normalized);
}

function resolveSchedulerPollInterval() {
  return normalizePositiveMs(
    process.env[SCHEDULER_POLL_INTERVAL_ENV],
    DEFAULT_SCHEDULER_POLL_INTERVAL_MS,
  );
}

function normalizePositiveMs(value, fallbackValue) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallbackValue;
}
