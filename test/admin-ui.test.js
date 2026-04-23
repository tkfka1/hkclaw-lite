import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getClaudeRuntimeSourceBadge,
  getClaudeRuntimeSourceHintLines,
} from '../src/admin-ui/claude-runtime-ui.js';
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

test('Claude runtime UI helpers distinguish bundled and external CLI labels', () => {
  assert.deepEqual(
    getClaudeRuntimeSourceBadge({
      runtimeSource: 'bundled',
      runtimeDetail: 'bundled Claude CLI (/app/vendor/claude)',
    }),
    {
      label: '번들 Claude CLI',
      ok: true,
      title: 'bundled Claude CLI (/app/vendor/claude)',
    },
  );
  assert.deepEqual(
    getClaudeRuntimeSourceBadge({
      runtimeSource: 'external',
      runtimeDetail: 'external Claude CLI (/usr/bin/claude)',
    }),
    {
      label: '외부 Claude CLI',
      ok: false,
      title: 'external Claude CLI (/usr/bin/claude)',
    },
  );
  assert.equal(getClaudeRuntimeSourceBadge({ runtimeSource: 'unknown' }), null);
  assert.deepEqual(
    getClaudeRuntimeSourceHintLines({
      runtimeSource: 'external',
      runtimeDetail: 'external Claude CLI (/usr/bin/claude)',
    }),
    [
      '런타임: 외부 Claude CLI',
      '세부: external Claude CLI (/usr/bin/claude)',
    ],
  );
});
