import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildAdminSnapshot,
  deleteAgentByName,
  deleteChannelByName,
  deleteDashboardByName,
  readWatcherLog,
  replaceSharedEnv,
  upsertAgent,
  upsertChannel,
  upsertDashboard,
} from './admin-state.js';
import {
  bootstrapAdminAuth,
  createAdminSession,
  deleteAdminSession,
  getAdminAuthStatus,
  isAdminSessionValid,
  setAdminPassword,
  verifyAdminPassword,
} from './runtime-db.js';
import { resolveManagedAgentCli, runAgentTurn } from './runners.js';
import {
  DEFAULT_ADMIN_PORT,
} from './constants.js';
import { listAgentModels } from './model-catalog.js';
import { buildAgentDefinition, loadConfig } from './store.js';
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
const AUTH_STATUS_AGENT_TYPES = ['codex', 'claude-code'];

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
      statuses: await readAiAuthStatuses(projectRoot),
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

async function runAgentAuthAction(projectRoot, payload) {
  const agentType = String(payload?.agentType || '').trim();
  const action = String(payload?.action || 'status').trim();
  if (action === 'test') {
    return runAgentAuthTest(projectRoot, payload);
  }
  const spec = resolveAgentAuthCommand(agentType, action);

  return new Promise((resolve, reject) => {
    const child = spawnResolvedCommand(spec.command, spec.args, {
      agentType,
      cwd: process.cwd(),
      env: process.env,
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
  const managedCli = options?.agentType
    ? resolveManagedAgentCli(options.agentType, options.env)
    : null;
  if (managedCli) {
    return spawn(managedCli.command, [...managedCli.argsPrefix, ...args], {
      ...options,
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

async function readAiAuthStatuses(projectRoot) {
  const entries = await Promise.all(
    AUTH_STATUS_AGENT_TYPES.map(async (agentType) => {
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
          },
        ];
      }
    }),
  );

  return Object.fromEntries(entries);
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
    sharedEnv: {},
  });

  return {
    agentType,
    action: 'test',
    command: 'agent test call',
    output: output || '(출력 없음)',
    details: {
      summary: '테스트 호출 완료',
      success: true,
    },
    exitCode: 0,
    signal: null,
    timedOut: false,
  };
}

function resolveAgentAuthCommand(agentType, action) {
  if (agentType === 'codex') {
    if (action === 'status') {
      return { command: 'codex', args: ['login', 'status'], timeoutMs: 10_000 };
    }
    if (action === 'login') {
      return { command: 'codex', args: ['login', '--device-auth'], timeoutMs: 2_500 };
    }
    if (action === 'logout') {
      return { command: 'codex', args: ['logout'], timeoutMs: 10_000 };
    }
  }

  if (agentType === 'claude-code') {
    if (action === 'status') {
      return { command: 'claude', args: ['auth', 'status'], timeoutMs: 10_000 };
    }
    if (action === 'login') {
      return {
        command: 'claude',
        args: ['auth', 'login'],
        timeoutMs: 4_000,
      };
    }
    if (action === 'logout') {
      return { command: 'claude', args: ['auth', 'logout'], timeoutMs: 10_000 };
    }
  }

  throw new Error(`Auth actions are not supported for agent type "${agentType}".`);
}

function parseAgentAuthOutput(agentType, action, output, exitCode) {
  const trimmed = String(output || '').trim();

  if (agentType === 'codex') {
    if (action === 'status') {
      return {
        summary: /logged in/iu.test(trimmed) ? '로그인됨' : '로그인 안 됨',
        loggedIn: /logged in/iu.test(trimmed),
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
      try {
        const payload = JSON.parse(trimmed);
        return {
          summary: payload.loggedIn ? '로그인됨' : '로그인 안 됨',
          loggedIn: Boolean(payload.loggedIn),
          authMethod: payload.authMethod || 'unknown',
        };
      } catch {
        return {
          summary: trimmed || '상태 확인 완료',
        };
      }
    }
    if (action === 'login') {
      const url = trimmed.match(/https:\/\/\S+/u)?.[0] || '';
      return {
        summary: url ? '브라우저에서 로그인 링크를 여세요.' : '로그인을 시작했습니다.',
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

function stripAnsiEscapeSequences(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '');
}

function parseDeviceAuthCode(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const withoutUrls = text.replace(/https:\/\/\S+/gu, ' ');
  const labeled =
    withoutUrls.match(
      /\b(?:enter|code|device code|verification code)(?:\s+(?:the\s+)?)?(?:is\s+)?[:#-]?\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)/iu,
    )?.[1] || '';
  if (labeled) {
    return labeled;
  }

  const grouped =
    withoutUrls.match(/\b([A-Z0-9]{3,}(?:-[A-Z0-9]{2,})+)\b/u)?.[1] || '';
  if (grouped) {
    return grouped;
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
