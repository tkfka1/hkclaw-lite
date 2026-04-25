import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildKakaoSkillResponses,
  formatKakaoRoleMessage,
  getDefaultKakaoRelayUrl,
  parseKakaoSseChunk,
  resolveKakaoChannelForMessage,
  stripMarkdown,
} from '../src/kakao-service.js';

test('kakao default relay URL can be overridden by deployment environment', () => {
  const previous = process.env.OPENCLAW_TALKCHANNEL_RELAY_URL;
  process.env.OPENCLAW_TALKCHANNEL_RELAY_URL = 'https://kakao-relay.example';

  try {
    assert.equal(getDefaultKakaoRelayUrl(), 'https://kakao-relay.example/');
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_TALKCHANNEL_RELAY_URL;
    } else {
      process.env.OPENCLAW_TALKCHANNEL_RELAY_URL = previous;
    }
  }
});

test('kakao SSE parser returns complete events and keeps partial data', () => {
  const chunk = [
    'id: 1',
    'event: message',
    'data: {"id":"m1","normalized":{"userId":"u1","channelId":"c1","text":"hi"}}',
    '',
    'event: pairing_complete',
    'data: {"kakaoUserId":"u1","pairedAt":"now"}',
    '',
    'event: message',
    'data: {"id"',
  ].join('\n');

  const parsed = parseKakaoSseChunk(chunk);

  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0].event, 'message');
  assert.equal(parsed.events[0].id, '1');
  assert.equal(parsed.events[0].data.id, 'm1');
  assert.equal(parsed.events[1].event, 'pairing_complete');
  assert.equal(parsed.parseErrors, 0);
  assert.equal(chunk.slice(parsed.consumed), 'event: message\ndata: {"id"');
});

test('kakao formatter strips markdown and preserves tribunal role labels', () => {
  const channel = { name: 'kakao-main', mode: 'tribunal' };
  const message = formatKakaoRoleMessage(channel, {
    role: 'reviewer',
    agent: { name: 'reviewer' },
    content: '**BLOCKED**: `fix` this',
    mode: 'tribunal',
    round: 1,
    maxRounds: 2,
    verdict: 'blocked',
  });

  assert.match(message, /reviewer 판정 · reviewer/u);
  assert.match(message, /kakao-main · 1\/2 · 수정 필요/u);
  assert.match(stripMarkdown(message), /BLOCKED: fix this/u);
});

test('kakao responses support plain text chunking and card JSON', () => {
  const plain = buildKakaoSkillResponses('**hello** world');
  assert.equal(plain[0].version, '2.0');
  assert.equal(plain[0].template.outputs[0].simpleText.text, 'hello world');

  const card = buildKakaoSkillResponses('{"textCard":{"title":"제목","description":"설명"},"quickReplies":[{"label":"A","action":"message","messageText":"A"}]}');
  assert.equal(card.length, 1);
  assert.deepEqual(card[0].template.outputs[0], {
    textCard: { title: '제목', description: '설명' },
  });
  assert.equal(card[0].template.quickReplies[0].label, 'A');
});

test('kakao channel resolver matches wildcard channel and optional user', () => {
  const config = {
    channels: {
      main: {
        name: 'main',
        platform: 'kakao',
        kakaoChannelId: '*',
        kakaoUserId: 'user-1',
        agent: 'owner',
      },
      other: {
        name: 'other',
        platform: 'kakao',
        kakaoChannelId: 'specific',
        agent: 'owner',
      },
    },
  };
  const match = resolveKakaoChannelForMessage(
    config,
    { normalized: { userId: 'user-1', channelId: 'anything', text: 'hi' } },
    'owner',
  );
  assert.equal(match.name, 'main');

  const miss = resolveKakaoChannelForMessage(
    config,
    { normalized: { userId: 'user-2', channelId: 'anything', text: 'hi' } },
    'owner',
  );
  assert.equal(miss, undefined);
});
