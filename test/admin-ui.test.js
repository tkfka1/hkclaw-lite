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
import {
  DESKTOP_NAV_MIN_WIDTH,
  shouldUseDesktopSidebar,
} from '../src/admin-ui/ui-shell.js';

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
      label: '로컬 Claude CLI',
      ok: true,
      title: 'external Claude CLI (/usr/bin/claude)',
    },
  );
  assert.equal(getClaudeRuntimeSourceBadge({ runtimeSource: 'unknown' }), null);
  assert.deepEqual(
    getClaudeRuntimeSourceHintLines({
      runtimeSource: 'external',
      runtimePackageName: '@anthropic-ai/claude-agent-sdk',
      runtimePackageVersion: '0.2.119',
      runtimeDetail: 'external Claude CLI (/usr/bin/claude)',
    }),
    [
      '런타임: 로컬 Claude CLI · @anthropic-ai/claude-agent-sdk v0.2.119',
      '로컬 터미널의 Claude 로그인 상태를 공유합니다. 웹에서는 상태 확인과 테스트만 실행합니다.',
      '경로: external Claude CLI (/usr/bin/claude)',
    ],
  );
});

test('desktop nav helper keeps the sidebar pinned on wide screens only', () => {
  assert.equal(DESKTOP_NAV_MIN_WIDTH, 1081);
  assert.equal(shouldUseDesktopSidebar(900), false);
  assert.equal(shouldUseDesktopSidebar(1080), false);
  assert.equal(shouldUseDesktopSidebar(1081), true);
  assert.equal(shouldUseDesktopSidebar(1440), true);
});
