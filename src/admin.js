import fs from 'node:fs';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildAdminSnapshot,
  deleteAgentByName,
  deleteChannelByName,
  deleteDashboardByName,
  readWatcherLog,
  replaceLocalLlmConnections,
  resetChannelRuntimeSessionsByName,
  upsertAgent,
  upsertChannel,
  upsertDashboard,
} from './admin-state.js';
import {
  bootstrapAdminAuth,
  createAdminSession,
  deleteManagedServiceEnvSnapshot,
  deleteAdminSession,
  getManagedServiceEnvSnapshot,
  getAdminAuthStatus,
  isAdminSessionValid,
  recordRuntimeUsageEvent,
  setManagedServiceEnvSnapshot,
  setAdminPassword,
  summarizeRuntimeUsage,
  verifyAdminPassword,
} from './runtime-db.js';
import {
  CLAUDE_ACP_DISABLED_ENV_KEYS,
  GEMINI_CLI_DISABLED_ENV_KEYS,
  inspectAgentRuntime,
  resolveClaudeCli,
  resolveManagedAgentCli,
  runAgentTurn,
} from './runners.js';
import { createClaudeWorkerBridge } from './claude-bridge.js';
import {
  DEFAULT_ADMIN_PORT,
  DEFAULT_LOCAL_LLM_BASE_URL,
} from './constants.js';
import {
  buildDiscordAgentServiceSnapshot,
  buildDiscordServiceSnapshot,
  deleteDiscordAgentServiceArtifacts,
  enqueueDiscordServiceCommand,
  readDiscordAgentServiceStatus,
  readDiscordServiceStatus,
  writeDiscordAgentServiceStatus,
  writeDiscordServiceStatus,
} from './discord-runtime-state.js';
import {
  buildTelegramAgentServiceSnapshot,
  buildTelegramServiceSnapshot,
  deleteTelegramAgentServiceArtifacts,
  enqueueTelegramServiceCommand,
  readTelegramAgentServiceStatus,
  readTelegramServiceStatus,
  writeTelegramAgentServiceStatus,
  writeTelegramServiceStatus,
} from './telegram-runtime-state.js';
import {
  buildKakaoAgentServiceSnapshot,
  buildKakaoServiceSnapshot,
  deleteKakaoAgentServiceArtifacts,
  enqueueKakaoServiceCommand,
  readKakaoAgentServiceStatus,
  readKakaoServiceStatus,
  writeKakaoAgentServiceStatus,
  writeKakaoServiceStatus,
} from './kakao-runtime-state.js';
import { listAgentModels } from './model-catalog.js';
import { buildAgentDefinition, listLocalLlmConnections, loadConfig } from './store.js';
import { assert, parseInteger, toErrorMessage } from './utils.js';

const ADMIN_UI_ROOT = fileURLToPath(new URL('./admin-ui/', import.meta.url));
const ADMIN_STATIC_CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);
const CLI_ENTRY_PATH = fileURLToPath(new URL('../bin/hkclaw-lite.js', import.meta.url));
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const ADMIN_PASSWORD_ENV = 'HKCLAW_LITE_ADMIN_PASSWORD';
const ADMIN_SESSION_COOKIE = 'hkclaw_lite_admin_session';
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AI_STATUS_AGENT_TYPES = ['codex', 'claude-code', 'gemini-cli', 'local-llm'];
const codexAuthFlows = new Map();
const claudeAuthFlows = new Map();
const geminiAuthFlows = new Map();
const GEMINI_GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GEMINI_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GEMINI_GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GEMINI_GOOGLE_MANUAL_REDIRECT_URI = 'https://codeassist.google.com/authcode';
const DISCORD_SERVICE_START_TIMEOUT_MS = 15_000;
const DISCORD_SERVICE_STOP_TIMEOUT_MS = 8_000;
const DISCORD_SERVICE_ENTRY_ENV = 'HKCLAW_LITE_DISCORD_SERVICE_ENTRY';
const TELEGRAM_SERVICE_START_TIMEOUT_MS = 15_000;
const TELEGRAM_SERVICE_STOP_TIMEOUT_MS = 8_000;
const TELEGRAM_SERVICE_ENTRY_ENV = 'HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY';
const KAKAO_SERVICE_START_TIMEOUT_MS = 15_000;
const KAKAO_SERVICE_STOP_TIMEOUT_MS = 8_000;
const KAKAO_SERVICE_ENTRY_ENV = 'HKCLAW_LITE_KAKAO_SERVICE_ENTRY';

export async function startAdminServer(
  projectRoot,
  {
    host = '127.0.0.1',
    port = DEFAULT_ADMIN_PORT,
    password = undefined,
    passwordFile = null,
  } = {},
) {
  const normalizedPort =
    typeof port === 'number' ? port : parseInteger(port, 'port');
  const auth = await createAdminAuthController(projectRoot, {
    password: password ?? process.env[ADMIN_PASSWORD_ENV],
    passwordFile,
  });

  const server = http.createServer((request, response) => {
    void handleAdminRequest(projectRoot, auth, request, response).catch(async (error) => {
      const statusCode =
        error?.statusCode || (error?.name === 'UsageError' ? 400 : 500);
      writeJson(response, statusCode, {
        error: toErrorMessage(error),
        auth: await auth.getStatus(request),
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(normalizedPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const resolvedHost = address?.address || host;
  const resolvedPort = address?.port || normalizedPort;
  const url = `http://${resolvedHost.includes(':') ? `[${resolvedHost}]` : resolvedHost}:${resolvedPort}`;

  await restoreManagedServiceProcesses(projectRoot).catch((error) => {
    console.error(`Failed to restore managed services: ${toErrorMessage(error)}`);
  });

  return {
    server,
    host: resolvedHost,
    port: resolvedPort,
    url,
    authEnabled: auth.enabled,
    authStorage: auth.storage,
    passwordEnv: ADMIN_PASSWORD_ENV,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function serveAdmin(
  projectRoot,
  {
    host = '127.0.0.1',
    port = DEFAULT_ADMIN_PORT,
    password = undefined,
    passwordFile = null,
  } = {},
) {
  const { server, url, authEnabled, authStorage, passwordEnv } = await startAdminServer(projectRoot, {
    host,
    port,
    password,
    passwordFile,
  });
  console.log(`Web admin available at ${url}`);
  console.log(`Project root: ${projectRoot}`);
  if (authEnabled) {
    console.log(
      authStorage === 'sqlite'
        ? 'Lightweight login enabled via SQLite.'
        : `Lightweight login enabled via ${passwordEnv}.`,
    );
  } else {
    console.log(`Login disabled. Set ${passwordEnv} to require a password.`);
  }
  console.log('Press Ctrl+C to stop.');
  await waitForShutdown(server);
}

async function handleAdminRequest(projectRoot, auth, request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const isStaticRequest = request.method === 'GET' || request.method === 'HEAD';

  if (isStaticRequest && !pathname.startsWith('/api/')) {
    if (pathname === '/healthz') {
      writeJson(response, 200, {
        ok: true,
        status: 'healthy',
      });
      return;
    }
    const asset = resolveAdminStaticAsset(pathname);
    if (asset) {
      writeText(response, 200, asset.body, asset.contentType);
      return;
    }
    writeJson(response, 404, { error: 'Not found.' });
    return;
  }

  if (!pathname.startsWith('/api/')) {
    writeJson(response, 404, { error: 'Not found.' });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/auth/status') {
    writeJson(response, 200, await auth.getStatus(request));
    return;
  }

  if (request.method === 'POST' && pathname === '/api/login') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, await auth.login(response, payload.password));
    return;
  }

  if (request.method === 'POST' && pathname === '/api/logout') {
    writeJson(response, 200, await auth.logout(request, response));
    return;
  }

  if (request.method === 'PUT' && pathname === '/api/admin-password') {
    const payload = await readJsonBody(request);
    await auth.assertAuthenticated(request);
    writeJson(response, 200, await auth.changePassword(request, response, payload));
    return;
  }

  await auth.assertAuthenticated(request);

  if (request.method === 'GET' && pathname === '/api/state') {
    writeJson(response, 200, await buildAdminSnapshot(projectRoot));
    return;
  }

  if (request.method === 'GET' && pathname === '/api/ai-statuses') {
    writeJson(response, 200, {
      ok: true,
      statuses: await readAiStatuses(projectRoot),
    });
    return;
  }

  if (request.method === 'GET' && pathname.startsWith('/api/watchers/')) {
    const watcherId = decodeWatcherLogPath(pathname);
    writeText(
      response,
      200,
      readWatcherLog(projectRoot, watcherId),
      'text/plain; charset=utf-8',
    );
    return;
  }

  if (request.method === 'POST' && pathname === '/api/agents') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      state: await upsertAgent(
        projectRoot,
        payload.currentName || null,
        payload.definition || payload,
      ),
    });
    return;
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/agents/')) {
    const name = decodeEntityPath(pathname, '/api/agents/');
    writeJson(response, 200, {
      ok: true,
      state: await deleteAgentAndRuntimeByName(projectRoot, name),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/discord-service/reload') {
    writeJson(response, 200, {
      ok: true,
      result: await reloadAllDiscordServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/discord-service/start') {
    writeJson(response, 200, {
      ok: true,
      result: await startAllDiscordServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/discord-service/restart') {
    writeJson(response, 200, {
      ok: true,
      result: await restartAllDiscordServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/discord-service/stop') {
    writeJson(response, 200, {
      ok: true,
      result: await stopAllDiscordServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/telegram-service/reload') {
    writeJson(response, 200, {
      ok: true,
      result: await reloadAllTelegramServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/telegram-service/start') {
    writeJson(response, 200, {
      ok: true,
      result: await startAllTelegramServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/telegram-service/restart') {
    writeJson(response, 200, {
      ok: true,
      result: await restartAllTelegramServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/telegram-service/stop') {
    writeJson(response, 200, {
      ok: true,
      result: await stopAllTelegramServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/kakao-service/reload') {
    writeJson(response, 200, {
      ok: true,
      result: await reloadAllKakaoServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/kakao-service/start') {
    writeJson(response, 200, {
      ok: true,
      result: await startAllKakaoServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/kakao-service/restart') {
    writeJson(response, 200, {
      ok: true,
      result: await restartAllKakaoServiceProcesses(projectRoot),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/kakao-service/stop') {
    writeJson(response, 200, {
      ok: true,
      result: await stopAllKakaoServiceProcesses(projectRoot),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    pathname.startsWith('/api/agents/') &&
    pathname.endsWith('/start')
  ) {
    const name = decodeEntityPath(pathname.slice(0, -'/start'.length), '/api/agents/');
    const platform = getAgentMessagingPlatform(projectRoot, name);
    writeJson(response, 200, {
      ok: true,
      result:
        platform === 'telegram'
          ? await startTelegramServiceProcess(projectRoot, name)
          : platform === 'kakao'
            ? await startKakaoServiceProcess(projectRoot, name)
          : await startDiscordServiceProcess(projectRoot, name),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    pathname.startsWith('/api/agents/') &&
    pathname.endsWith('/restart')
  ) {
    const name = decodeEntityPath(pathname.slice(0, -'/restart'.length), '/api/agents/');
    const platform = getAgentMessagingPlatform(projectRoot, name);
    writeJson(response, 200, {
      ok: true,
      result:
        platform === 'telegram'
          ? await restartTelegramServiceProcess(projectRoot, name)
          : platform === 'kakao'
            ? await restartKakaoServiceProcess(projectRoot, name)
          : await restartDiscordServiceProcess(projectRoot, name),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    pathname.startsWith('/api/agents/') &&
    pathname.endsWith('/stop')
  ) {
    const name = decodeEntityPath(pathname.slice(0, -'/stop'.length), '/api/agents/');
    const platform = getAgentMessagingPlatform(projectRoot, name);
    writeJson(response, 200, {
      ok: true,
      result:
        platform === 'telegram'
          ? await stopTelegramServiceProcess(projectRoot, name)
          : platform === 'kakao'
            ? await stopKakaoServiceProcess(projectRoot, name)
          : await stopDiscordServiceProcess(projectRoot, name),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    pathname.startsWith('/api/agents/') &&
    pathname.endsWith('/reconnect')
  ) {
    const name = decodeEntityPath(pathname.slice(0, -'/reconnect'.length), '/api/agents/');
    const platform = getAgentMessagingPlatform(projectRoot, name);
    writeJson(response, 200, {
      ok: true,
      result:
        platform === 'telegram'
          ? await queueTelegramServiceAction(projectRoot, {
              action: 'reconnect-agent',
              agentName: name,
            })
          : platform === 'kakao'
            ? await queueKakaoServiceAction(projectRoot, {
                action: 'reconnect-agent',
                agentName: name,
              })
          : await queueDiscordServiceAction(projectRoot, {
              action: 'reconnect-agent',
              agentName: name,
            }),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/channels') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      state: await upsertChannel(
        projectRoot,
        payload.currentName || null,
        payload.definition || payload,
      ),
    });
    return;
  }

  if (
    request.method === 'DELETE' &&
    pathname.startsWith('/api/channels/') &&
    pathname.endsWith('/runtime-sessions')
  ) {
    const name = decodeEntityPath(
      pathname.slice(0, -'/runtime-sessions'.length),
      '/api/channels/',
    );
    const role = url.searchParams.get('role');
    writeJson(response, 200, {
      ok: true,
      state: await resetChannelRuntimeSessionsByName(projectRoot, name, { role }),
    });
    return;
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/channels/')) {
    const name = decodeEntityPath(pathname, '/api/channels/');
    writeJson(response, 200, {
      ok: true,
      state: await deleteChannelByName(projectRoot, name),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/dashboards') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      state: await upsertDashboard(
        projectRoot,
        payload.currentName || null,
        payload.definition || payload,
      ),
    });
    return;
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/dashboards/')) {
    const name = decodeEntityPath(pathname, '/api/dashboards/');
    writeJson(response, 200, {
      ok: true,
      state: await deleteDashboardByName(projectRoot, name),
    });
    return;
  }

  if (request.method === 'PUT' && pathname === '/api/local-llm-connections') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      state: await replaceLocalLlmConnections(projectRoot, payload.connections || []),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/run') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      result: await runOneShotViaCli(projectRoot, payload),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/agent-auth') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      result: await runAgentAuthAction(projectRoot, payload),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/agent-models') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      result: await listAgentModels(process.env, payload),
    });
    return;
  }

  writeJson(response, 404, { error: 'Not found.' });
}

function resolveAdminStaticAsset(pathname) {
  const normalizedPath = pathname === '/' ? '/index.html' : pathname;
  const aliasedPath = normalizedPath === '/favicon.ico' ? '/favicon.svg' : normalizedPath;
  const relativePath = aliasedPath.replace(/^\/+/, '');
  const resolvedPath = path.resolve(ADMIN_UI_ROOT, relativePath);
  const normalizedRoot = path.resolve(ADMIN_UI_ROOT);
  if (!resolvedPath.startsWith(`${normalizedRoot}${path.sep}`) && resolvedPath !== normalizedRoot) {
    return null;
  }
  if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
    return null;
  }
  const contentType =
    ADMIN_STATIC_CONTENT_TYPES.get(path.extname(resolvedPath).toLowerCase()) ||
    'application/octet-stream';
  return {
    body: fs.readFileSync(resolvedPath),
    contentType,
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let byteLength = 0;

  for await (const chunk of request) {
    byteLength += chunk.length;
    assert(byteLength <= MAX_JSON_BODY_BYTES, 'Request body is too large.');
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

async function runOneShotViaCli(projectRoot, payload) {
  const prompt = String(payload?.prompt || '').trim();
  assert(prompt, 'Prompt is required.');

  const args = ['--root', projectRoot, 'run'];

  if (payload.channelName) {
    args.push('--channel', String(payload.channelName));
  } else {
    const agentName = String(payload?.agentName || '').trim();
    assert(agentName, 'Select an agent or channel to run.');
    args.push(agentName);
    if (payload.workdir) {
      args.push('--workdir', String(payload.workdir));
    }
  }

  args.push('--message', prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY_PATH, ...args], {
      cwd: projectRoot,
      env: process.env,
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();

      if (code !== 0) {
        reject(new Error(errorOutput || output || `Run failed with exit code ${code}.`));
        return;
      }

      resolve({
        command: [process.execPath, CLI_ENTRY_PATH, ...args].join(' '),
        output,
      });
    });
  });
}

async function queueDiscordServiceAction(projectRoot, input = {}) {
  const config = loadConfig(projectRoot);
  const agentName = input?.agentName ? String(input.agentName).trim() : null;
  assert(agentName, 'Agent name is required.');
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);

  const service = buildDiscordAgentServiceSnapshot(projectRoot, agentName);
  assert(service.running, `에이전트 "${agentName}" Discord 프로세스가 실행 중이 아닙니다.`);

  const command = enqueueDiscordServiceCommand(projectRoot, {
    action: input?.action,
    agentName,
  });

  return {
    queued: true,
    action: command.action,
    agentName: command.agentName,
    requestedAt: command.requestedAt,
  };
}

async function queueTelegramServiceAction(projectRoot, input = {}) {
  const config = loadConfig(projectRoot);
  const agentName = input?.agentName ? String(input.agentName).trim() : null;
  assert(agentName, 'Agent name is required.');
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);

  const service = buildTelegramAgentServiceSnapshot(projectRoot, agentName);
  assert(service.running, `에이전트 "${agentName}" Telegram 프로세스가 실행 중이 아닙니다.`);

  const command = enqueueTelegramServiceCommand(projectRoot, {
    action: input?.action,
    agentName,
  });

  return {
    queued: true,
    action: command.action,
    agentName: command.agentName,
    requestedAt: command.requestedAt,
  };
}

async function queueKakaoServiceAction(projectRoot, input = {}) {
  const config = loadConfig(projectRoot);
  const agentName = input?.agentName ? String(input.agentName).trim() : null;
  assert(agentName, 'Agent name is required.');
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);

  const service = buildKakaoAgentServiceSnapshot(projectRoot, agentName);
  assert(service.running, `에이전트 "${agentName}" Kakao 프로세스가 실행 중이 아닙니다.`);

  const command = enqueueKakaoServiceCommand(projectRoot, {
    action: input?.action,
    agentName,
  });

  return {
    queued: true,
    action: command.action,
    agentName: command.agentName,
    requestedAt: command.requestedAt,
  };
}

function getAgentMessagingPlatform(projectRoot, agentName) {
  const config = loadConfig(projectRoot);
  const agent = config.agents?.[agentName];
  assert(agent, `Agent "${agentName}" does not exist.`);
  return String(agent.platform || 'discord').trim();
}

async function restoreManagedServiceProcesses(projectRoot) {
  const config = loadConfig(projectRoot);
  const tasks = [];
  const legacyDiscordStatus = readDiscordServiceStatus(projectRoot);
  const legacyTelegramStatus = readTelegramServiceStatus(projectRoot);
  const legacyKakaoStatus = readKakaoServiceStatus(projectRoot);
  const legacyDiscordSnapshot = buildDiscordServiceSnapshot(projectRoot, legacyDiscordStatus);
  const legacyTelegramSnapshot = buildTelegramServiceSnapshot(projectRoot, legacyTelegramStatus);
  const legacyKakaoSnapshot = buildKakaoServiceSnapshot(projectRoot, legacyKakaoStatus);

  for (const [agentName, agent] of Object.entries(config.agents || {})) {
    const platform = String(agent?.platform || 'discord').trim();
    if (platform === 'kakao') {
      const rawStatus = readKakaoAgentServiceStatus(projectRoot, agentName);
      const snapshot = buildKakaoAgentServiceSnapshot(projectRoot, agentName, rawStatus);
      if (
        shouldRestoreKakaoAgentService(
          agentName,
          rawStatus,
          legacyKakaoStatus,
          legacyKakaoSnapshot,
        ) &&
        !snapshot.pidAlive
      ) {
        tasks.push(restoreManagedServiceProcess(projectRoot, agentName, 'kakao'));
      }
      continue;
    }
    if (platform === 'telegram') {
      const rawStatus = readTelegramAgentServiceStatus(projectRoot, agentName);
      const snapshot = buildTelegramAgentServiceSnapshot(projectRoot, agentName, rawStatus);
      if (
        shouldRestoreTelegramAgentService(
          agentName,
          rawStatus,
          legacyTelegramStatus,
          legacyTelegramSnapshot,
        ) &&
        !snapshot.pidAlive &&
        String(agent?.telegramBotToken || '').trim()
      ) {
        tasks.push(restoreManagedServiceProcess(projectRoot, agentName, 'telegram'));
      }
      continue;
    }

    const rawStatus = readDiscordAgentServiceStatus(projectRoot, agentName);
    const snapshot = buildDiscordAgentServiceSnapshot(projectRoot, agentName, rawStatus);
    if (
      shouldRestoreDiscordAgentService(
        agentName,
        rawStatus,
        legacyDiscordStatus,
        legacyDiscordSnapshot,
      ) &&
      !snapshot.pidAlive &&
      String(agent?.discordToken || '').trim()
    ) {
      tasks.push(restoreManagedServiceProcess(projectRoot, agentName, 'discord'));
    }
  }

  if (tasks.length === 0) {
    return [];
  }

  return await Promise.all(tasks);
}

function shouldRestoreDiscordAgentService(agentName, agentStatus, legacyStatus, legacySnapshot) {
  if (agentStatus?.desiredRunning ?? agentStatus?.running) {
    return true;
  }
  if (agentStatus) {
    return false;
  }
  return shouldRestoreLegacyManagedService(agentName, legacyStatus, legacySnapshot);
}

function shouldRestoreTelegramAgentService(agentName, agentStatus, legacyStatus, legacySnapshot) {
  if (agentStatus?.desiredRunning ?? agentStatus?.running) {
    return true;
  }
  if (agentStatus) {
    return false;
  }
  return shouldRestoreLegacyManagedService(agentName, legacyStatus, legacySnapshot);
}

function shouldRestoreKakaoAgentService(agentName, agentStatus, legacyStatus, legacySnapshot) {
  if (agentStatus?.desiredRunning ?? agentStatus?.running) {
    return true;
  }
  if (agentStatus) {
    return false;
  }
  return shouldRestoreLegacyManagedService(agentName, legacyStatus, legacySnapshot);
}

function shouldRestoreLegacyManagedService(agentName, legacyStatus, legacySnapshot) {
  if (!(legacyStatus?.desiredRunning ?? legacyStatus?.running)) {
    return false;
  }
  if (legacySnapshot?.pidAlive) {
    return false;
  }
  const legacyAgents = legacyStatus?.agents || legacyStatus?.bots || {};
  if (!agentName) {
    return false;
  }
  return Boolean(legacyAgents[agentName]);
}

async function restoreManagedServiceProcess(projectRoot, agentName, platform) {
  try {
    if (platform === 'telegram') {
      return await startTelegramServiceProcess(projectRoot, agentName, {
        envSource: 'runtime-db',
      });
    }
    if (platform === 'kakao') {
      return await startKakaoServiceProcess(projectRoot, agentName, {
        envSource: 'runtime-db',
      });
    }
    return await startDiscordServiceProcess(projectRoot, agentName, {
      envSource: 'runtime-db',
    });
  } catch (error) {
    console.error(
      `Failed to restore ${platform} service for agent "${agentName}": ${toErrorMessage(error)}`,
    );
    return {
      action: 'restore',
      agentName,
      platform,
      restored: false,
      error: toErrorMessage(error),
    };
  }
}

async function deleteAgentAndRuntimeByName(projectRoot, name) {
  try {
    await stopDiscordServiceProcess(projectRoot, name, {
      allowStopped: true,
    });
  } catch {
    // Ignore Discord stop failures during delete cleanup.
  }

  try {
    await stopTelegramServiceProcess(projectRoot, name, {
      allowStopped: true,
    });
  } catch {
    // Ignore Telegram stop failures during delete cleanup.
  }

  try {
    await stopKakaoServiceProcess(projectRoot, name, {
      allowStopped: true,
    });
  } catch {
    // Ignore Kakao stop failures during delete cleanup.
  }

  deleteDiscordAgentServiceArtifacts(projectRoot, name);
  deleteTelegramAgentServiceArtifacts(projectRoot, name);
  deleteKakaoAgentServiceArtifacts(projectRoot, name);
  await deleteManagedServiceEnvSnapshot(projectRoot, {
    platform: 'discord',
    agentName: name,
  });
  await deleteManagedServiceEnvSnapshot(projectRoot, {
    platform: 'telegram',
    agentName: name,
  });
  await deleteManagedServiceEnvSnapshot(projectRoot, {
    platform: 'kakao',
    agentName: name,
  });

  return await deleteAgentByName(projectRoot, name);
}

async function startDiscordServiceProcess(projectRoot, agentName, options = {}) {
  const config = loadConfig(projectRoot);
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);
  assert(
    String(config.agents[agentName]?.discordToken || '').trim(),
    `Agent "${agentName}" does not configure a Discord token.`,
  );

  setDiscordAgentDesiredRunning(projectRoot, agentName, true);
  const current = buildDiscordAgentServiceSnapshot(projectRoot, agentName);
  assert(!current.pidAlive, 'Discord 서비스가 이미 실행 중입니다.');
  if (current.stale || current.state === 'stopped') {
    normalizeDiscordServiceStoppedState(projectRoot, agentName, {
      desiredRunning: true,
    });
  }

  const args = buildDiscordServiceStartArgs(projectRoot, {
    agentName,
  });
  const childEnv = await resolveManagedServiceRuntimeEnv(projectRoot, {
    platform: 'discord',
    agentName,
    envSource: options.envSource,
  });

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: childEnv,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const service = await waitForDiscordServiceSnapshot(
    projectRoot,
    agentName,
    (snapshot) => snapshot.running || snapshot.starting || Boolean(snapshot.lastError),
    DISCORD_SERVICE_START_TIMEOUT_MS,
  );
  assert(
    service.running || service.starting,
    service.lastError || 'Discord 서비스 시작을 확인하지 못했습니다.',
  );

  return {
    action: 'start',
    agentName,
    running: service.running,
    starting: service.starting,
    pid: service.pid,
    startedAt: service.startedAt,
  };
}

async function restartDiscordServiceProcess(projectRoot, agentName) {
  const previous = await stopDiscordServiceProcess(projectRoot, agentName, {
    allowStopped: true,
    disableDesiredRunning: false,
  });
  const next = await startDiscordServiceProcess(projectRoot, agentName);
  return {
    action: 'restart',
    agentName,
    previous,
    current: next,
  };
}

async function stopDiscordServiceProcess(
  projectRoot,
  agentName,
  { allowStopped = false, disableDesiredRunning = true } = {},
) {
  const config = loadConfig(projectRoot);
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);
  const service = buildDiscordAgentServiceSnapshot(projectRoot, agentName);
  if (!service.pidAlive) {
    if (service.stale || service.state === 'stopped') {
      const normalized = normalizeDiscordServiceStoppedState(projectRoot, agentName, {
        desiredRunning: disableDesiredRunning ? false : service.desiredRunning,
      });
      if (!allowStopped) {
        assert(false, 'Discord 서비스가 실행 중이 아닙니다.');
      }
      return {
        action: 'stop',
        agentName,
        running: false,
        pid: normalized.pid,
        stoppedAt: normalized.stoppedAt,
      };
    }
    assert(false, 'Discord 서비스가 실행 중이 아닙니다.');
  }

  try {
    process.kill(service.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }

  const stopped = await waitForDiscordServiceSnapshot(
    projectRoot,
    agentName,
    (snapshot) => !snapshot.pidAlive && !snapshot.running,
    DISCORD_SERVICE_STOP_TIMEOUT_MS,
  );
  const normalized = disableDesiredRunning
    ? normalizeDiscordServiceStoppedState(projectRoot, agentName, {
        desiredRunning: false,
      })
    : stopped.running
      ? normalizeDiscordServiceStoppedState(projectRoot, agentName, {
          desiredRunning: true,
        })
      : stopped;

  return {
    action: 'stop',
    agentName,
    running: false,
    pid: normalized.pid,
    stoppedAt: normalized.stoppedAt,
  };
}

async function startAllDiscordServiceProcesses(projectRoot) {
  const agentNames = listConfiguredDiscordAgents(projectRoot);
  assert(agentNames.length > 0, 'Discord 토큰이 설정된 에이전트가 없습니다.');
  return {
    action: 'start-all',
    agents: await Promise.all(
      agentNames.map((agentName) => startDiscordServiceProcess(projectRoot, agentName)),
    ),
  };
}

async function restartAllDiscordServiceProcesses(projectRoot) {
  const agentNames = listConfiguredDiscordAgents(projectRoot);
  assert(agentNames.length > 0, 'Discord 토큰이 설정된 에이전트가 없습니다.');
  return {
    action: 'restart-all',
    agents: await Promise.all(
      agentNames.map((agentName) => restartDiscordServiceProcess(projectRoot, agentName)),
    ),
  };
}

async function stopAllDiscordServiceProcesses(projectRoot) {
  const agentNames = listConfiguredDiscordAgents(projectRoot);
  if (agentNames.length === 0) {
    return {
      action: 'stop-all',
      agents: [],
    };
  }
  return {
    action: 'stop-all',
    agents: await Promise.all(
      agentNames.map((agentName) =>
        stopDiscordServiceProcess(projectRoot, agentName, {
          allowStopped: true,
        }),
      ),
    ),
  };
}

async function reloadAllDiscordServiceProcesses(projectRoot) {
  const agentNames = listConfiguredDiscordAgents(projectRoot);
  assert(agentNames.length > 0, 'Discord 토큰이 설정된 에이전트가 없습니다.');
  return {
    action: 'reload-all',
    agents: await Promise.all(
      agentNames.map((agentName) =>
        queueDiscordServiceAction(projectRoot, {
          action: 'reload-config',
          agentName,
        }),
      ),
    ),
  };
}

async function startTelegramServiceProcess(projectRoot, agentName, options = {}) {
  const config = loadConfig(projectRoot);
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);
  assert(
    String(config.agents[agentName]?.telegramBotToken || '').trim(),
    `Agent "${agentName}" does not configure a Telegram bot token.`,
  );

  setTelegramAgentDesiredRunning(projectRoot, agentName, true);
  const current = buildTelegramAgentServiceSnapshot(projectRoot, agentName);
  assert(!current.pidAlive, 'Telegram 서비스가 이미 실행 중입니다.');
  if (current.stale || current.state === 'stopped') {
    normalizeTelegramServiceStoppedState(projectRoot, agentName, {
      desiredRunning: true,
    });
  }

  const args = buildTelegramServiceStartArgs(projectRoot, { agentName });
  const childEnv = await resolveManagedServiceRuntimeEnv(projectRoot, {
    platform: 'telegram',
    agentName,
    envSource: options.envSource,
  });
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: childEnv,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const service = await waitForTelegramServiceSnapshot(
    projectRoot,
    agentName,
    (snapshot) => snapshot.running || snapshot.starting || Boolean(snapshot.lastError),
    TELEGRAM_SERVICE_START_TIMEOUT_MS,
  );
  assert(
    service.running || service.starting,
    service.lastError || 'Telegram 서비스 시작을 확인하지 못했습니다.',
  );

  return {
    action: 'start',
    agentName,
    platform: 'telegram',
    running: service.running,
    starting: service.starting,
    pid: service.pid,
    startedAt: service.startedAt,
  };
}

async function restartTelegramServiceProcess(projectRoot, agentName) {
  const previous = await stopTelegramServiceProcess(projectRoot, agentName, {
    allowStopped: true,
    disableDesiredRunning: false,
  });
  const next = await startTelegramServiceProcess(projectRoot, agentName);
  return {
    action: 'restart',
    agentName,
    platform: 'telegram',
    previous,
    current: next,
  };
}

async function stopTelegramServiceProcess(
  projectRoot,
  agentName,
  { allowStopped = false, disableDesiredRunning = true } = {},
) {
  const config = loadConfig(projectRoot);
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);
  const service = buildTelegramAgentServiceSnapshot(projectRoot, agentName);
  if (!service.pidAlive) {
    if (service.stale || service.state === 'stopped') {
      const normalized = normalizeTelegramServiceStoppedState(projectRoot, agentName, {
        desiredRunning: disableDesiredRunning ? false : service.desiredRunning,
      });
      if (!allowStopped) {
        assert(false, 'Telegram 서비스가 실행 중이 아닙니다.');
      }
      return {
        action: 'stop',
        agentName,
        platform: 'telegram',
        running: false,
        pid: normalized.pid,
        stoppedAt: normalized.stoppedAt,
      };
    }
    assert(false, 'Telegram 서비스가 실행 중이 아닙니다.');
  }

  try {
    process.kill(service.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }

  const stopped = await waitForTelegramServiceSnapshot(
    projectRoot,
    agentName,
    (snapshot) => !snapshot.pidAlive && !snapshot.running,
    TELEGRAM_SERVICE_STOP_TIMEOUT_MS,
  );
  const normalized = disableDesiredRunning
    ? normalizeTelegramServiceStoppedState(projectRoot, agentName, {
        desiredRunning: false,
      })
    : stopped.running
      ? normalizeTelegramServiceStoppedState(projectRoot, agentName, {
          desiredRunning: true,
        })
      : stopped;

  return {
    action: 'stop',
    agentName,
    platform: 'telegram',
    running: false,
    pid: normalized.pid,
    stoppedAt: normalized.stoppedAt,
  };
}

async function startAllTelegramServiceProcesses(projectRoot) {
  const agentNames = listConfiguredTelegramAgents(projectRoot);
  assert(agentNames.length > 0, 'Telegram 토큰이 설정된 에이전트가 없습니다.');
  return {
    action: 'start-all',
    platform: 'telegram',
    agents: await Promise.all(
      agentNames.map((agentName) => startTelegramServiceProcess(projectRoot, agentName)),
    ),
  };
}

async function restartAllTelegramServiceProcesses(projectRoot) {
  const agentNames = listConfiguredTelegramAgents(projectRoot);
  assert(agentNames.length > 0, 'Telegram 토큰이 설정된 에이전트가 없습니다.');
  return {
    action: 'restart-all',
    platform: 'telegram',
    agents: await Promise.all(
      agentNames.map((agentName) => restartTelegramServiceProcess(projectRoot, agentName)),
    ),
  };
}

async function stopAllTelegramServiceProcesses(projectRoot) {
  const agentNames = listConfiguredTelegramAgents(projectRoot);
  if (agentNames.length === 0) {
    return {
      action: 'stop-all',
      platform: 'telegram',
      agents: [],
    };
  }
  return {
    action: 'stop-all',
    platform: 'telegram',
    agents: await Promise.all(
      agentNames.map((agentName) =>
        stopTelegramServiceProcess(projectRoot, agentName, {
          allowStopped: true,
        }),
      ),
    ),
  };
}

async function reloadAllTelegramServiceProcesses(projectRoot) {
  const agentNames = listConfiguredTelegramAgents(projectRoot);
  assert(agentNames.length > 0, 'Telegram 토큰이 설정된 에이전트가 없습니다.');
  return {
    action: 'reload-all',
    platform: 'telegram',
    agents: await Promise.all(
      agentNames.map((agentName) =>
        queueTelegramServiceAction(projectRoot, {
          action: 'reload-config',
          agentName,
        }),
      ),
    ),
  };
}

async function startKakaoServiceProcess(projectRoot, agentName, options = {}) {
  const config = loadConfig(projectRoot);
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);
  assert(
    (config.agents[agentName]?.platform || 'discord') === 'kakao',
    `Agent "${agentName}" is not configured for Kakao.`,
  );

  setKakaoAgentDesiredRunning(projectRoot, agentName, true);
  const current = buildKakaoAgentServiceSnapshot(projectRoot, agentName);
  assert(!current.pidAlive, 'Kakao 서비스가 이미 실행 중입니다.');
  if (current.stale || current.state === 'stopped') {
    normalizeKakaoServiceStoppedState(projectRoot, agentName, {
      desiredRunning: true,
    });
  }

  const args = buildKakaoServiceStartArgs(projectRoot, { agentName });
  const childEnv = await resolveManagedServiceRuntimeEnv(projectRoot, {
    platform: 'kakao',
    agentName,
    envSource: options.envSource,
  });
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: childEnv,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const service = await waitForKakaoServiceSnapshot(
    projectRoot,
    agentName,
    (snapshot) => snapshot.running || snapshot.starting || Boolean(snapshot.lastError),
    KAKAO_SERVICE_START_TIMEOUT_MS,
  );
  assert(
    service.running || service.starting,
    service.lastError || 'Kakao 서비스 시작을 확인하지 못했습니다.',
  );

  return {
    action: 'start',
    agentName,
    platform: 'kakao',
    running: service.running,
    starting: service.starting,
    pid: service.pid,
    startedAt: service.startedAt,
  };
}

async function restartKakaoServiceProcess(projectRoot, agentName) {
  const previous = await stopKakaoServiceProcess(projectRoot, agentName, {
    allowStopped: true,
    disableDesiredRunning: false,
  });
  const next = await startKakaoServiceProcess(projectRoot, agentName);
  return {
    action: 'restart',
    agentName,
    platform: 'kakao',
    previous,
    current: next,
  };
}

async function stopKakaoServiceProcess(
  projectRoot,
  agentName,
  { allowStopped = false, disableDesiredRunning = true } = {},
) {
  const config = loadConfig(projectRoot);
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);
  const service = buildKakaoAgentServiceSnapshot(projectRoot, agentName);
  if (!service.pidAlive) {
    if (service.stale || service.state === 'stopped') {
      const normalized = normalizeKakaoServiceStoppedState(projectRoot, agentName, {
        desiredRunning: disableDesiredRunning ? false : service.desiredRunning,
      });
      if (!allowStopped) {
        assert(false, 'Kakao 서비스가 실행 중이 아닙니다.');
      }
      return {
        action: 'stop',
        agentName,
        platform: 'kakao',
        running: false,
        pid: normalized.pid,
        stoppedAt: normalized.stoppedAt,
      };
    }
    assert(false, 'Kakao 서비스가 실행 중이 아닙니다.');
  }

  try {
    process.kill(service.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }

  const stopped = await waitForKakaoServiceSnapshot(
    projectRoot,
    agentName,
    (snapshot) => !snapshot.pidAlive && !snapshot.running,
    KAKAO_SERVICE_STOP_TIMEOUT_MS,
  );
  const normalized = disableDesiredRunning
    ? normalizeKakaoServiceStoppedState(projectRoot, agentName, {
        desiredRunning: false,
      })
    : stopped.running
      ? normalizeKakaoServiceStoppedState(projectRoot, agentName, {
          desiredRunning: true,
        })
      : stopped;

  return {
    action: 'stop',
    agentName,
    platform: 'kakao',
    running: false,
    pid: normalized.pid,
    stoppedAt: normalized.stoppedAt,
  };
}

async function startAllKakaoServiceProcesses(projectRoot) {
  const agentNames = listConfiguredKakaoAgents(projectRoot);
  assert(agentNames.length > 0, 'Kakao 플랫폼 에이전트가 없습니다.');
  return {
    action: 'start-all',
    platform: 'kakao',
    agents: await Promise.all(
      agentNames.map((agentName) => startKakaoServiceProcess(projectRoot, agentName)),
    ),
  };
}

async function restartAllKakaoServiceProcesses(projectRoot) {
  const agentNames = listConfiguredKakaoAgents(projectRoot);
  assert(agentNames.length > 0, 'Kakao 플랫폼 에이전트가 없습니다.');
  return {
    action: 'restart-all',
    platform: 'kakao',
    agents: await Promise.all(
      agentNames.map((agentName) => restartKakaoServiceProcess(projectRoot, agentName)),
    ),
  };
}

async function stopAllKakaoServiceProcesses(projectRoot) {
  const agentNames = listConfiguredKakaoAgents(projectRoot);
  if (agentNames.length === 0) {
    return {
      action: 'stop-all',
      platform: 'kakao',
      agents: [],
    };
  }
  return {
    action: 'stop-all',
    platform: 'kakao',
    agents: await Promise.all(
      agentNames.map((agentName) =>
        stopKakaoServiceProcess(projectRoot, agentName, {
          allowStopped: true,
        }),
      ),
    ),
  };
}

async function reloadAllKakaoServiceProcesses(projectRoot) {
  const agentNames = listConfiguredKakaoAgents(projectRoot);
  assert(agentNames.length > 0, 'Kakao 플랫폼 에이전트가 없습니다.');
  return {
    action: 'reload-all',
    platform: 'kakao',
    agents: await Promise.all(
      agentNames.map((agentName) =>
        queueKakaoServiceAction(projectRoot, {
          action: 'reload-config',
          agentName,
        }),
      ),
    ),
  };
}

function normalizeDiscordServiceStoppedState(projectRoot, agentName = null, options = {}) {
  const rawStatus = agentName
    ? readDiscordAgentServiceStatus(projectRoot, agentName)
    : readDiscordServiceStatus(projectRoot);
  if (!rawStatus) {
    return agentName
      ? buildDiscordAgentServiceSnapshot(projectRoot, agentName, null)
      : buildDiscordServiceSnapshot(projectRoot, null);
  }

  const nextStatus = {
    ...rawStatus,
    running: false,
    desiredRunning:
      options.desiredRunning === undefined
        ? Boolean(rawStatus.desiredRunning ?? rawStatus.running)
        : Boolean(options.desiredRunning),
    stoppedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  if (agentName) {
    writeDiscordAgentServiceStatus(projectRoot, agentName, nextStatus);
    return buildDiscordAgentServiceSnapshot(projectRoot, agentName, nextStatus);
  }
  writeDiscordServiceStatus(projectRoot, nextStatus);
  return buildDiscordServiceSnapshot(projectRoot, nextStatus);
}

function normalizeTelegramServiceStoppedState(projectRoot, agentName = null, options = {}) {
  const rawStatus = agentName
    ? readTelegramAgentServiceStatus(projectRoot, agentName)
    : readTelegramServiceStatus(projectRoot);
  if (!rawStatus) {
    return agentName
      ? buildTelegramAgentServiceSnapshot(projectRoot, agentName, null)
      : buildTelegramServiceSnapshot(projectRoot, null);
  }

  const nextStatus = {
    ...rawStatus,
    running: false,
    desiredRunning:
      options.desiredRunning === undefined
        ? Boolean(rawStatus.desiredRunning ?? rawStatus.running)
        : Boolean(options.desiredRunning),
    stoppedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  if (agentName) {
    writeTelegramAgentServiceStatus(projectRoot, agentName, nextStatus);
    return buildTelegramAgentServiceSnapshot(projectRoot, agentName, nextStatus);
  }
  writeTelegramServiceStatus(projectRoot, nextStatus);
  return buildTelegramServiceSnapshot(projectRoot, nextStatus);
}

function normalizeKakaoServiceStoppedState(projectRoot, agentName = null, options = {}) {
  const rawStatus = agentName
    ? readKakaoAgentServiceStatus(projectRoot, agentName)
    : readKakaoServiceStatus(projectRoot);
  if (!rawStatus) {
    return agentName
      ? buildKakaoAgentServiceSnapshot(projectRoot, agentName, null)
      : buildKakaoServiceSnapshot(projectRoot, null);
  }

  const nextStatus = {
    ...rawStatus,
    running: false,
    desiredRunning:
      options.desiredRunning === undefined
        ? Boolean(rawStatus.desiredRunning ?? rawStatus.running)
        : Boolean(options.desiredRunning),
    stoppedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  if (agentName) {
    writeKakaoAgentServiceStatus(projectRoot, agentName, nextStatus);
    return buildKakaoAgentServiceSnapshot(projectRoot, agentName, nextStatus);
  }
  writeKakaoServiceStatus(projectRoot, nextStatus);
  return buildKakaoServiceSnapshot(projectRoot, nextStatus);
}

function setDiscordAgentDesiredRunning(projectRoot, agentName, desiredRunning) {
  const rawStatus = readDiscordAgentServiceStatus(projectRoot, agentName);
  writeDiscordAgentServiceStatus(projectRoot, agentName, {
    version: 1,
    projectRoot,
    agentName,
    pid: rawStatus?.pid || null,
    running: Boolean(rawStatus?.running),
    desiredRunning: Boolean(desiredRunning),
    startedAt: rawStatus?.startedAt || null,
    stoppedAt: rawStatus?.stoppedAt || null,
    heartbeatAt: rawStatus?.heartbeatAt || null,
    lastError: rawStatus?.lastError || null,
    agents: rawStatus?.agents || rawStatus?.bots || {},
  });
}

function setTelegramAgentDesiredRunning(projectRoot, agentName, desiredRunning) {
  const rawStatus = readTelegramAgentServiceStatus(projectRoot, agentName);
  writeTelegramAgentServiceStatus(projectRoot, agentName, {
    version: 1,
    projectRoot,
    agentName,
    pid: rawStatus?.pid || null,
    running: Boolean(rawStatus?.running),
    desiredRunning: Boolean(desiredRunning),
    startedAt: rawStatus?.startedAt || null,
    stoppedAt: rawStatus?.stoppedAt || null,
    heartbeatAt: rawStatus?.heartbeatAt || null,
    lastError: rawStatus?.lastError || null,
    agents: rawStatus?.agents || rawStatus?.bots || {},
  });
}

function setKakaoAgentDesiredRunning(projectRoot, agentName, desiredRunning) {
  const rawStatus = readKakaoAgentServiceStatus(projectRoot, agentName);
  writeKakaoAgentServiceStatus(projectRoot, agentName, {
    version: 1,
    projectRoot,
    agentName,
    pid: rawStatus?.pid || null,
    running: Boolean(rawStatus?.running),
    desiredRunning: Boolean(desiredRunning),
    startedAt: rawStatus?.startedAt || null,
    stoppedAt: rawStatus?.stoppedAt || null,
    heartbeatAt: rawStatus?.heartbeatAt || null,
    lastError: rawStatus?.lastError || null,
    agents: rawStatus?.agents || rawStatus?.accounts || {},
  });
}

function buildDiscordServiceStartArgs(projectRoot, { agentName = null } = {}) {
  const customEntry = String(process.env[DISCORD_SERVICE_ENTRY_ENV] || '').trim();
  if (customEntry) {
    return agentName ? [customEntry, projectRoot, agentName] : [customEntry, projectRoot];
  }

  const args = [CLI_ENTRY_PATH, '--root', projectRoot, 'discord', 'serve'];
  if (agentName) {
    args.push('--agent', agentName);
  }
  return args;
}

function buildTelegramServiceStartArgs(projectRoot, { agentName = null } = {}) {
  const customEntry = String(process.env[TELEGRAM_SERVICE_ENTRY_ENV] || '').trim();
  if (customEntry) {
    return agentName ? [customEntry, projectRoot, agentName] : [customEntry, projectRoot];
  }

  const args = [CLI_ENTRY_PATH, '--root', projectRoot, 'telegram', 'serve'];
  if (agentName) {
    args.push('--agent', agentName);
  }
  return args;
}

function buildKakaoServiceStartArgs(projectRoot, { agentName = null } = {}) {
  const customEntry = String(process.env[KAKAO_SERVICE_ENTRY_ENV] || '').trim();
  if (customEntry) {
    return agentName ? [customEntry, projectRoot, agentName] : [customEntry, projectRoot];
  }

  const args = [CLI_ENTRY_PATH, '--root', projectRoot, 'kakao', 'serve'];
  if (agentName) {
    args.push('--agent', agentName);
  }
  return args;
}

async function waitForDiscordServiceSnapshot(projectRoot, agentName, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildDiscordAgentServiceSnapshot(projectRoot, agentName);
  while (Date.now() < deadline) {
    snapshot = buildDiscordAgentServiceSnapshot(projectRoot, agentName);
    if (predicate(snapshot)) {
      return snapshot;
    }
    await delay(200);
  }
  return snapshot;
}

async function waitForTelegramServiceSnapshot(projectRoot, agentName, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildTelegramAgentServiceSnapshot(projectRoot, agentName);
  while (Date.now() < deadline) {
    snapshot = buildTelegramAgentServiceSnapshot(projectRoot, agentName);
    if (predicate(snapshot)) {
      return snapshot;
    }
    await delay(200);
  }
  return snapshot;
}

async function waitForKakaoServiceSnapshot(projectRoot, agentName, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildKakaoAgentServiceSnapshot(projectRoot, agentName);
  while (Date.now() < deadline) {
    snapshot = buildKakaoAgentServiceSnapshot(projectRoot, agentName);
    if (predicate(snapshot)) {
      return snapshot;
    }
    await delay(200);
  }
  return snapshot;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function listConfiguredDiscordAgents(projectRoot) {
  const config = loadConfig(projectRoot);
  return Object.entries(config.agents || {})
    .filter(([, agent]) => String(agent?.discordToken || '').trim())
    .map(([agentName]) => agentName);
}

function listConfiguredTelegramAgents(projectRoot) {
  const config = loadConfig(projectRoot);
  return Object.entries(config.agents || {})
    .filter(([, agent]) => String(agent?.telegramBotToken || '').trim())
    .map(([agentName]) => agentName);
}

function listConfiguredKakaoAgents(projectRoot) {
  const config = loadConfig(projectRoot);
  return Object.entries(config.agents || {})
    .filter(([, agent]) => (agent?.platform || 'discord') === 'kakao')
    .map(([agentName]) => agentName);
}

async function runAgentAuthAction(projectRoot, payload) {
  const agentType = String(payload?.agentType || '').trim();
  const action = String(payload?.action || 'status').trim();
  if (agentType === 'codex' && action === 'login') {
    return startCodexAuthFlow(projectRoot, payload);
  }
  if (agentType === 'codex' && action === 'logout') {
    await cleanupCodexAuthFlow(projectRoot);
  }
  if (agentType === 'claude-code' && action === 'login') {
    return startClaudeAuthFlow(projectRoot, payload);
  }
  if (agentType === 'claude-code' && action === 'complete-login') {
    return completeClaudeAuthFlow(projectRoot, payload);
  }
  if (agentType === 'claude-code' && action === 'logout') {
    await cleanupClaudeAuthFlow(projectRoot);
  }
  if (agentType === 'gemini-cli' && action === 'login') {
    return startGeminiAuthFlow(projectRoot, payload);
  }
  if (agentType === 'gemini-cli' && action === 'complete-login') {
    return completeGeminiAuthFlow(projectRoot, payload);
  }
  if (agentType === 'gemini-cli' && action === 'logout') {
    return logoutGeminiAuthFlow(projectRoot);
  }
  if (action === 'test') {
    return runAgentAuthTest(projectRoot, payload);
  }
  if (action === 'status') {
    return readAgentStatus(projectRoot, agentType, payload);
  }
  const spec = resolveAgentAuthCommand(agentType, action, payload);
  const env = buildManagedAgentEnv(projectRoot, agentType);

  return new Promise((resolve, reject) => {
    const child = spawnResolvedCommand(spec.command, spec.args, {
      agentType,
      cwd: process.cwd(),
      env,
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, spec.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      const output = [Buffer.concat(stdout).toString('utf8').trim(), Buffer.concat(stderr).toString('utf8').trim()]
        .filter(Boolean)
        .join('\n')
        .trim();
      const cleanedOutput = stripAnsiEscapeSequences(output);

      resolve({
        agentType,
        action,
        command: [spec.command, ...spec.args].join(' '),
        output: cleanedOutput || '(출력 없음)',
        details: parseAgentAuthOutput(agentType, action, cleanedOutput, code),
        exitCode: code,
        signal: signal || null,
        timedOut,
      });
    });
  });
}

function getCodexAuthFlowKey(projectRoot) {
  return path.resolve(projectRoot);
}

function getCodexAuthFlow(projectRoot) {
  return codexAuthFlows.get(getCodexAuthFlowKey(projectRoot)) || null;
}

function setCodexAuthFlow(projectRoot, flow) {
  codexAuthFlows.set(getCodexAuthFlowKey(projectRoot), flow);
}

async function cleanupCodexAuthFlow(projectRoot) {
  const key = getCodexAuthFlowKey(projectRoot);
  const flow = codexAuthFlows.get(key);
  codexAuthFlows.delete(key);
  if (!flow) {
    return;
  }

  clearTimeout(flow.captureTimer);
  flow.child.stdout?.removeAllListeners?.('data');
  flow.child.stderr?.removeAllListeners?.('data');

  try {
    if (!flow.child.killed) {
      flow.child.kill('SIGTERM');
    }
  } catch {
    // Ignore cleanup failures for stale auth helpers.
  }
}

async function startCodexAuthFlow(projectRoot, payload = {}) {
  await cleanupCodexAuthFlow(projectRoot);

  const spec = resolveAgentAuthCommand('codex', 'login', payload);
  const env = buildManagedAgentEnv(projectRoot, 'codex');
  const child = spawnResolvedCommand(spec.command, spec.args, {
    agentType: 'codex',
    cwd: process.cwd(),
    env,
  });

  const stdout = [];
  const stderr = [];
  const flow = {
    id: randomUUID(),
    child,
    captureTimer: null,
    output: '',
    url: '',
    code: '',
  };

  const updateFlowOutput = () => {
    const output = [
      Buffer.concat(stdout).toString('utf8').trim(),
      Buffer.concat(stderr).toString('utf8').trim(),
    ]
      .filter(Boolean)
      .join('\n')
      .trim();
    const cleanedOutput = sanitizeManagedAgentAuthOutput(
      'codex',
      stripAnsiEscapeSequences(output),
    );
    flow.output = cleanedOutput;
    flow.url = extractFirstUrl(cleanedOutput);
    flow.code = parseDeviceAuthCode(cleanedOutput);
  };

  child.stdout.on('data', (chunk) => {
    stdout.push(chunk);
    updateFlowOutput();
  });
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk);
    updateFlowOutput();
  });

  child.on('close', () => {
    updateFlowOutput();
    const activeFlow = getCodexAuthFlow(projectRoot);
    if (activeFlow?.id === flow.id) {
      codexAuthFlows.delete(getCodexAuthFlowKey(projectRoot));
    }
  });
  child.on('error', () => {
    const activeFlow = getCodexAuthFlow(projectRoot);
    if (activeFlow?.id === flow.id) {
      codexAuthFlows.delete(getCodexAuthFlowKey(projectRoot));
    }
  });

  setCodexAuthFlow(projectRoot, flow);

  await new Promise((resolve) => {
    const finish = () => {
      child.stdout?.off?.('data', maybeFinish);
      child.stderr?.off?.('data', maybeFinish);
      clearTimeout(flow.captureTimer);
      resolve();
    };
    const maybeFinish = () => {
      if (flow.url && flow.code) {
        finish();
      }
    };

    child.stdout.on('data', maybeFinish);
    child.stderr.on('data', maybeFinish);
    flow.captureTimer = setTimeout(finish, spec.timeoutMs);
  });

  return {
    agentType: 'codex',
    action: 'login',
    command: [spec.command, ...spec.args].join(' '),
    output: flow.output || '(출력 없음)',
    details: {
      summary: flow.code ? '링크를 열고 코드를 입력하세요.' : '로그인을 시작했습니다.',
      url: flow.url,
      code: flow.code,
      loginStarted: true,
      pendingLogin: true,
    },
    exitCode: null,
    signal: null,
    timedOut: false,
  };
}

function spawnResolvedCommand(command, args, options) {
  const managedRunner = options?.agentType
    ? resolveManagedAgentRunner(options.agentType, options.env)
    : null;
  if (options?.agentType) {
    assert(
      managedRunner,
      `Bundled runtime for agent type "${options.agentType}" is not installed.`,
    );
    const env = {
      ...(options?.env || process.env),
      ...(managedRunner.envPatch || {}),
    };
    return spawn(managedRunner.command, [...managedRunner.argsPrefix, ...args], {
      ...options,
      env,
      shell: false,
    });
  }

  const env = options?.env || process.env;
  const resolvedCommand = command;

  return spawn(resolvedCommand, args, {
    ...options,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/iu.test(resolvedCommand),
  });
}

function resolveManagedAgentRunner(agentType, env = process.env) {
  if (agentType === 'claude-code') {
    return resolveClaudeCli(env);
  }
  return resolveManagedAgentCli(agentType, env);
}

function getClaudeAuthFlowKey(projectRoot) {
  return path.resolve(projectRoot);
}

function getClaudeAuthFlow(projectRoot) {
  return claudeAuthFlows.get(getClaudeAuthFlowKey(projectRoot)) || null;
}

function setClaudeAuthFlow(projectRoot, flow) {
  claudeAuthFlows.set(getClaudeAuthFlowKey(projectRoot), flow);
}

async function cleanupClaudeAuthFlow(projectRoot) {
  const key = getClaudeAuthFlowKey(projectRoot);
  const flow = claudeAuthFlows.get(key);
  claudeAuthFlows.delete(key);
  if (!flow) {
    return;
  }
  try {
    await flow.bridge?.request?.('auth.close').catch(() => {});
    flow.bridge?.close?.();
  } catch {
    // Ignore cleanup failures; the auth flow is best-effort.
  }
}

async function readAiStatuses(projectRoot) {
  const usageSummaries = await summarizeRuntimeUsage(projectRoot);
  const entries = await Promise.all(
    AI_STATUS_AGENT_TYPES.map(async (agentType) => {
      try {
        const authResult = await runAgentAuthAction(projectRoot, {
          agentType,
          action: 'status',
        });
        return [
          agentType,
          {
            authResult,
            testResult: null,
            usageSummary: buildAiUsageSummary(agentType, usageSummaries[agentType] || null),
          },
        ];
      } catch (error) {
        return [
          agentType,
          {
            authResult: {
              agentType,
              action: 'status',
              output: toErrorMessage(error),
              details: {
                summary: '확인 불가',
                loggedIn: false,
              },
            },
            testResult: null,
            usageSummary: buildAiUsageSummary(agentType, usageSummaries[agentType] || null),
          },
        ];
      }
    }),
  );

  return Object.fromEntries(entries);
}

async function startClaudeAuthFlow(projectRoot, payload = {}) {
  await cleanupClaudeAuthFlow(projectRoot);

  const loginMode = normalizeClaudeLoginMode(payload?.options?.loginMode);
  const env = buildManagedAgentEnv(projectRoot, 'claude-code');
  const runtime = resolveClaudeCli(env);
  assert(runtime, 'Claude CLI runtime is unavailable.');
  if (runtime.source === 'external') {
    const commandHint = buildClaudeExternalLoginCommand(runtime.command, loginMode);
    return {
      agentType: 'claude-code',
      action: 'login',
      command: commandHint,
      output: [
        '외부 Claude CLI를 사용 중입니다.',
        `같은 환경의 터미널에서 ${commandHint} 를 먼저 실행하세요.`,
        '로그인 완료 뒤 상태 확인을 눌러 현재 머신의 Claude 로그인 상태를 다시 읽으세요.',
      ].join('\n'),
      details: {
        summary: '외부 Claude CLI 로그인은 터미널에서 진행하세요.',
        loginStarted: false,
        pendingLogin: false,
        requiresCode: false,
        completionHint:
          '같은 환경의 터미널에서 Claude CLI 로그인을 완료한 뒤 상태 확인을 누르세요.',
        loginMode,
        runtimeSource: runtime.source,
        runtimeDetail: runtime.detail,
        sharedLogin: true,
        authScope: 'local-user',
        externalCli: true,
        commandHint,
        url: '',
        manualUrl: '',
        automaticUrl: '',
      },
      exitCode: 0,
      signal: null,
      timedOut: false,
    };
  }
  const bridge = createClaudeWorkerBridge({
    cwd: projectRoot,
    env,
  });

  try {
    const auth = await bridge.request('auth.start', {
      cwd: projectRoot,
      loginMode,
    });
    const flow = {
      id: randomUUID(),
      createdAt: Date.now(),
      bridge,
      loginMode,
      manualUrl: String(auth?.manualUrl || '').trim(),
      automaticUrl: String(auth?.automaticUrl || '').trim(),
    };
    setClaudeAuthFlow(projectRoot, flow);

    return {
      agentType: 'claude-code',
      action: 'login',
      command: `claude oauth (${loginMode})`,
      output: [
        '브라우저에서 로그인을 완료하세요.',
        flow.manualUrl ? `manualUrl: ${flow.manualUrl}` : '',
        flow.automaticUrl ? `automaticUrl: ${flow.automaticUrl}` : '',
      ].filter(Boolean).join('\n'),
      details: {
        summary: '브라우저에서 로그인을 완료하세요.',
        loginStarted: true,
        requiresCode: true,
        completionHint:
          '브라우저 인증 뒤 최종 callback URL 전체를 붙여넣고 로그인 완료를 누르세요.',
        loginMode,
        sessionId: flow.id,
        url: flow.manualUrl || flow.automaticUrl || '',
        manualUrl: flow.manualUrl || '',
        automaticUrl: flow.automaticUrl || '',
      },
      exitCode: 0,
      signal: null,
      timedOut: false,
    };
  } catch (error) {
    bridge.close();
    throw error;
  }
}

async function completeClaudeAuthFlow(projectRoot, payload = {}) {
  const flow = getClaudeAuthFlow(projectRoot);
  if (!flow) {
    const runtime = resolveClaudeCli(buildManagedAgentEnv(projectRoot, 'claude-code'));
    if (runtime?.source === 'external') {
      return {
        agentType: 'claude-code',
        action: 'complete-login',
        command: buildClaudeExternalLoginCommand(runtime.command, normalizeClaudeLoginMode()),
        output: [
          '외부 Claude CLI는 웹에서 로그인 완료 단계를 따로 처리하지 않습니다.',
          '터미널에서 Claude CLI 로그인을 끝낸 뒤 상태 확인을 누르세요.',
        ].join('\n'),
        details: {
          summary: '외부 Claude CLI는 상태 확인만 하면 됩니다.',
          loggedIn: false,
          pendingLogin: false,
          requiresCode: false,
          runtimeSource: runtime.source,
          runtimeDetail: runtime.detail,
          sharedLogin: true,
          authScope: 'local-user',
          externalCli: true,
        },
        exitCode: 0,
        signal: null,
        timedOut: false,
      };
    }
  }
  assert(flow, 'Claude Code CLI 로그인 세션이 없습니다. 먼저 로그인 버튼을 누르세요.');
  const callback = parseClaudeOAuthCallbackPayload(payload);
  const resolvedState = callback.state || resolveClaudeOAuthState(flow);
  assert(
    callback.authorizationCode,
    '브라우저 완료 후 callback URL 전체를 붙여넣으세요.',
  );
  assert(
    resolvedState,
    'Claude Code CLI 로그인 상태를 찾지 못했습니다. 다시 로그인 버튼을 누르세요.',
  );

  try {
    const completion = await flow.bridge.request('auth.complete', {
      authorizationCode: callback.authorizationCode,
      state: resolvedState,
    });
    const account = completion?.account || {};
    await cleanupClaudeAuthFlow(projectRoot);
    return {
      agentType: 'claude-code',
      action: 'complete-login',
      command: 'claude oauth callback',
      output: [
        'Claude Code CLI 로그인 완료',
        account?.email ? `email: ${account.email}` : '',
        account?.organization ? `organization: ${account.organization}` : '',
      ].filter(Boolean).join('\n'),
      details: {
        summary: 'Claude Code CLI 로그인 완료',
        loggedIn: true,
        authMethod: 'oauth',
        account,
      },
      exitCode: 0,
      signal: null,
      timedOut: false,
    };
  } catch (error) {
    await cleanupClaudeAuthFlow(projectRoot);
    throw error;
  }
}

function getGeminiAuthFlowKey(projectRoot) {
  return path.resolve(projectRoot);
}

function getGeminiAuthFlow(projectRoot) {
  return geminiAuthFlows.get(getGeminiAuthFlowKey(projectRoot)) || null;
}

function setGeminiAuthFlow(projectRoot, flow) {
  geminiAuthFlows.set(getGeminiAuthFlowKey(projectRoot), flow);
}

async function cleanupGeminiAuthFlow(projectRoot) {
  geminiAuthFlows.delete(getGeminiAuthFlowKey(projectRoot));
}

async function startGeminiAuthFlow(projectRoot) {
  await cleanupGeminiAuthFlow(projectRoot);

  const authRuntime = await loadGeminiAuthRuntime(projectRoot);
  const oauthConfig = readGeminiOauthConfig(authRuntime);
  const pkceParams = createGeminiPkceParams(authRuntime);
  const authUrl = buildGeminiGoogleAuthUrl(authRuntime, oauthConfig, pkceParams);

  const flow = {
    id: randomUUID(),
    createdAt: Date.now(),
    pkceParams,
    authUrl,
    oauthConfig,
  };
  setGeminiAuthFlow(projectRoot, flow);

  return {
    agentType: 'gemini-cli',
    action: 'login',
    command: 'gemini oauth manual',
    output: [
      '브라우저에서 Google 로그인을 완료하세요.',
      `authorizationUrl: ${authUrl}`,
      '로그인 후 표시되는 authorization code를 붙여넣고 로그인 완료를 누르세요.',
    ].join('\n'),
    details: {
      summary: '브라우저에서 Google 로그인을 완료하세요.',
      loginStarted: true,
      requiresCode: true,
      completionHint: '브라우저 인증 뒤 표시된 authorization code를 붙여넣고 로그인 완료를 누르세요.',
      pendingLogin: true,
      sessionId: flow.id,
      url: authUrl,
      manualUrl: authUrl,
      authMethod: 'google',
    },
    exitCode: 0,
    signal: null,
    timedOut: false,
  };
}

async function completeGeminiAuthFlow(projectRoot, payload = {}) {
  const flow = getGeminiAuthFlow(projectRoot);
  assert(flow, 'Gemini CLI 로그인 세션이 없습니다. 먼저 로그인 버튼을 누르세요.');

  const authorizationCode = parseGeminiAuthorizationCodePayload(payload);
  assert(
    authorizationCode,
    '브라우저 로그인 완료 후 authorization code를 붙여넣으세요.',
  );

  const authRuntime = await loadGeminiAuthRuntime(projectRoot);
  const tokens = await exchangeGeminiAuthCode(authRuntime, flow.oauthConfig, {
    authorizationCode,
    codeVerifier: flow.pkceParams?.codeVerifier || '',
  });

  const account = await persistGeminiOAuthCredentials(authRuntime, tokens);
  await cleanupGeminiAuthFlow(projectRoot);

  return {
    agentType: 'gemini-cli',
    action: 'complete-login',
    command: 'gemini oauth exchange',
    output: [
      'Gemini CLI Google 로그인 완료',
      account?.email ? `email: ${account.email}` : '',
    ].filter(Boolean).join('\n'),
    details: {
      summary: 'Gemini CLI Google 로그인 완료',
      loggedIn: true,
      ready: true,
      runtimeReady: true,
      authMethod: 'google',
      account,
    },
    exitCode: 0,
    signal: null,
    timedOut: false,
  };
}

async function logoutGeminiAuthFlow(projectRoot) {
  const authRuntime = await loadGeminiAuthRuntime(projectRoot);
  await cleanupGeminiAuthFlow(projectRoot);
  await authRuntime.supportModule.clearCachedCredentialFile();
  const accountManager = new authRuntime.supportModule.UserAccountManager();
  const accountCachePath = String(accountManager.getGoogleAccountsCachePath?.() || '').trim();
  if (accountCachePath) {
    await fs.promises.rm(accountCachePath, { force: true }).catch(() => {});
  }
  authRuntime.supportModule.clearOauthClientCache?.();

  return {
    agentType: 'gemini-cli',
    action: 'logout',
    command: 'gemini logout',
    output: 'Gemini CLI Google 로그인 상태를 지웠습니다.',
    details: {
      summary: '로그아웃됨',
      loggedIn: false,
      authMethod: 'google',
    },
    exitCode: 0,
    signal: null,
    timedOut: false,
  };
}

async function loadGeminiAuthRuntime(projectRoot) {
  const env = buildManagedAgentEnv(projectRoot, 'gemini-cli');
  const cli = resolveManagedAgentCli('gemini-cli', env);
  assert(
    cli,
    'gemini is unavailable. Bundled dependency @google/gemini-cli is required; reinstall hkclaw-lite without omitting optional dependencies.',
  );

  const scriptPath = String(cli.argsPrefix?.[0] || '').trim();
  assert(scriptPath, 'Bundled Gemini CLI entrypoint is unavailable.');

  const bundleDir = path.dirname(scriptPath);
  const geminiSource = fs.readFileSync(scriptPath, 'utf8');
  const supportModulePath = resolveGeminiBundleChunkPath(bundleDir, geminiSource, 'getOauthClient');
  const coreModulePath = resolveGeminiBundleChunkPath(bundleDir, geminiSource, 'Storage');
  const [supportModule, coreModule] = await Promise.all([
    import(pathToFileURL(supportModulePath).href),
    import(pathToFileURL(coreModulePath).href),
  ]);

  assert(
    typeof supportModule.UserAccountManager === 'function',
    'Gemini CLI support bundle is missing UserAccountManager.',
  );
  assert(
    typeof supportModule.clearCachedCredentialFile === 'function',
    'Gemini CLI support bundle is missing clearCachedCredentialFile().',
  );
  assert(
    typeof supportModule.clearOauthClientCache === 'function',
    'Gemini CLI support bundle is missing clearOauthClientCache().',
  );
  assert(
    coreModule?.Storage && typeof coreModule.Storage.getOAuthCredsPath === 'function',
    'Gemini CLI core bundle is missing Storage.getOAuthCredsPath().',
  );

  return {
    cli,
    scriptPath,
    bundleDir,
    supportModulePath,
    coreModulePath,
    supportModule,
    coreModule,
  };
}

function resolveGeminiBundleChunkPath(bundleDir, geminiSource, exportedName) {
  const escapedName = exportedName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(
    `import\\s*\\{[\\s\\S]*?\\b${escapedName}\\b[\\s\\S]*?\\}\\s*from\\s*"(.\\/chunk-[^"]+\\.js)"`,
    'u',
  );
  const match = geminiSource.match(pattern);
  assert(match?.[1], `Gemini CLI bundle is missing ${exportedName} import metadata.`);
  return path.resolve(bundleDir, match[1]);
}

function readGeminiOauthConfig(authRuntime) {
  const source = fs.readFileSync(authRuntime.supportModulePath, 'utf8');
  const clientId =
    String(process.env.HKCLAW_LITE_GEMINI_OAUTH_CLIENT_ID || '').trim() ||
    source.match(/var OAUTH_CLIENT_ID = "([^"]+)";/u)?.[1] ||
    '';
  const clientSecret =
    String(process.env.HKCLAW_LITE_GEMINI_OAUTH_CLIENT_SECRET || '').trim() ||
    source.match(/var OAUTH_CLIENT_SECRET = "([^"]+)";/u)?.[1] ||
    '';
  const redirectUri =
    String(process.env.HKCLAW_LITE_GEMINI_OAUTH_MANUAL_REDIRECT_URI || '').trim() ||
    source.match(/const redirectUri = "(https:\/\/[^"]+)";/u)?.[1] ||
    GEMINI_GOOGLE_MANUAL_REDIRECT_URI;
  const scopeMatch = source.match(/var OAUTH_SCOPE = \[([\s\S]*?)\];/u)?.[1] || '';
  const scopes = Array.from(scopeMatch.matchAll(/"([^"]+)"/gu), (entry) => entry[1]);

  assert(clientId, 'Gemini CLI bundle is missing OAuth client ID metadata.');
  assert(clientSecret, 'Gemini CLI bundle is missing OAuth client secret metadata.');
  assert(scopes.length > 0, 'Gemini CLI bundle is missing OAuth scope metadata.');

  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    authorizationUrl:
      String(process.env.HKCLAW_LITE_GEMINI_OAUTH_AUTH_URL || '').trim() ||
      GEMINI_GOOGLE_AUTH_URL,
    tokenUrl:
      String(process.env.HKCLAW_LITE_GEMINI_OAUTH_TOKEN_URL || '').trim() ||
      GEMINI_GOOGLE_TOKEN_URL,
    userInfoUrl:
      String(process.env.HKCLAW_LITE_GEMINI_OAUTH_USERINFO_URL || '').trim() ||
      GEMINI_GOOGLE_USERINFO_URL,
  };
}

function createPkceCodeVerifier() {
  return randomBytes(64).toString('base64url');
}

function createPkceCodeChallenge(codeVerifier) {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

function createGeminiPkceParams(authRuntime) {
  const generated = authRuntime.supportModule.generatePKCEParams?.();
  const codeVerifier = String(generated?.codeVerifier || '').trim();
  const codeChallenge = String(generated?.codeChallenge || '').trim();
  const state = String(generated?.state || '').trim();
  if (codeVerifier && codeChallenge && state) {
    return {
      codeVerifier,
      codeChallenge,
      state,
    };
  }

  const fallbackCodeVerifier = createPkceCodeVerifier();
  return {
    codeVerifier: fallbackCodeVerifier,
    codeChallenge: createPkceCodeChallenge(fallbackCodeVerifier),
    state: randomBytes(32).toString('hex'),
  };
}

function buildGeminiGoogleAuthUrl(authRuntime, oauthConfig, pkceParams) {
  if (typeof authRuntime.supportModule.buildAuthorizationUrl === 'function') {
    const url = new URL(
      authRuntime.supportModule.buildAuthorizationUrl(oauthConfig, pkceParams, undefined),
    );
    if (!url.searchParams.has('access_type')) {
      url.searchParams.set('access_type', 'offline');
    }
    return url.toString();
  }

  const params = new URLSearchParams({
    client_id: oauthConfig.clientId,
    response_type: 'code',
    redirect_uri: oauthConfig.redirectUri,
    access_type: 'offline',
    state: pkceParams.state,
    code_challenge: pkceParams.codeChallenge,
    code_challenge_method: 'S256',
    scope: oauthConfig.scopes.join(' '),
  });
  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

function parseGeminiAuthorizationCodePayload(payload = {}) {
  const value = String(
    payload?.authorizationCode ||
    payload?.code ||
    payload?.callbackUrl ||
    payload?.options?.authorizationCode ||
    '',
  ).trim();
  if (!value) {
    return '';
  }

  try {
    const parsedUrl = new URL(value);
    return String(
      parsedUrl.searchParams.get('code') ||
      parsedUrl.searchParams.get('authorization_code') ||
      '',
    ).trim();
  } catch {
    return value;
  }
}

async function exchangeGeminiAuthCode(authRuntime, oauthConfig, { authorizationCode, codeVerifier }) {
  if (typeof authRuntime.supportModule.exchangeCodeForToken === 'function') {
    const tokens = await authRuntime.supportModule.exchangeCodeForToken(
      oauthConfig,
      authorizationCode,
      codeVerifier,
      undefined,
    );
    return normalizeGeminiOAuthTokens(tokens);
  }

  const response = await fetch(oauthConfig.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json, application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code: authorizationCode,
      code_verifier: codeVerifier,
      client_id: oauthConfig.clientId,
      redirect_uri: oauthConfig.redirectUri,
      grant_type: 'authorization_code',
      ...(oauthConfig.clientSecret
        ? {
            client_secret: oauthConfig.clientSecret,
          }
        : {}),
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof payload.error_description === 'string'
        ? payload.error_description
        : typeof payload.error === 'string'
          ? payload.error
          : `HTTP ${response.status}`;
    throw new Error(`Gemini OAuth 토큰 교환에 실패했습니다: ${message}`);
  }

  return normalizeGeminiOAuthTokens(payload);
}

function normalizeGeminiOAuthTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') {
    return {};
  }

  const normalized = { ...tokens };
  const expiresInRaw = normalized.expires_in;
  const expiresIn =
    typeof expiresInRaw === 'number'
      ? expiresInRaw
      : typeof expiresInRaw === 'string'
        ? Number.parseInt(expiresInRaw, 10)
        : Number.NaN;
  if (
    !Number.isNaN(expiresIn) &&
    Number.isFinite(expiresIn) &&
    typeof normalized.expiry_date !== 'number'
  ) {
    normalized.expiry_date = Date.now() + (expiresIn * 1000);
  }
  return normalized;
}

async function persistGeminiOAuthCredentials(authRuntime, tokens) {
  const credentialsPath = authRuntime.coreModule.Storage.getOAuthCredsPath();
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(tokens, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(credentialsPath, 0o600);
  } catch {
    // Ignore chmod failures on unsupported filesystems.
  }

  authRuntime.supportModule.clearOauthClientCache?.();
  const account = await fetchGeminiUserInfo(authRuntime, tokens);
  if (account?.email) {
    const manager = new authRuntime.supportModule.UserAccountManager();
    await manager.cacheGoogleAccount(account.email);
  }
  return account;
}

async function fetchGeminiUserInfo(authRuntime, tokens) {
  const accessToken = String(tokens?.access_token || '').trim();
  if (!accessToken) {
    return null;
  }

  const oauthConfig = readGeminiOauthConfig(authRuntime);
  const response = await fetch(oauthConfig.userInfoUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return {
    email: typeof payload.email === 'string' ? payload.email : '',
    name: typeof payload.name === 'string' ? payload.name : '',
  };
}

async function readGeminiAuthState(projectRoot) {
  const authRuntime = await loadGeminiAuthRuntime(projectRoot);
  const accountManager = new authRuntime.supportModule.UserAccountManager();
  const email = String(accountManager.getCachedGoogleAccount?.() || '').trim();
  const credentialsPath = authRuntime.coreModule.Storage.getOAuthCredsPath();
  const hasCachedCredentials = fs.existsSync(credentialsPath);
  const normalizedEmail = hasCachedCredentials ? email : '';
  return {
    authRuntime,
    email: normalizedEmail,
    hasCachedCredentials,
    loggedIn: Boolean(hasCachedCredentials),
  };
}

async function readAgentStatus(projectRoot, agentType, payload = {}) {
  if (agentType === 'codex') {
    const authResult = await runManagedCliAuthAction(projectRoot, agentType, 'status', payload);
    const loggedIn = Boolean(authResult?.details?.loggedIn);
    if (loggedIn && getCodexAuthFlow(projectRoot)) {
      await cleanupCodexAuthFlow(projectRoot);
    }
    const pendingFlow = loggedIn ? null : getCodexAuthFlow(projectRoot);
    const pendingUrl = pendingFlow?.url || '';
    const pendingCode = pendingFlow?.code || '';
    return {
      ...authResult,
      output: [
        authResult.output,
        pendingFlow ? '브라우저 로그인: 진행 중' : '',
        pendingCode ? `디바이스 코드: ${pendingCode}` : '',
        '인증 저장소: 이 머신의 로컬 Codex 로그인 상태를 그대로 사용합니다.',
      ].filter(Boolean).join('\n'),
      details: {
        ...(authResult.details || {}),
        pendingLogin: Boolean(pendingFlow),
        requiresCode: Boolean(pendingFlow),
        completionHint: pendingFlow
          ? '브라우저에서 링크를 연 뒤 표시된 디바이스 코드를 입력하고 승인을 완료하세요.'
          : '',
        url: pendingUrl,
        code: pendingCode,
        sharedLogin: true,
        authScope: 'local-user',
      },
    };
  }

  if (agentType === 'claude-code') {
    const runtime = inspectAgentRuntime(projectRoot, { agent: 'claude-code' });
    const pendingFlow = getClaudeAuthFlow(projectRoot);
    let authResult;
    try {
      authResult = await runManagedCliAuthAction(projectRoot, agentType, 'status', payload);
    } catch (error) {
      authResult = {
        agentType,
        action: 'status',
        command: 'claude auth status --json',
        output: toErrorMessage(error),
        details: {
          summary: '로그인 상태 확인 실패',
          loggedIn: false,
        },
        exitCode: 1,
        signal: null,
        timedOut: false,
      };
    }
    const loggedIn = Boolean(authResult?.details?.loggedIn);
    if (loggedIn && pendingFlow) {
      await cleanupClaudeAuthFlow(projectRoot);
    }
    const activeFlow = loggedIn ? null : getClaudeAuthFlow(projectRoot);
    const ready = Boolean(runtime.ready && loggedIn);
    const outputLines = [
      runtime.ready ? '런타임: 준비됨' : `런타임: ${runtime.detail || '미설치'}`,
      loggedIn
        ? `로그인: 완료 (${authResult.details.authMethod || 'account'})`
        : '로그인: 미완료',
      '인증 저장소: 이 머신의 로컬 Claude 로그인 상태를 그대로 사용합니다.',
      activeFlow
        ? `브라우저 로그인: 진행 중 (${activeFlow.loginMode === 'console' ? 'console' : 'claude.ai'})`
        : '',
      activeFlow
        ? '완료 방법: 브라우저 로그인 후 최종 callback URL 전체를 붙여넣고 로그인 완료를 누르세요.'
        : '',
    ].filter(Boolean);

    return {
      ...authResult,
      output: outputLines.join('\n'),
      details: {
        ...authResult.details,
        summary: ready
          ? 'Claude Code CLI 로그인됨'
          : activeFlow
            ? 'Claude Code CLI 브라우저 로그인 진행 중'
            : 'Claude Code CLI 로그인이 필요합니다.',
        runtimeReady: runtime.ready,
        runtimeSource: runtime.source || '',
        runtimeDetail: runtime.detail || '',
        ready,
        pendingLogin: Boolean(activeFlow),
        requiresCode: Boolean(activeFlow),
        completionHint: activeFlow
          ? '브라우저 인증 뒤 최종 callback URL 전체를 붙여넣고 로그인 완료를 누르세요.'
          : '',
        loginMode: activeFlow?.loginMode || null,
        manualUrl: activeFlow?.manualUrl || '',
        automaticUrl: activeFlow?.automaticUrl || '',
        sharedLogin: true,
        authScope: 'local-user',
        externalCli: runtime.source === 'external',
      },
    };
  }

  if (agentType === 'gemini-cli') {
    const runtime = inspectAgentRuntime(projectRoot, { agent: 'gemini-cli' });
    const pendingFlow = getGeminiAuthFlow(projectRoot);
    let geminiLogin = {
      loggedIn: false,
      email: '',
      hasCachedCredentials: false,
    };

    if (runtime.ready) {
      try {
        geminiLogin = await readGeminiAuthState(projectRoot);
      } catch {
        // Keep status best-effort.
      }
    }

    if (geminiLogin.loggedIn && pendingFlow) {
      await cleanupGeminiAuthFlow(projectRoot);
    }

    const runtimeReady = Boolean(runtime.ready);
    const loggedIn = Boolean(geminiLogin.loggedIn);
    const ready = runtimeReady && loggedIn;
    const activeFlow = loggedIn ? null : getGeminiAuthFlow(projectRoot);
    const outputLines = [
      runtimeReady ? '런타임: 준비됨' : `런타임: ${runtime.detail || '미설치'}`,
      loggedIn
        ? `Google 로그인: 완료${geminiLogin.email ? ` (${geminiLogin.email})` : ''}`
        : 'Google 로그인: 미완료',
      activeFlow ? '브라우저 로그인: 진행 중' : '',
      activeFlow ? '완료 방법: 브라우저 로그인 후 authorization code를 붙여넣고 로그인 완료를 누르세요.' : '',
    ].filter(Boolean);

    return {
      agentType,
      action: 'status',
      command: 'config inspection',
      output: outputLines.join('\n'),
      details: {
        summary: ready
          ? 'Gemini CLI Google 로그인됨'
          : activeFlow
            ? 'Gemini CLI 브라우저 로그인 진행 중'
            : runtimeReady
              ? 'Gemini CLI Google 로그인이 필요합니다.'
              : '런타임 준비 필요',
        loggedIn,
        runtimeReady,
        ready,
        authMethod: loggedIn ? 'google' : 'none',
        email: geminiLogin.email || '',
        pendingLogin: Boolean(activeFlow),
        requiresCode: Boolean(activeFlow),
        url: activeFlow?.authUrl || '',
        manualUrl: activeFlow?.authUrl || '',
      },
      exitCode: 0,
      signal: null,
      timedOut: false,
    };
  }

  if (agentType === 'local-llm') {
    const config = loadConfig(projectRoot);
    const runtime = inspectAgentRuntime(projectRoot, { agent: 'local-llm' });
    const connections = listLocalLlmConnections(config);
    const primaryConnection = connections[0] || {
      name: 'LLM1',
      baseUrl: DEFAULT_LOCAL_LLM_BASE_URL,
      apiKey: '',
    };
    return {
      agentType,
      action: 'status',
      command: 'config inspection',
      output: [
        `저장된 연결: ${connections.length}개`,
        `기본 연결: ${primaryConnection.name} (${primaryConnection.baseUrl})`,
      ].join('\n'),
      details: {
        summary: `로컬 LLM 연결 ${connections.length}개 설정됨`,
        configured: true,
        runtimeReady: runtime.ready,
        ready: false,
        baseUrl: primaryConnection.baseUrl,
        primaryConnection: primaryConnection.name,
        connections: connections.map((connection) => ({
          name: connection.name,
          baseUrl: connection.baseUrl,
          apiKeyConfigured: Boolean(connection.apiKey),
        })),
        credentialOptional: true,
        credentialSource: null,
      },
      exitCode: 0,
      signal: null,
      timedOut: false,
    };
  }

  assert(false, `Auth actions are not supported for agent type "${agentType}".`);
}

async function runManagedCliAuthAction(projectRoot, agentType, action, payload = {}) {
  const spec = resolveAgentAuthCommand(agentType, action, payload);
  const env = buildManagedAgentEnv(projectRoot, agentType);
  return await new Promise((resolve, reject) => {
    const child = spawnResolvedCommand(spec.command, spec.args, {
      agentType,
      cwd: process.cwd(),
      env,
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, spec.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      const output = [stdoutText, stderrText].filter(Boolean).join('\n').trim();
      const cleanedOutput = sanitizeManagedAgentAuthOutput(
        agentType,
        stripAnsiEscapeSequences(output),
      );

      resolve({
        agentType,
        action,
        command: [spec.command, ...spec.args].join(' '),
        output: cleanedOutput || '(출력 없음)',
        details: parseAgentAuthOutput(agentType, action, cleanedOutput, code),
        exitCode: code,
        signal: signal || null,
        timedOut,
      });
    });
  });
}

async function runAgentAuthTest(projectRoot, payload) {
  const input = payload?.definition || {};
  const agentType = String(input.agent || payload?.agentType || '').trim();
  assert(
    ['codex', 'claude-code', 'gemini-cli', 'local-llm'].includes(agentType),
    `Auth actions are not supported for agent type "${agentType}".`,
  );

  const name = String(input.name || 'wizard-agent').trim() || 'wizard-agent';
  const service = {
    name,
    ...buildAgentDefinition(projectRoot, name, {
      ...input,
      name,
      agent: agentType,
    }),
  };
  const prompt = 'Return exactly OK.';
  const output = await runAgentTurn({
    projectRoot,
    agent: service,
    prompt,
    rawPrompt: prompt,
    workdir: String(payload?.workdir || '.').trim() || '.',
    captureRuntimeMetadata: true,
  });
  const usage = output?.usage || null;
  await recordRuntimeUsageEvent(projectRoot, {
    agentType,
    agentName: service.name,
    channelName: null,
    role: null,
    source: 'ai-test',
    model: service.model || null,
    runtimeBackend: output?.runtimeMeta?.runtimeBackend || null,
    usage,
  });
  const usageSummaries = await summarizeRuntimeUsage(projectRoot, { agentType });
  const usageSummary = buildAiUsageSummary(agentType, usageSummaries[agentType] || null);

  return {
    agentType,
    action: 'test',
    command: 'agent test call',
    output: output?.text || '(출력 없음)',
    details: {
      summary: '테스트 호출 완료',
      success: true,
      usage,
      usageSummary,
    },
    exitCode: 0,
    signal: null,
    timedOut: false,
  };
}

function buildAiUsageSummary(agentType, summary) {
  const usageSupported = ['claude-code', 'gemini-cli', 'local-llm'].includes(agentType);
  return {
    supported: usageSupported,
    recordedEvents: summary?.recordedEvents || 0,
    inputTokens: summary?.inputTokens || 0,
    outputTokens: summary?.outputTokens || 0,
    totalTokens: summary?.totalTokens || 0,
    cacheCreationInputTokens: summary?.cacheCreationInputTokens || 0,
    cacheReadInputTokens: summary?.cacheReadInputTokens || 0,
    lastRecordedAt: summary?.lastRecordedAt || null,
  };
}

function resolveAgentAuthCommand(agentType, action, payload = {}) {
  if (agentType === 'codex') {
    if (action === 'login') {
      return { command: 'codex', args: ['login', '--device-auth'], timeoutMs: 2_500 };
    }
    if (action === 'logout') {
      return { command: 'codex', args: ['logout'], timeoutMs: 10_000 };
    }
    if (action === 'status') {
      return { command: 'codex', args: ['login', 'status'], timeoutMs: 10_000 };
    }
  }

  if (agentType === 'claude-code') {
    if (action === 'login') {
      const options = payload?.options || {};
      const loginMode = normalizeClaudeLoginMode(options.loginMode);
      const args = ['auth', 'login', loginMode === 'console' ? '--console' : '--claudeai'];
      const email = String(options.email || '').trim();
      if (email) {
        args.push('--email', email);
      }
      if (options.sso) {
        args.push('--sso');
      }
      return { command: 'claude', args, timeoutMs: 4_000 };
    }
    if (action === 'logout') {
      return { command: 'claude', args: ['auth', 'logout'], timeoutMs: 10_000 };
    }
    if (action === 'status') {
      return { command: 'claude', args: ['auth', 'status', '--json'], timeoutMs: 10_000 };
    }
  }

  assert(false, `Auth actions are not supported for agent type "${agentType}".`);
}

function parseAgentAuthOutput(agentType, action, output, exitCode) {
  const trimmed = String(output || '').trim();

  if (agentType === 'codex') {
    if (action === 'status') {
      const loggedIn = parseCodexLoggedInStatus(trimmed);
      return {
        summary: loggedIn ? '로그인됨' : '로그인 안 됨',
        loggedIn,
      };
    }
    if (action === 'login') {
      const url = trimmed.match(/https:\/\/\S+/u)?.[0] || '';
      const code = parseDeviceAuthCode(trimmed);
      return {
        summary: code ? '링크를 열고 코드를 입력하세요.' : '로그인을 시작했습니다.',
        url,
        code,
      };
    }
    if (action === 'logout') {
      return {
        summary: exitCode === 0 ? '로그아웃됨' : '로그아웃 완료',
      };
    }
  }

  if (agentType === 'claude-code') {
    if (action === 'status') {
      const parsed = parseJsonObject(trimmed);
      const loggedIn = Boolean(parsed?.loggedIn);
      return {
        summary: loggedIn ? '로그인됨' : '로그인 안 됨',
        loggedIn,
        authMethod: parsed?.authMethod || 'none',
        apiProvider: parsed?.apiProvider || '',
      };
    }
    if (action === 'login') {
      const url = extractFirstUrl(trimmed);
      return {
        summary: url ? '브라우저에서 로그인을 완료하세요.' : '로그인을 시작했습니다.',
        url,
      };
    }
    if (action === 'logout') {
      return {
        summary: exitCode === 0 ? '로그아웃됨' : '로그아웃 완료',
      };
    }
  }

  return {
    summary: trimmed || '완료',
  };
}

function sanitizeManagedAgentAuthOutput(agentType, output) {
  const lines = String(output || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (agentType === 'codex') {
    return lines
      .filter(
        (line) =>
          !/^WARNING:\s*failed to clean up stale arg0 temp dirs:/iu.test(line),
      )
      .join('\n')
      .trim();
  }

  return lines.join('\n').trim();
}

function parseCodexLoggedInStatus(output) {
  const text = String(output || '').trim();
  if (!text) {
    return false;
  }
  if (/not logged in/iu.test(text)) {
    return false;
  }
  return /logged in/iu.test(text);
}

function buildManagedAgentEnv(projectRoot, agentType = '') {
  void projectRoot;
  const env = { ...process.env };
  if (agentType === 'claude-code') {
    return stripClaudeAcpEnv(env);
  }
  if (agentType === 'gemini-cli') {
    return stripGeminiCliEnv(env);
  }
  return env;
}

async function resolveManagedServiceRuntimeEnv(
  projectRoot,
  {
    platform,
    agentName,
    envSource = 'process',
  },
) {
  if (envSource === 'runtime-db') {
    const snapshot = await getManagedServiceEnvSnapshot(projectRoot, { platform, agentName });
    assert(
      snapshot,
      `${localizeServicePlatformLabel(platform)} 서비스 런타임 스냅샷이 없습니다. 현재 배포 환경으로 한 번 수동 실행해 DB 스냅샷을 저장하세요.`,
    );
    return snapshot;
  }

  return await setManagedServiceEnvSnapshot(projectRoot, {
    platform,
    agentName,
    env: captureManagedServiceRuntimeEnv(process.env),
  });
}

function localizeServicePlatformLabel(platform) {
  if (platform === 'telegram') {
    return 'Telegram';
  }
  if (platform === 'kakao') {
    return 'Kakao';
  }
  return 'Discord';
}

function captureManagedServiceRuntimeEnv(sourceEnv = process.env) {
  return Object.fromEntries(
    Object.entries(sourceEnv || {})
      .filter(([key, value]) => typeof key === 'string' && key && value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function buildClaudeExternalLoginCommand(command, loginMode) {
  return `${command} auth login ${loginMode === 'console' ? '--console' : '--claudeai'}`;
}

function stripClaudeAcpEnv(env) {
  const nextEnv = { ...(env || {}) };
  for (const key of CLAUDE_ACP_DISABLED_ENV_KEYS) {
    delete nextEnv[key];
  }
  return nextEnv;
}

function stripGeminiCliEnv(env) {
  const nextEnv = { ...(env || {}) };
  for (const key of GEMINI_CLI_DISABLED_ENV_KEYS) {
    delete nextEnv[key];
  }
  return nextEnv;
}

function stripAnsiEscapeSequences(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '');
}

function normalizeClaudeLoginMode(value) {
  return String(value || '').trim().toLowerCase() === 'console' ? 'console' : 'claudeai';
}

function parseClaudeOAuthCallbackPayload(payload = {}) {
  const callbackInput = String(
    payload?.callbackUrl ||
      payload?.options?.callbackUrl ||
      payload?.authorizationCode ||
      payload?.code ||
      payload?.options?.authorizationCode ||
      '',
  ).trim();
  const parsedAuthorizationCode = parseClaudeOAuthCallbackInput(callbackInput);
  return {
    callbackUrl: parsedAuthorizationCode.callbackUrl,
    authorizationCode: parsedAuthorizationCode.authorizationCode,
    state:
      parsedAuthorizationCode.state ||
      String(payload?.state || payload?.options?.state || '').trim(),
  };
}

function resolveClaudeOAuthState(flow) {
  for (const candidate of [flow?.manualUrl, flow?.automaticUrl]) {
    const value = String(candidate || '').trim();
    if (!value) {
      continue;
    }
    try {
      const parsedUrl = new URL(value);
      const state = String(parsedUrl.searchParams.get('state') || '').trim();
      if (state) {
        return state;
      }
    } catch {
      // Ignore invalid URLs from the runtime and keep scanning.
    }
  }
  return '';
}

function parseClaudeOAuthCallbackUrl(callbackUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(callbackUrl);
  } catch {
    throw new Error('callback URL 전체를 붙여넣어야 합니다.');
  }
  return {
    callbackUrl,
    authorizationCode: String(
      parsedUrl.searchParams.get('code') ||
      parsedUrl.searchParams.get('authorization_code') ||
      '',
    ).trim(),
    state: String(parsedUrl.searchParams.get('state') || '').trim(),
  };
}

function parseClaudeOAuthCallbackInput(value) {
  const text = String(value || '').trim();
  if (!text) {
    return {
      callbackUrl: '',
      authorizationCode: '',
      state: '',
    };
  }
  if (!/^https?:\/\//iu.test(text)) {
    throw new Error('callback URL 전체를 붙여넣어야 합니다.');
  }
  return parseClaudeOAuthCallbackUrl(text);
}

function parseJsonObject(value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractFirstUrl(value) {
  return String(value || '').match(/https:\/\/\S+/u)?.[0] || '';
}

function parseDeviceAuthCode(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const withoutUrls = text.replace(/https:\/\/\S+/gu, ' ');
  const lineGrouped =
    withoutUrls.match(/^[ \t]*([A-Z0-9]{3,}(?:-[A-Z0-9]{2,})+)[ \t]*$/mu)?.[1] || '';
  if (lineGrouped) {
    return lineGrouped;
  }

  const grouped =
    withoutUrls.match(/\b([A-Z0-9]{3,}(?:-[A-Z0-9]{2,})+)\b/u)?.[1] || '';
  if (grouped) {
    return grouped;
  }

  const linePlain =
    withoutUrls.match(/^[ \t]*([A-Z0-9]{8,12})[ \t]*$/mu)?.[1] || '';
  if (linePlain) {
    return linePlain;
  }

  const labeled =
    withoutUrls.match(
      /\b(?:enter|device code|verification code|one-time code)(?:\s+(?:the\s+)?)?(?:is\s+)?[:#-][ \t]*([A-Z0-9]+(?:-[A-Z0-9]+)*)/iu,
    )?.[1] || '';
  if (labeled) {
    return labeled;
  }

  return withoutUrls.match(/\b([A-Z0-9]{8,12})\b/u)?.[1] || '';
}

function decodeWatcherLogPath(pathname) {
  const prefix = '/api/watchers/';
  assert(pathname.endsWith('/log'), 'Invalid watcher log path.');
  return decodeURIComponent(pathname.slice(prefix.length, -'/log'.length));
}

function decodeEntityPath(pathname, prefix) {
  assert(pathname.startsWith(prefix), 'Invalid entity path.');
  return decodeURIComponent(pathname.slice(prefix.length));
}

async function createAdminAuthController(projectRoot, { password, passwordFile }) {
  const bootstrap = await bootstrapAdminAuth(projectRoot, {
    password,
    passwordFile,
  });

  return {
    enabled: bootstrap.enabled,
    storage: bootstrap.storage,
    async getStatus(request) {
      const status = await getAdminAuthStatus(projectRoot);
      return {
        enabled: status.enabled,
        authenticated: status.enabled ? await isAuthenticated(request) : true,
        passwordEnv: ADMIN_PASSWORD_ENV,
        storage: status.storage,
      };
    },
    async assertAuthenticated(request) {
      const status = await getAdminAuthStatus(projectRoot);
      if (!status.enabled) {
        return;
      }
      if (!(await isAuthenticated(request))) {
        throwHttpError(401, 'Authentication required.');
      }
    },
    async login(response, providedPassword) {
      const status = await getAdminAuthStatus(projectRoot);
      if (!status.enabled) {
        return await this.getStatus(null);
      }
      assert(
        typeof providedPassword === 'string' && providedPassword.length > 0,
        'Password is required.',
      );
      if (!(await verifyAdminPassword(projectRoot, providedPassword))) {
        throwHttpError(401, 'Invalid password.');
      }
      const session = await createAdminSession(projectRoot, {
        ttlMs: ADMIN_SESSION_TTL_MS,
      });
      setSessionCookie(response, session.token);
      return await this.getStatus({
        headers: {
          cookie: `${ADMIN_SESSION_COOKIE}=${session.token}`,
        },
      });
    },
    async changePassword(request, response, payload) {
      const status = await getAdminAuthStatus(projectRoot);
      const currentInput = normalizePassword(payload?.currentPassword);
      const nextPassword = normalizePassword(payload?.newPassword);

      assert(nextPassword, 'New password is required.');
      assert(nextPassword.length >= 8, 'New password must be at least 8 characters.');

      if (status.enabled) {
        assert(currentInput, 'Current password is required.');
        if (!(await verifyAdminPassword(projectRoot, currentInput))) {
          throwHttpError(401, 'Current password is invalid.');
        }
      }

      await setAdminPassword(projectRoot, nextPassword);
      const session = await createAdminSession(projectRoot, {
        ttlMs: ADMIN_SESSION_TTL_MS,
      });
      setSessionCookie(response, session.token);

      return {
        ok: true,
        auth: await this.getStatus({
          headers: {
            cookie: `${ADMIN_SESSION_COOKIE}=${session.token}`,
          },
        }),
      };
    },
    async logout(request, response) {
      const status = await getAdminAuthStatus(projectRoot);
      if (status.enabled) {
        const token = readSessionToken(request);
        if (token) {
          await deleteAdminSession(projectRoot, token);
        }
      }
      clearSessionCookie(response);
      return {
        enabled: status.enabled,
        authenticated: false,
        passwordEnv: ADMIN_PASSWORD_ENV,
        storage: status.storage,
      };
    },
  };

  async function isAuthenticated(request) {
    const token = readSessionToken(request);
    if (!token) {
      return false;
    }
    const status = await getAdminAuthStatus(projectRoot);
    if (!status.enabled) {
      return true;
    }
    return await isAdminSessionValid(projectRoot, token);
  }
}

function normalizePassword(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readSessionToken(request) {
  const cookies = parseCookieHeader(request?.headers?.cookie);
  return cookies[ADMIN_SESSION_COOKIE] || '';
}

function parseCookieHeader(rawCookie) {
  const output = {};
  const parts = String(rawCookie || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of parts) {
    const equalsIndex = entry.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    const key = entry.slice(0, equalsIndex).trim();
    const value = entry.slice(equalsIndex + 1).trim();
    output[key] = value;
  }
  return output;
}

function setSessionCookie(response, token) {
  response.setHeader(
    'set-cookie',
    `${ADMIN_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`,
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    'set-cookie',
    `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
}

function throwHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function writeJson(response, statusCode, value) {
  writeText(response, statusCode, JSON.stringify(value), 'application/json; charset=utf-8');
}

function writeText(response, statusCode, value, contentType) {
  response.statusCode = statusCode;
  response.setHeader('content-type', contentType);
  response.setHeader('cache-control', 'no-store');
  response.end(value);
}

async function waitForShutdown(server) {
  await new Promise((resolve, reject) => {
    let settled = false;

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const shutdown = () => {
      server.close((error) => {
        if (error) {
          finish(() => reject(error));
          return;
        }
        finish(resolve);
      });
    };

    const cleanup = () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      server.off('close', onClose);
      server.off('error', onError);
    };

    const onClose = () => {
      finish(resolve);
    };

    const onError = (error) => {
      finish(() => reject(error));
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    server.on('close', onClose);
    server.on('error', onError);
  });
}
