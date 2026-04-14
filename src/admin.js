import fs from 'node:fs';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildAdminSnapshot,
  deleteAgentByName,
  deleteBotByName,
  deleteChannelByName,
  deleteDashboardByName,
  readWatcherLog,
  replaceLocalLlmConnections,
  replaceSharedEnv,
  resetChannelRuntimeSessionsByName,
  upsertAgent,
  upsertBot,
  upsertChannel,
  upsertDashboard,
} from './admin-state.js';
import {
  bootstrapAdminAuth,
  createAdminSession,
  deleteAdminSession,
  getAdminAuthStatus,
  isAdminSessionValid,
  recordRuntimeUsageEvent,
  setAdminPassword,
  summarizeRuntimeUsage,
  verifyAdminPassword,
} from './runtime-db.js';
import {
  inspectAgentRuntime,
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
  enqueueDiscordServiceCommand,
  readDiscordAgentServiceStatus,
  readDiscordServiceStatus,
  writeDiscordAgentServiceStatus,
  writeDiscordServiceStatus,
} from './discord-runtime-state.js';
import { listAgentModels } from './model-catalog.js';
import { buildAgentDefinition, listLocalLlmConnections, loadConfig } from './store.js';
import { assert, parseInteger, toErrorMessage } from './utils.js';

const ADMIN_HTML = fs.readFileSync(new URL('./admin-ui/index.html', import.meta.url), 'utf8');
const ADMIN_CSS = fs.readFileSync(new URL('./admin-ui/styles.css', import.meta.url), 'utf8');
const ADMIN_JS = fs.readFileSync(new URL('./admin-ui/app.js', import.meta.url), 'utf8');
const ADMIN_FAVICON = fs.readFileSync(new URL('./admin-ui/favicon.svg', import.meta.url), 'utf8');
const CLI_ENTRY_PATH = fileURLToPath(new URL('../bin/hkclaw-lite.js', import.meta.url));
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const ADMIN_PASSWORD_ENV = 'HKCLAW_LITE_ADMIN_PASSWORD';
const ADMIN_SESSION_COOKIE = 'hkclaw_lite_admin_session';
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AI_STATUS_AGENT_TYPES = ['codex', 'claude-code', 'gemini-cli', 'local-llm'];
const moduleRequire = createRequire(import.meta.url);
const claudeAuthFlows = new Map();
const geminiAuthFlows = new Map();
const CLAUDE_ACP_DISABLED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_VERSION',
];
const GEMINI_CLI_DISABLED_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_BASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GOOGLE_GENAI_USE_GCA',
];
const GEMINI_GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GEMINI_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GEMINI_GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GEMINI_GOOGLE_MANUAL_REDIRECT_URI = 'https://codeassist.google.com/authcode';
const DISCORD_SERVICE_START_TIMEOUT_MS = 8_000;
const DISCORD_SERVICE_STOP_TIMEOUT_MS = 8_000;
const DISCORD_SERVICE_ENTRY_ENV = 'HKCLAW_LITE_DISCORD_SERVICE_ENTRY';

export async function startAdminServer(
  projectRoot,
  {
    host = '127.0.0.1',
    port = DEFAULT_ADMIN_PORT,
    password = process.env[ADMIN_PASSWORD_ENV],
    passwordFile = null,
  } = {},
) {
  const normalizedPort =
    typeof port === 'number' ? port : parseInteger(port, 'port');
  const auth = await createAdminAuthController(projectRoot, {
    password,
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
    password = process.env[ADMIN_PASSWORD_ENV],
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

  if (isStaticRequest && pathname === '/') {
    writeText(response, 200, ADMIN_HTML, 'text/html; charset=utf-8');
    return;
  }

  if (isStaticRequest && pathname === '/app.css') {
    writeText(response, 200, ADMIN_CSS, 'text/css; charset=utf-8');
    return;
  }

  if (isStaticRequest && pathname === '/app.js') {
    writeText(response, 200, ADMIN_JS, 'text/javascript; charset=utf-8');
    return;
  }

  if (isStaticRequest && (pathname === '/favicon.svg' || pathname === '/favicon.ico')) {
    writeText(response, 200, ADMIN_FAVICON, 'image/svg+xml; charset=utf-8');
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
      state: await deleteAgentByName(projectRoot, name),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/bots') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      state: await upsertBot(
        projectRoot,
        payload.currentName || null,
        payload.definition || payload,
      ),
    });
    return;
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/bots/')) {
    const name = decodeEntityPath(pathname, '/api/bots/');
    writeJson(response, 200, {
      ok: true,
      state: await deleteBotByName(projectRoot, name),
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

  if (
    request.method === 'POST' &&
    pathname.startsWith('/api/agents/') &&
    pathname.endsWith('/start')
  ) {
    const name = decodeEntityPath(pathname.slice(0, -'/start'.length), '/api/agents/');
    writeJson(response, 200, {
      ok: true,
      result: await startDiscordServiceProcess(projectRoot, name),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    pathname.startsWith('/api/agents/') &&
    pathname.endsWith('/restart')
  ) {
    const name = decodeEntityPath(pathname.slice(0, -'/restart'.length), '/api/agents/');
    writeJson(response, 200, {
      ok: true,
      result: await restartDiscordServiceProcess(projectRoot, name),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    pathname.startsWith('/api/agents/') &&
    pathname.endsWith('/stop')
  ) {
    const name = decodeEntityPath(pathname.slice(0, -'/stop'.length), '/api/agents/');
    writeJson(response, 200, {
      ok: true,
      result: await stopDiscordServiceProcess(projectRoot, name),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    pathname.startsWith('/api/agents/') &&
    pathname.endsWith('/reconnect')
  ) {
    const name = decodeEntityPath(pathname.slice(0, -'/reconnect'.length), '/api/agents/');
    writeJson(response, 200, {
      ok: true,
      result: await queueDiscordServiceAction(projectRoot, {
        action: 'reconnect-bot',
        agentName: name,
      }),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    pathname.startsWith('/api/bots/') &&
    pathname.endsWith('/reconnect')
  ) {
    const name = decodeEntityPath(pathname.slice(0, -'/reconnect'.length), '/api/bots/');
    const config = loadConfig(projectRoot);
    const bot = config.bots?.[name];
    writeJson(response, 200, {
      ok: true,
      result: await queueDiscordServiceAction(projectRoot, {
        action: 'reconnect-bot',
        agentName: bot?.agent || name,
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
    writeJson(response, 200, {
      ok: true,
      state: await resetChannelRuntimeSessionsByName(projectRoot, name),
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

  if (request.method === 'PUT' && pathname === '/api/shared-env') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      state: await replaceSharedEnv(projectRoot, payload.sharedEnv || payload),
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
    const config = loadConfig(projectRoot);
    writeJson(response, 200, {
      ok: true,
      result: await listAgentModels(
        {
          ...process.env,
          ...(config.sharedEnv || {}),
        },
        payload,
      ),
    });
    return;
  }

  writeJson(response, 404, { error: 'Not found.' });
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
    agentName: command.botName,
    requestedAt: command.requestedAt,
  };
}

async function startDiscordServiceProcess(projectRoot, agentName) {
  const config = loadConfig(projectRoot);
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);
  assert(
    String(config.agents[agentName]?.discordToken || '').trim(),
    `Agent "${agentName}" does not configure a Discord token.`,
  );

  const current = buildDiscordAgentServiceSnapshot(projectRoot, agentName);
  assert(!current.pidAlive, 'Discord 서비스가 이미 실행 중입니다.');
  if (current.stale || current.state === 'stopped') {
    normalizeDiscordServiceStoppedState(projectRoot, agentName);
  }

  const args = buildDiscordServiceStartArgs(projectRoot, {
    envFilePath: current.envFilePath,
    agentName,
  });

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const service = await waitForDiscordServiceSnapshot(
    projectRoot,
    agentName,
    (snapshot) => snapshot.running || Boolean(snapshot.lastError),
    DISCORD_SERVICE_START_TIMEOUT_MS,
  );
  assert(service.running, service.lastError || 'Discord 서비스 시작을 확인하지 못했습니다.');

  return {
    action: 'start',
    agentName,
    running: true,
    pid: service.pid,
    startedAt: service.startedAt,
  };
}

async function restartDiscordServiceProcess(projectRoot, agentName) {
  const previous = await stopDiscordServiceProcess(projectRoot, agentName, {
    allowStopped: true,
  });
  const next = await startDiscordServiceProcess(projectRoot, agentName);
  return {
    action: 'restart',
    agentName,
    previous,
    current: next,
  };
}

async function stopDiscordServiceProcess(projectRoot, agentName, { allowStopped = false } = {}) {
  const config = loadConfig(projectRoot);
  assert(config.agents?.[agentName], `Agent "${agentName}" does not exist.`);
  const service = buildDiscordAgentServiceSnapshot(projectRoot, agentName);
  if (!service.pidAlive) {
    if (service.stale || service.state === 'stopped') {
      const normalized = normalizeDiscordServiceStoppedState(projectRoot, agentName);
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
  const normalized = stopped.running
    ? normalizeDiscordServiceStoppedState(projectRoot, agentName)
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

function normalizeDiscordServiceStoppedState(projectRoot, agentName = null) {
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

function buildDiscordServiceStartArgs(projectRoot, { envFilePath = null, agentName = null } = {}) {
  const customEntry = String(process.env[DISCORD_SERVICE_ENTRY_ENV] || '').trim();
  if (customEntry) {
    return agentName ? [customEntry, projectRoot, agentName] : [customEntry, projectRoot];
  }

  const args = [CLI_ENTRY_PATH, '--root', projectRoot, 'discord', 'serve'];
  if (envFilePath) {
    args.push('--env-file', envFilePath);
  }
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

async function runAgentAuthAction(projectRoot, payload) {
  const agentType = String(payload?.agentType || '').trim();
  const action = String(payload?.action || 'status').trim();
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
    return resolveClaudeAuthCli(env);
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

function resolveClaudeAuthCli(env = process.env) {
  const packageJsonOverride = String(env.HKCLAW_LITE_CLAUDE_AGENT_SDK_PACKAGE_JSON || '').trim();
  let packageJsonPath = packageJsonOverride;
  if (!packageJsonPath) {
    try {
      packageJsonPath = moduleRequire.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    } catch {
      try {
        const entryPath = moduleRequire.resolve('@anthropic-ai/claude-agent-sdk');
        const candidate = path.join(path.dirname(entryPath), 'package.json');
        if (!fs.existsSync(candidate)) {
          return null;
        }
        packageJsonPath = candidate;
      } catch {
        return null;
      }
    }
  }

  const cliPath = path.resolve(path.dirname(packageJsonPath), 'cli.js');
  if (!fs.existsSync(cliPath)) {
    return null;
  }

  return {
    source: 'bundled',
    command: process.execPath,
    argsPrefix: [cliPath],
    detail: `@anthropic-ai/claude-agent-sdk (${cliPath})`,
    envPatch: {},
  };
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
          '브라우저 인증 뒤 표시된 Authentication Code 또는 callback URL 전체를 붙여넣고 로그인 완료를 누르세요.',
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
  assert(flow, 'Claude Code ACP 로그인 세션이 없습니다. 먼저 로그인 버튼을 누르세요.');
  const callback = parseClaudeOAuthCallbackPayload(payload);
  const resolvedState = callback.state || resolveClaudeOAuthState(flow);
  assert(
    callback.authorizationCode,
    '브라우저 완료 후 Authentication Code 또는 callback URL 전체를 붙여넣으세요.',
  );
  assert(
    resolvedState,
    'Claude Code ACP 로그인 상태를 찾지 못했습니다. 다시 로그인 버튼을 누르세요.',
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
        'Claude Code ACP 로그인 완료',
        account?.email ? `email: ${account.email}` : '',
        account?.organization ? `organization: ${account.organization}` : '',
      ].filter(Boolean).join('\n'),
      details: {
        summary: 'Claude Code ACP 로그인 완료',
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
    return {
      ...authResult,
      output: [
        authResult.output,
        '인증 저장소: 이 머신의 로컬 Codex 로그인 상태를 그대로 사용합니다.',
      ].filter(Boolean).join('\n'),
      details: {
        ...(authResult.details || {}),
        sharedLogin: true,
        authScope: 'local-user',
      },
    };
  }

  const config = loadConfig(projectRoot);
  const sharedEnv = config.sharedEnv || {};

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
      activeFlow
        ? `브라우저 로그인: 진행 중 (${activeFlow.loginMode === 'console' ? 'console' : 'claude.ai'})`
        : '',
      activeFlow
        ? '완료 방법: 브라우저 로그인 후 표시된 Authentication Code 또는 callback URL 전체를 붙여넣고 로그인 완료를 누르세요.'
        : '',
    ].filter(Boolean);

    return {
      ...authResult,
      output: outputLines.join('\n'),
      details: {
        ...authResult.details,
        summary: ready
          ? 'Claude Code ACP 로그인됨'
          : activeFlow
            ? 'Claude Code ACP 브라우저 로그인 진행 중'
            : 'Claude Code ACP 로그인이 필요합니다.',
        runtimeReady: runtime.ready,
        ready,
        pendingLogin: Boolean(activeFlow),
        requiresCode: Boolean(activeFlow),
        completionHint: activeFlow
          ? '브라우저 인증 뒤 표시된 Authentication Code 또는 callback URL 전체를 붙여넣고 로그인 완료를 누르세요.'
          : '',
        loginMode: activeFlow?.loginMode || null,
        manualUrl: activeFlow?.manualUrl || '',
        automaticUrl: activeFlow?.automaticUrl || '',
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
  const config = loadConfig(projectRoot);
  const output = await runAgentTurn({
    projectRoot,
    agent: service,
    prompt,
    rawPrompt: prompt,
    workdir: String(payload?.workdir || '.').trim() || '.',
    sharedEnv: config.sharedEnv || {},
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
  const config = loadConfig(projectRoot);
  const env = {
    ...process.env,
    ...(config.sharedEnv || {}),
  };
  if (agentType === 'claude-code') {
    return stripClaudeAcpEnv(env);
  }
  if (agentType === 'gemini-cli') {
    return stripGeminiCliEnv(env);
  }
  return env;
}

function buildCredentialStatusResult({
  agentType,
  runtime,
  credential,
  configuredSummary,
  missingSummary,
  note = '',
}) {
  const runtimeReady = Boolean(runtime?.ready);
  const configured = Boolean(credential.key);
  const ready = runtimeReady && configured;
  const lines = [
    runtimeReady ? `런타임: 준비됨` : `런타임: ${runtime?.detail || '미설치'}`,
    configured
      ? `자격정보: ${credential.key} (${localizeCredentialSource(credential.source)})`
      : `자격정보: ${missingSummary}`,
  ];
  if (note) {
    lines.push(note);
  }

  return {
    agentType,
    action: 'status',
    command: 'config inspection',
    output: lines.join('\n'),
    details: {
      summary: ready ? configuredSummary : (runtimeReady ? missingSummary : '런타임 준비 필요'),
      configured,
      runtimeReady,
      ready,
      credentialKey: credential.key || null,
      credentialSource: credential.key ? localizeCredentialSource(credential.source) : null,
    },
    exitCode: 0,
    signal: null,
    timedOut: false,
  };
}

function resolveCredentialSource(sharedEnv, processEnv, keys) {
  for (const key of keys) {
    const sharedValue = typeof sharedEnv?.[key] === 'string' ? sharedEnv[key] : '';
    if (sharedValue) {
      return {
        key,
        value: sharedValue,
        source: 'shared',
      };
    }
    const processValue = typeof processEnv?.[key] === 'string' ? processEnv[key] : '';
    if (processValue) {
      return {
        key,
        value: processValue,
        source: 'process',
      };
    }
  }

  return {
    key: '',
    value: '',
    source: '',
  };
}

function localizeCredentialSource(source) {
  if (source === 'shared') {
    return '공유 환경';
  }
  if (source === 'process') {
    return '프로세스 환경';
  }
  return source || '미설정';
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
  const callbackUrl =
    String(payload?.callbackUrl || payload?.options?.callbackUrl || '').trim();
  if (callbackUrl) {
    return parseClaudeOAuthCallbackUrl(callbackUrl);
  }

  const authorizationCode = String(
    payload?.authorizationCode || payload?.code || payload?.options?.authorizationCode || '',
  ).trim();
  const parsedAuthorizationCode = parseClaudeOAuthCodeOrCallbackInput(authorizationCode);
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
    throw new Error('Authentication Code 또는 callback URL 전체를 붙여넣어야 합니다.');
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

function parseClaudeOAuthCodeOrCallbackInput(value) {
  const text = String(value || '').trim();
  if (!text) {
    return {
      callbackUrl: '',
      authorizationCode: '',
      state: '',
    };
  }
  if (/^https?:\/\//iu.test(text)) {
    return parseClaudeOAuthCallbackUrl(text);
  }
  return {
    callbackUrl: '',
    authorizationCode: text,
    state: '',
  };
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
