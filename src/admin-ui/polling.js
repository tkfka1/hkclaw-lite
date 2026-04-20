export const AI_MANAGER_STATUS_POLL_SCHEDULE_MS = Object.freeze([
  5_000,
  60_000,
  60_000,
  60_000,
  60_000,
  60_000,
]);

export const AI_MANAGER_STATUS_POLL_MAX_ATTEMPTS = AI_MANAGER_STATUS_POLL_SCHEDULE_MS.length;

export function getAiManagerStatusPollDelay(attempt) {
  const normalizedAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  const index = Math.min(
    normalizedAttempt - 1,
    AI_MANAGER_STATUS_POLL_SCHEDULE_MS.length - 1,
  );
  return AI_MANAGER_STATUS_POLL_SCHEDULE_MS[index];
}
