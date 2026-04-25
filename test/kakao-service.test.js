import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildKakaoSkillResponses,
  formatKakaoRoleMessage,
  getDefaultKakaoRelayUrl,
  buildKakaoAgentStatusEntry,
  parseKakaoSseChunk,
  resolveKakaoChannelForMessage,
  stripMarkdown,
} from '../src/kakao-service.js';
import { initProject } from '../src/store.js';

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, 'bin', 'hkclaw-lite.js');

function createProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-kakao-test-'));
}

function waitForProcessOutput(child, matcher, getOutput, timeoutMs = 3000) {
  if (matcher.test(getOutput())) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for process output. Current output:\n${getOutput()}`));
    }, timeoutMs);
    const onData = () => {
      if (matcher.test(getOutput())) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Process exited before expected output. code=${code} signal=${signal}\n${getOutput()}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

function waitForProcessExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for process exit.'));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
    };
    child.on('exit', onExit);
  });
}

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

test('kakao serve stays alive when no Kakao agents are configured yet', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const child = spawn(process.execPath, [cliPath, 'kakao', 'serve'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForProcessOutput(
      child,
      /Kakao TalkChannel service ready/u,
      () => `${stdout}\n${stderr}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.equal(child.exitCode, null, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.equal(child.signalCode, null, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.doesNotMatch(stderr, /unsettled top-level await/iu);

    child.kill('SIGTERM');
    const exit = await waitForProcessExit(child);
    assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForProcessExit(child).catch(() => {});
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

test('kakao channel resolver can route by connector instead of owner agent', () => {
  const config = {
    connectors: {
      kakaoMain: {
        type: 'kakao',
      },
    },
    channels: {
      main: {
        name: 'main',
        platform: 'kakao',
        connector: 'kakaoMain',
        kakaoChannelId: '*',
        agent: 'owner',
      },
      legacy: {
        name: 'legacy',
        platform: 'kakao',
        kakaoChannelId: '*',
        agent: 'kakaoMain',
      },
    },
  };

  const connectorMatch = resolveKakaoChannelForMessage(
    config,
    { normalized: { userId: 'user-1', channelId: 'anything', text: 'hi' } },
    'kakaoMain',
  );

  assert.equal(connectorMatch.name, 'main');
});

test('buildKakaoAgentStatusEntry reflects configured kakao relay credentials', () => {
  const connectorConfig = {
    name: 'kakao-main',
    agent: 'owner',
    relayUrl: getDefaultKakaoRelayUrl(),
    relayToken: '',
    sessionToken: '',
  };

  const withToken = buildKakaoAgentStatusEntry(connectorConfig, { tokenConfigured: false, connected: false });
  assert.equal(withToken.tokenConfigured, false);
  assert.equal(withToken.connected, false);

  const connectorWithClientToken = buildKakaoAgentStatusEntry(connectorConfig, {
    tokenConfigured: true,
    connected: false,
  });
  assert.equal(connectorWithClientToken.tokenConfigured, true);

  const connectorWithRelayToken = buildKakaoAgentStatusEntry(connectorConfig, {
    tokenConfigured: false,
    connected: false,
    relayUrl: getDefaultKakaoRelayUrl(),
  });
  assert.equal(connectorWithRelayToken.tokenConfigured, false);

  const connectorWithAgentToken = buildKakaoAgentStatusEntry(
    { ...connectorConfig, relayToken: 'agent-token' },
    { tokenConfigured: false, connected: false },
  );
  assert.equal(connectorWithAgentToken.tokenConfigured, true);

  const connectorWithSessionToken = buildKakaoAgentStatusEntry(
    { ...connectorConfig, relayToken: '', sessionToken: 'session-token' },
    { tokenConfigured: false, connected: false },
  );
  assert.equal(connectorWithSessionToken.tokenConfigured, true);
});
