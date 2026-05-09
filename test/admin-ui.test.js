import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getClaudeRuntimeSourceBadge,
  getClaudeRuntimeSourceHintLines,
} from '../src/admin-ui/claude-runtime-ui.js';
import {
  applyTelegramRecentChatToDraft,
  formatTelegramRecentChatTitle,
  getTelegramRecentChatCandidates,
} from '../src/admin-ui/telegram-discovery.js';
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

test('Claude runtime UI helpers distinguish system and external CLI labels', () => {
  assert.deepEqual(
    getClaudeRuntimeSourceBadge({
      runtimeSource: 'system',
      runtimeDetail: 'claude (/usr/local/bin/claude)',
    }),
    {
      label: 'Claude CLI',
      ok: true,
      title: 'claude (/usr/local/bin/claude)',
    },
  );
  assert.deepEqual(
    getClaudeRuntimeSourceBadge({
      runtimeSource: 'external',
      runtimeDetail: 'external Claude CLI (/usr/bin/claude)',
    }),
    {
      label: '외부 Claude CLI',
      ok: true,
      title: 'external Claude CLI (/usr/bin/claude)',
    },
  );
  assert.equal(getClaudeRuntimeSourceBadge({ runtimeSource: 'unknown' }), null);
  assert.deepEqual(
    getClaudeRuntimeSourceHintLines({
      runtimeSource: 'external',
      runtimePackageName: '',
      runtimePackageVersion: '',
      runtimeDetail: 'external Claude CLI (/usr/bin/claude)',
    }),
    [
      '런타임: 외부 Claude CLI',
      'HKCLAW_LITE_CLAUDE_CLI 가 가리키는 외부 Claude CLI 를 사용 중입니다.',
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

test('telegram recent chat apply preserves group thread ids from a direct draft', () => {
  const draft = {
    platform: 'telegram',
    targetType: 'direct',
    telegramChatId: '',
    telegramThreadId: '',
    agent: '',
  };

  assert.equal(
    applyTelegramRecentChatToDraft(draft, {
      agentName: 'telegram-worker',
      chatId: '-1001234567890',
      threadId: '77',
      chatType: 'supergroup',
    }),
    draft,
  );

  assert.deepEqual(draft, {
    platform: 'telegram',
    targetType: 'channel',
    telegramChatId: '-1001234567890',
    telegramThreadId: '77',
    agent: 'telegram-worker',
  });
});

test('telegram recent chat apply clears private threads without replacing selected agent', () => {
  const draft = {
    platform: 'telegram',
    targetType: 'channel',
    telegramChatId: '-1001234567890',
    telegramThreadId: '77',
    agent: 'owner',
  };

  applyTelegramRecentChatToDraft(draft, {
    agentName: 'other-worker',
    chatId: '12345',
    threadId: '88',
    chatType: 'private',
  });

  assert.deepEqual(draft, {
    platform: 'telegram',
    targetType: 'direct',
    telegramChatId: '12345',
    telegramThreadId: '',
    agent: 'owner',
  });
});

test('telegram recent chat picker filters by selected agent and formats fallback titles', () => {
  assert.deepEqual(
    getTelegramRecentChatCandidates(
      { agent: 'owner' },
      [
        { agentName: 'owner', chatId: '1', title: 'Ops' },
        { agentName: 'reviewer', chatId: '2', title: 'Review' },
        { agentName: '', chatId: '3', fromUsername: 'alice' },
        { agentName: 'owner', chatId: '', title: 'Missing id' },
      ],
    ).map((entry) => entry.chatId),
    ['1', '3'],
  );
  assert.equal(formatTelegramRecentChatTitle({ fromUsername: 'alice' }), '@alice');
  assert.equal(formatTelegramRecentChatTitle({ type: 'private' }), 'Telegram 개인 대화');
});
