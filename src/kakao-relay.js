import {
  createKakaoRelayInboundMessage,
  createKakaoRelaySession,
  findKakaoRelaySessionByToken,
  getKakaoRelayInboundMessageForToken,
  getKakaoRelaySessionStatus,
  markKakaoRelayMessageFailed,
  markKakaoRelayMessageReplied,
  pairKakaoRelayConversation,
  unpairKakaoRelayConversation,
  upsertKakaoRelayConversation,
} from './runtime-db.js';
import { toErrorMessage } from './utils.js';

const KAKAO_CALLBACK_TTL_MS = 55_000;
const KAKAO_RELAY_MAX_BODY_BYTES = 1024 * 1024;
const KAKAO_RELAY_ROUTES = [
  '/kakao-talkchannel/',
  '/openclaw/',
  '/v1/events',
  '/v1/healthz',
  '/v1/sessions',
];

const sseClientsByTokenHash = new Map();

export function isKakaoRelayRequest(pathname) {
  return KAKAO_RELAY_ROUTES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

function isKakaoRelayHealthPath(routePath) {
  return [
    '/v1/healthz',
    '/openclaw/healthz',
    '/kakao-talkchannel/healthz',
  ].includes(routePath);
}

function buildKakaoRelayHealth() {
  return {
    ok: true,
    status: 'healthy',
    relay: 'kakao-talkchannel',
    activeEventStreams: countActiveSseClients(),
  };
}

function countActiveSseClients() {
  let count = 0;
  for (const clients of sseClientsByTokenHash.values()) {
    count += [...clients].filter((client) => !client.closed).length;
  }
  return count;
}

export async function handleKakaoRelayRequest(projectRoot, request, response, { pathname } = {}) {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const routePath = pathname || url.pathname;

    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      isKakaoRelayHealthPath(routePath)
    ) {
      writeJson(response, 200, buildKakaoRelayHealth());
      return true;
    }

    if (request.method === 'POST' && routePath === '/v1/sessions/create') {
      writeJson(response, 200, await createKakaoRelaySession(projectRoot));
      return true;
    }

    if (
      request.method === 'GET' &&
      routePath.startsWith('/v1/sessions/') &&
      routePath.endsWith('/status')
    ) {
      const sessionToken = decodeURIComponent(
        routePath.slice('/v1/sessions/'.length, -'/status'.length),
      );
      const status = await getKakaoRelaySessionStatus(projectRoot, sessionToken);
      if (!status) {
        writeJson(response, 404, { error: 'Session not found.' });
        return true;
      }
      writeJson(response, 200, status);
      return true;
    }

    if (request.method === 'GET' && routePath === '/v1/events') {
      await handleKakaoRelayEvents(projectRoot, request, response);
      return true;
    }

    if (request.method === 'POST' && routePath === '/openclaw/reply') {
      await handleKakaoRelayReply(projectRoot, request, response);
      return true;
    }

    if (request.method === 'POST' && routePath === '/kakao-talkchannel/webhook') {
      await handleKakaoWebhook(projectRoot, request, response);
      return true;
    }

    writeJson(response, 404, { error: 'Not found.' });
    return true;
  } catch (error) {
    writeJson(response, error?.statusCode || 500, { error: toErrorMessage(error) });
    return true;
  }
}

async function handleKakaoRelayEvents(projectRoot, request, response) {
  const session = await requireKakaoRelaySession(projectRoot, request, response, {
    allowPending: true,
  });
  if (!session) {
    return;
  }
  if (session.status === 'expired' || session.status === 'disconnected') {
    writeJson(response, 410, { error: 'Session is no longer active.' });
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const client = {
    response,
    closed: false,
  };
  closeExistingSseClients(session.tokenHash);
  const clients = sseClientsByTokenHash.get(session.tokenHash) || new Set();
  clients.add(client);
  sseClientsByTokenHash.set(session.tokenHash, clients);

  sendSse(response, 'connected', {
    status: session.status,
    sessionId: session.tokenHash.slice(0, 12),
  });

  const heartbeat = setInterval(() => {
    if (!client.closed) {
      response.write(': ping\n\n');
    }
  }, 25_000);

  request.on('close', () => {
    clearInterval(heartbeat);
    client.closed = true;
    clients.delete(client);
    if (clients.size === 0 && sseClientsByTokenHash.get(session.tokenHash) === clients) {
      sseClientsByTokenHash.delete(session.tokenHash);
    }
  });
}

function closeExistingSseClients(tokenHash) {
  const clients = sseClientsByTokenHash.get(tokenHash);
  if (!clients || clients.size === 0) {
    return;
  }
  for (const client of clients) {
    if (client.closed) {
      continue;
    }
    client.closed = true;
    sendSse(client.response, 'replaced', {
      reason: 'another_worker_connected',
    });
    client.response.end();
  }
  sseClientsByTokenHash.delete(tokenHash);
}

async function handleKakaoRelayReply(projectRoot, request, response) {
  const session = await requireKakaoRelaySession(projectRoot, request, response);
  if (!session) {
    return;
  }
  if (session.status !== 'paired') {
    writeJson(response, 403, { error: 'Session is not paired.' });
    return;
  }

  const payload = await readJsonBody(request);
  const messageId = String(payload?.messageId || '').trim();
  if (!messageId) {
    writeJson(response, 400, { error: 'messageId is required.' });
    return;
  }

  const message = await getKakaoRelayInboundMessageForToken(projectRoot, {
    tokenHash: session.tokenHash,
    messageId,
  });
  if (!message) {
    writeJson(response, 404, { error: 'Message not found.' });
    return;
  }
  if (!message.callbackUrl) {
    writeJson(response, 410, { error: 'No Kakao callback URL is available for this message.' });
    return;
  }
  if (message.callbackExpiresAt && Date.parse(message.callbackExpiresAt) <= Date.now()) {
    writeJson(response, 410, { error: 'Kakao callback URL has expired.' });
    return;
  }

  try {
    const callbackResponse = await fetch(message.callbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload.response || {}),
    });
    if (!callbackResponse.ok) {
      throw new Error(`Kakao callback failed with status ${callbackResponse.status}.`);
    }
    await markKakaoRelayMessageReplied(projectRoot, messageId);
    writeJson(response, 200, {
      success: true,
      deliveredAt: Date.now(),
    });
  } catch (error) {
    await markKakaoRelayMessageFailed(projectRoot, { messageId, error });
    writeJson(response, 502, { error: toErrorMessage(error) });
  }
}

async function handleKakaoWebhook(projectRoot, request, response) {
  const payload = await readJsonBody(request);
  const channelId = getKakaoChannelId(payload);
  const userId = getKakaoUserId(payload);
  const text = String(payload?.userRequest?.utterance || '').trim();
  const callbackUrl = String(payload?.userRequest?.callbackUrl || '').trim();
  const conversationKey = `${channelId}:${userId}`;
  const callbackExpiresAt = callbackUrl
    ? new Date(Date.now() + KAKAO_CALLBACK_TTL_MS).toISOString()
    : null;

  const conversation = await upsertKakaoRelayConversation(projectRoot, {
    conversationKey,
    channelId,
    userId,
    callbackUrl,
    callbackExpiresAt,
  });

  const command = parseKakaoCommand(text);
  if (command) {
    const commandResponse = await handleKakaoCommand(projectRoot, command, {
      conversation,
      conversationKey,
      userId,
    });
    writeJson(response, 200, commandResponse);
    return;
  }

  if (!conversation?.tokenHash || conversation.state !== 'paired') {
    writeJson(
      response,
      200,
      textResponse(
        [
          'OpenClaw에 연결되지 않았습니다.',
          '',
          'hkclaw-lite Kakao 에이전트에서 표시된 페어링 코드를 사용해',
          '/pair <코드>',
          '를 입력해주세요.',
        ].join('\n'),
      ),
    );
    return;
  }

  if (!callbackUrl) {
    writeJson(
      response,
      200,
      textResponse('Kakao Callback 기능이 필요합니다. 오픈빌더 폴백 블록에서 Callback을 활성화해주세요.'),
    );
    return;
  }

  const message = await createKakaoRelayInboundMessage(projectRoot, {
    tokenHash: conversation.tokenHash,
    conversationKey,
    kakaoPayload: payload,
    normalized: {
      userId,
      text,
      channelId,
    },
    callbackUrl,
    callbackExpiresAt,
  });
  publishKakaoRelayEvent(conversation.tokenHash, 'message', {
    id: message.id,
    conversationKey,
    normalized: message.normalized,
  });
  writeJson(response, 200, callbackResponse());
}

async function handleKakaoCommand(projectRoot, command, { conversation, conversationKey, userId }) {
  if (command.type === 'pair') {
    if (conversation?.state === 'paired') {
      return textResponse('이미 OpenClaw에 연결되어 있습니다.\n다른 연결로 바꾸려면 먼저 /unpair 를 입력하세요.');
    }
    const paired = await pairKakaoRelayConversation(projectRoot, {
      pairingCode: command.code,
      conversationKey,
    });
    if (!paired) {
      return textResponse('❌ 유효하지 않은 코드입니다.\n\n코드를 다시 확인해주세요.');
    }
    publishKakaoRelayEvent(paired.tokenHash, 'pairing_complete', {
      kakaoUserId: userId,
      pairedAt: paired.pairedAt,
    });
    return textResponse('✅ hkclaw-lite에 연결되었습니다!\n\n이제 자유롭게 대화를 시작하세요.');
  }

  if (command.type === 'unpair') {
    if (conversation?.state !== 'paired') {
      return textResponse('연결된 hkclaw-lite Kakao 에이전트가 없습니다.');
    }
    await unpairKakaoRelayConversation(projectRoot, conversationKey);
    if (conversation?.tokenHash) {
      publishKakaoRelayEvent(conversation.tokenHash, 'pairing_expired', {
        reason: 'unpaired',
      });
    }
    return textResponse('연결이 해제되었습니다.\n다시 연결하려면 /pair <코드>를 사용하세요.');
  }

  if (command.type === 'status') {
    return textResponse(
      conversation?.state === 'paired'
        ? `✅ 연결됨\n\n사용자: ${userId}`
        : '❌ 연결되지 않음\n\n/pair <코드>로 연결하세요.',
    );
  }

  return textResponse(
    [
      'hkclaw-lite Kakao 내장 릴레이 명령어',
      '',
      '/pair <코드> - 에이전트와 연결',
      '/status - 연결 상태 확인',
      '/unpair - 연결 해제',
      '/help - 도움말',
    ].join('\n'),
  );
}

async function requireKakaoRelaySession(
  projectRoot,
  request,
  response,
  { allowPending = false } = {},
) {
  const token = getBearerToken(request);
  if (!token) {
    writeJson(response, 401, { error: 'Missing bearer token.' });
    return null;
  }
  const session = await findKakaoRelaySessionByToken(projectRoot, token);
  if (!session) {
    writeJson(response, 401, { error: 'Invalid bearer token.' });
    return null;
  }
  if (!allowPending && session.status !== 'paired') {
    writeJson(response, 403, { error: 'Session is not paired.' });
    return null;
  }
  return session;
}

function publishKakaoRelayEvent(tokenHash, event, data) {
  const clients = sseClientsByTokenHash.get(tokenHash);
  if (!clients || clients.size === 0) {
    return;
  }
  for (const client of clients) {
    if (!client.closed) {
      sendSse(client.response, event, data);
    }
  }
}

function sendSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function parseKakaoCommand(text) {
  const value = String(text || '').trim();
  const pairingCodeMatch = /(?:^|\b)([A-Z0-9]{4}-[A-Z0-9]{4})(?:\b|$)/iu.exec(value);
  const pairingPrefix = /^(?:\/?pair|페어|연결|코드)\b/iu.test(value);
  if (pairingCodeMatch && (pairingPrefix || value.toUpperCase() === pairingCodeMatch[1].toUpperCase())) {
    return {
      type: 'pair',
      code: pairingCodeMatch[1].toUpperCase(),
    };
  }
  if (value === '/unpair') {
    return { type: 'unpair' };
  }
  if (value === '/status') {
    return { type: 'status' };
  }
  if (value === '/help') {
    return { type: 'help' };
  }
  return null;
}

function getKakaoChannelId(payload) {
  const botId = String(payload?.bot?.id || '').trim();
  return botId || 'default';
}

function getKakaoUserId(payload) {
  const properties = payload?.userRequest?.user?.properties || {};
  return (
    String(properties.plusfriendUserKey || '').trim() ||
    String(payload?.userRequest?.user?.id || '').trim() ||
    'unknown'
  );
}

function getBearerToken(request) {
  const authorization = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  return match ? match[1].trim() : '';
}

async function readJsonBody(request) {
  let raw = '';
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > KAKAO_RELAY_MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    raw += chunk;
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Invalid JSON body.');
    error.statusCode = 400;
    throw error;
  }
}

function textResponse(text) {
  return {
    version: '2.0',
    template: {
      outputs: [
        {
          simpleText: {
            text,
          },
        },
      ],
    },
  };
}

function callbackResponse() {
  return {
    version: '2.0',
    useCallback: true,
  };
}

function writeJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}
