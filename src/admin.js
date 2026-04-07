import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
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
import { assert, parseInteger, toErrorMessage } from './utils.js';

const ADMIN_HTML = fs.readFileSync(new URL('./admin-ui/index.html', import.meta.url), 'utf8');
const ADMIN_CSS = fs.readFileSync(new URL('./admin-ui/styles.css', import.meta.url), 'utf8');
const ADMIN_JS = fs.readFileSync(new URL('./admin-ui/app.js', import.meta.url), 'utf8');
const CLI_ENTRY_PATH = fileURLToPath(new URL('../bin/hkclaw-lite.js', import.meta.url));
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const ADMIN_PASSWORD_ENV = 'HKCLAW_LITE_ADMIN_PASSWORD';
const ADMIN_SESSION_COOKIE = 'hkclaw_lite_admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function startAdminServer(
  projectRoot,
  {
    host = '127.0.0.1',
    port = 3580,
    password = process.env[ADMIN_PASSWORD_ENV],
    passwordFile = null,
  } = {},
) {
  const normalizedPort =
    typeof port === 'number' ? port : parseInteger(port, 'port');
  const auth = createAdminAuthController({
    password,
    passwordFile,
  });

  const server = http.createServer((request, response) => {
    void handleAdminRequest(projectRoot, auth, request, response).catch((error) => {
      const statusCode =
        error?.statusCode || (error?.name === 'UsageError' ? 400 : 500);
      writeJson(response, statusCode, {
        error: toErrorMessage(error),
        auth: auth.getStatus(request),
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
    port = 3580,
    password = process.env[ADMIN_PASSWORD_ENV],
    passwordFile = null,
  } = {},
) {
  const { server, url, authEnabled, passwordEnv } = await startAdminServer(projectRoot, {
    host,
    port,
    password,
    passwordFile,
  });
  console.log(`Web admin available at ${url}`);
  console.log(`Project root: ${projectRoot}`);
  if (authEnabled) {
    console.log(`Lightweight login enabled via ${passwordEnv}.`);
  } else {
    console.log(`Login disabled. Set ${passwordEnv} to require a password.`);
  }
  console.log('Press Ctrl+C to stop.');
  await waitForShutdown(server);
}

async function handleAdminRequest(projectRoot, auth, request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/') {
    writeText(response, 200, ADMIN_HTML, 'text/html; charset=utf-8');
    return;
  }

  if (request.method === 'GET' && pathname === '/app.css') {
    writeText(response, 200, ADMIN_CSS, 'text/css; charset=utf-8');
    return;
  }

  if (request.method === 'GET' && pathname === '/app.js') {
    writeText(response, 200, ADMIN_JS, 'text/javascript; charset=utf-8');
    return;
  }

  if (!pathname.startsWith('/api/')) {
    writeJson(response, 404, { error: 'Not found.' });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/auth/status') {
    writeJson(response, 200, auth.getStatus(request));
    return;
  }

  if (request.method === 'POST' && pathname === '/api/login') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, auth.login(response, payload.password));
    return;
  }

  if (request.method === 'POST' && pathname === '/api/logout') {
    writeJson(response, 200, auth.logout(request, response));
    return;
  }

  if (request.method === 'PUT' && pathname === '/api/admin-password') {
    const payload = await readJsonBody(request);
    auth.assertAuthenticated(request);
    writeJson(response, 200, auth.changePassword(request, response, payload));
    return;
  }

  auth.assertAuthenticated(request);

  if (request.method === 'GET' && pathname === '/api/state') {
    writeJson(response, 200, buildAdminSnapshot(projectRoot));
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
      state: upsertAgent(projectRoot, payload.currentName || null, payload.definition || payload),
    });
    return;
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/agents/')) {
    const name = decodeEntityPath(pathname, '/api/agents/');
    writeJson(response, 200, {
      ok: true,
      state: deleteAgentByName(projectRoot, name),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/channels') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      state: upsertChannel(projectRoot, payload.currentName || null, payload.definition || payload),
    });
    return;
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/channels/')) {
    const name = decodeEntityPath(pathname, '/api/channels/');
    writeJson(response, 200, {
      ok: true,
      state: deleteChannelByName(projectRoot, name),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/dashboards') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      state: upsertDashboard(
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
      state: deleteDashboardByName(projectRoot, name),
    });
    return;
  }

  if (request.method === 'PUT' && pathname === '/api/shared-env') {
    const payload = await readJsonBody(request);
    writeJson(response, 200, {
      ok: true,
      state: replaceSharedEnv(projectRoot, payload.sharedEnv || payload),
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
      result: await runAgentAuthAction(payload),
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

async function runAgentAuthAction(payload) {
  const agentType = String(payload?.agentType || '').trim();
  const action = String(payload?.action || 'status').trim();
  const spec = resolveAgentAuthCommand(agentType, action);

  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
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

      resolve({
        agentType,
        action,
        command: [spec.command, ...spec.args].join(' '),
        output: output || '(no output)',
        details: parseAgentAuthOutput(agentType, action, output, code),
        exitCode: code,
        signal: signal || null,
        timedOut,
      });
    });
  });
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
        args: ['auth', 'login', '--console'],
        timeoutMs: 2_500,
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
        summary: /logged in/iu.test(trimmed) ? 'Logged in' : 'Not logged in',
        loggedIn: /logged in/iu.test(trimmed),
      };
    }
    if (action === 'login') {
      const url = trimmed.match(/https:\/\/\S+/u)?.[0] || '';
      const code =
        trimmed.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/u)?.[1] || '';
      return {
        summary: code ? 'Open the link and enter the code.' : 'Login started.',
        url,
        code,
      };
    }
    if (action === 'logout') {
      return {
        summary: exitCode === 0 ? 'Logged out' : 'Logout finished',
      };
    }
  }

  if (agentType === 'claude-code') {
    if (action === 'status') {
      try {
        const payload = JSON.parse(trimmed);
        return {
          summary: payload.loggedIn ? 'Logged in' : 'Not logged in',
          loggedIn: Boolean(payload.loggedIn),
          authMethod: payload.authMethod || 'unknown',
        };
      } catch {
        return {
          summary: trimmed || 'Status checked',
        };
      }
    }
    if (action === 'login') {
      const url = trimmed.match(/https:\/\/\S+/u)?.[0] || '';
      return {
        summary: url ? 'Open the login link in your browser.' : 'Login started.',
        url,
      };
    }
    if (action === 'logout') {
      return {
        summary: exitCode === 0 ? 'Logged out' : 'Logout finished',
      };
    }
  }

  return {
    summary: trimmed || 'Done',
  };
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

function createAdminAuthController({ password, passwordFile }) {
  const state = {
    password: normalizePassword(password),
    passwordFile,
  };
  if (!state.password && state.passwordFile && fs.existsSync(state.passwordFile)) {
    state.password = normalizePassword(fs.readFileSync(state.passwordFile, 'utf8'));
  }
  const sessions = new Map();

  return {
    enabled: Boolean(readCurrentPassword()),
    getStatus(request) {
      const currentPassword = readCurrentPassword();
      return {
        enabled: Boolean(currentPassword),
        authenticated: currentPassword ? isAuthenticated(request) : true,
        passwordEnv: ADMIN_PASSWORD_ENV,
      };
    },
    assertAuthenticated(request) {
      if (!readCurrentPassword()) {
        return;
      }
      if (!isAuthenticated(request)) {
        throwHttpError(401, 'Authentication required.');
      }
    },
    login(response, providedPassword) {
      const currentPassword = readCurrentPassword();
      if (!currentPassword) {
        return this.getStatus(null);
      }
      assert(
        typeof providedPassword === 'string' && providedPassword.length > 0,
        'Password is required.',
      );
      if (!passwordsMatch(currentPassword, providedPassword)) {
        throwHttpError(401, 'Invalid password.');
      }
      const token = crypto.randomBytes(24).toString('base64url');
      sessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
      setSessionCookie(response, token);
      return this.getStatus({
        headers: {
          cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
        },
      });
    },
    changePassword(request, response, payload) {
      const currentPassword = readCurrentPassword();
      const currentInput = normalizePassword(payload?.currentPassword);
      const nextPassword = normalizePassword(payload?.newPassword);

      assert(nextPassword, 'New password is required.');
      assert(nextPassword.length >= 8, 'New password must be at least 8 characters.');

      if (currentPassword) {
        assert(currentInput, 'Current password is required.');
        if (!passwordsMatch(currentPassword, currentInput)) {
          throwHttpError(401, 'Current password is invalid.');
        }
      }

      persistPassword(nextPassword);
      sessions.clear();
      const token = crypto.randomBytes(24).toString('base64url');
      sessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
      setSessionCookie(response, token);

      return {
        ok: true,
        auth: this.getStatus({
          headers: {
            cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
          },
        }),
      };
    },
    logout(request, response) {
      if (readCurrentPassword()) {
        const token = readSessionToken(request);
        if (token) {
          sessions.delete(token);
        }
      }
      clearSessionCookie(response);
      return {
        enabled: Boolean(readCurrentPassword()),
        authenticated: false,
        passwordEnv: ADMIN_PASSWORD_ENV,
      };
    },
  };

  function isAuthenticated(request) {
    expireSessions();
    if (!readCurrentPassword()) {
      return true;
    }
    const token = readSessionToken(request);
    if (!token) {
      return false;
    }
    const expiresAt = sessions.get(token);
    if (!expiresAt || expiresAt <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function expireSessions() {
    const now = Date.now();
    for (const [token, expiresAt] of sessions.entries()) {
      if (expiresAt <= now) {
        sessions.delete(token);
      }
    }
  }

  function readCurrentPassword() {
    if (state.passwordFile && fs.existsSync(state.passwordFile)) {
      state.password = normalizePassword(fs.readFileSync(state.passwordFile, 'utf8'));
    }
    return state.password;
  }

  function persistPassword(nextPassword) {
    state.password = normalizePassword(nextPassword);
    if (!state.passwordFile) {
      return;
    }
    fs.mkdirSync(path.dirname(state.passwordFile), {
      recursive: true,
    });
    fs.writeFileSync(state.passwordFile, `${state.password}\n`, {
      mode: 0o600,
    });
    fs.chmodSync(state.passwordFile, 0o600);
  }
}

function normalizePassword(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function passwordsMatch(expected, actual) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
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
