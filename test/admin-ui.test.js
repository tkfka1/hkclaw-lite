import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_MANAGER_STATUS_POLL_MAX_ATTEMPTS,
  AI_MANAGER_STATUS_POLL_SCHEDULE_MS,
  getAiManagerStatusPollDelay,
} from '../src/admin-ui/polling.js';

test('ai manager status polling backs off after the first fast retry', () => {
  assert.deepEqual(AI_MANAGER_STATUS_POLL_SCHEDULE_MS, [
    5_000,
    60_000,
    60_000,
    60_000,
    60_000,
    60_000,
  ]);
  assert.equal(AI_MANAGER_STATUS_POLL_MAX_ATTEMPTS, 6);
  assert.equal(getAiManagerStatusPollDelay(1), 5_000);
  assert.equal(getAiManagerStatusPollDelay(2), 60_000);
  assert.equal(getAiManagerStatusPollDelay(6), 60_000);
  assert.equal(getAiManagerStatusPollDelay(20), 60_000);
});
