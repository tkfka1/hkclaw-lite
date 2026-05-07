import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startAdminServer } from '../src/admin.js';
import { executeChannelTurn } from '../src/channel-runtime.js';
import { getCiWatcherLogPath, saveCiWatcher } from '../src/ci-watch-store.js';
import {
  buildDiscordServiceSnapshot,
  enqueueDiscordServiceCommand,
  getDiscordAgentStatusPath,
  listDiscordServiceCommands,
  readDiscordAgentServiceStatus,
  writeDiscordAgentServiceStatus,
  writeDiscordServiceStatus,
} from '../src/discord-runtime-state.js';
import {
  buildTelegramServiceSnapshot,
  enqueueTelegramServiceCommand,
  getTelegramAgentStatusPath,
  listTelegramServiceCommands,
  readTelegramAgentServiceStatus,
  writeTelegramAgentServiceStatus,
} from '../src/telegram-runtime-state.js';
import {
  buildKakaoServiceSnapshot,
  listKakaoServiceCommands,
  readKakaoAgentServiceStatus,
  readKakaoServiceStatus,
  writeKakaoServiceStatus,
} from '../src/kakao-runtime-state.js';
import { parseKakaoSseChunk } from '../src/kakao-service.js';
import {
  recordRuntimeRoleSession,
  recordRuntimeUsageEvent,
  setManagedServiceEnvSnapshot,
} from '../src/runtime-db.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  buildConnectorDefinition,
  buildDashboardDefinition,
  createDefaultConfig,
  getChannel,
  initProject,
  loadConfig,
  saveConfig,
} from '../src/store.js';

const repoRoot = process.cwd();
const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'echo-assistant.mjs');
const fakeDiscordServicePath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'fake-discord-service.mjs',
);
const fakeSlowDiscordServicePath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'fake-slow-discord-service.mjs',
);
const fakeTelegramServicePath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'fake-telegram-service.mjs',
);
const fakeKakaoServicePath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'fake-kakao-service.mjs',
);
const previousChannelAutostart = process.env.HKCLAW_LITE_CHANNEL_AUTOSTART;
process.env.HKCLAW_LITE_CHANNEL_AUTOSTART = '0';

test.after(() => {
  if (previousChannelAutostart === undefined) {
    delete process.env.HKCLAW_LITE_CHANNEL_AUTOSTART;
  } else {
    process.env.HKCLAW_LITE_CHANNEL_AUTOSTART = previousChannelAutostart;
  }
});

function createProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-admin-test-'));
}

function createFakeManagedCliBundle({ packageName, binaryName, script }) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-admin-cli-'));
  const packageDir = path.join(rootDir, ...packageName.split('/'));
  const scriptPath = path.join(packageDir, 'bin', `${binaryName}.js`);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version: '0.0.0-test',
      bin: {
        [binaryName]: `./bin/${binaryName}.js`,
      },
    }),
  );
  fs.writeFileSync(
    scriptPath,
    script,
    { mode: 0o755 },
  );
  return path.join(packageDir, 'package.json');
}

function createFakeCodexBundle() {
  return createFakeManagedCliBundle({
    packageName: '@openai/codex',
    binaryName: 'codex',
    script: `#!/usr/bin/env node
const fs = require('node:fs');

const args = process.argv.slice(2);

if (args[0] === 'login' && args[1] === 'status') {
  const statusFile = process.env.HKCLAW_LITE_TEST_CODEX_STATUS_FILE;
  if (statusFile) {
    process.stdout.write((fs.existsSync(statusFile) ? 'Logged in using ChatGPT' : 'Not logged in') + '\\n');
  } else if (process.env.HKCLAW_LITE_TEST_CODEX_STATUS_OUTPUT) {
    process.stdout.write(process.env.HKCLAW_LITE_TEST_CODEX_STATUS_OUTPUT + '\\n');
  } else {
    process.stdout.write('logged in\\n');
  }
  if (process.env.HKCLAW_LITE_TEST_CODEX_STATUS_WARNING) {
    process.stderr.write(process.env.HKCLAW_LITE_TEST_CODEX_STATUS_WARNING + '\\n');
  }
  process.exit(0);
}

if (args[0] === 'login' && args[1] === '--device-auth') {
  process.stdout.write('Welcome to Codex [v0.125.0]\\n');
  process.stdout.write('Follow these steps to sign in with ChatGPT using device code authorization:\\n\\n');
  process.stdout.write('1. Open this link in your browser and sign in to your account\\n');
  process.stdout.write('   https://example.test/codex/device\\u001b[0m\\n\\n');
  process.stdout.write('2. Enter this one-time code (expires in 15 minutes)\\n');
  process.stdout.write('   CODE-12345\\n');
  const statusFile = process.env.HKCLAW_LITE_TEST_CODEX_STATUS_FILE;
  const delayMs = Number(process.env.HKCLAW_LITE_TEST_CODEX_LOGIN_DELAY_MS || '0');
  if (statusFile && Number.isFinite(delayMs) && delayMs > 0) {
    setTimeout(() => {
      fs.writeFileSync(statusFile, 'logged-in\\n');
      process.exit(0);
    }, delayMs);
    return;
  }
  process.exit(0);
}

if (args[0] === 'logout') {
  process.stdout.write('logged out\\n');
  process.exit(0);
}

if (args[0] === 'exec') {
  let outputFile = '';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-o') {
      outputFile = args[index + 1] || '';
      index += 1;
    }
  }

  process.stdin.resume();
  process.stdin.on('end', () => {
    if (outputFile) {
      fs.writeFileSync(outputFile, 'OK\\n');
    }
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify({
        type: 'thread.started',
        thread_id: 'codex-thread-test',
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'OK',
        },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 12,
          cached_input_tokens: 5,
          output_tokens: 3,
        },
      }) + '\\n');
    } else {
      process.stdout.write('OK\\n');
    }
  });
  process.stdin.on('error', () => process.exit(1));
  return;
}

process.stderr.write(\`unexpected args: \${args.join(' ')}\\n\`);
process.exit(1);
`,
  });
}

function createFakeClaudeAgentSdkBundle() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-admin-claude-sdk-'));
  const packageDir = path.join(rootDir, '@anthropic-ai', 'claude-agent-sdk');
  const modulePath = path.join(packageDir, 'sdk.mjs');
  const cliPath = path.join(packageDir, 'cli.js');
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk',
      version: '0.0.0-test',
      type: 'module',
      exports: {
        '.': {
          default: './sdk.mjs',
        },
      },
    }),
  );
  fs.writeFileSync(
    modulePath,
    `export function query({ prompt, options = {} }) {
  let closed = false;
  let completionResolve = null;
  let lastAccount = {
    email: 'dev@example.test',
    organization: 'Console Org',
  };
  const completionPromise = new Promise((resolve) => {
    completionResolve = resolve;
  });

  return {
    async initializationResult() {
      return { ok: true };
    },
    async claudeAuthenticate(loginWithClaudeAi) {
      return {
        manualUrl: loginWithClaudeAi
          ? 'https://claude.example.test/oauth/manual?state=claudeai-flow'
          : 'https://console.example.test/oauth/manual?state=console-flow',
        automaticUrl: loginWithClaudeAi
          ? 'http://localhost:4455/callback?mode=claudeai&state=claudeai-flow'
          : 'http://localhost:4455/callback?mode=console&state=console-flow',
      };
    },
    async claudeOAuthCallback(code, state) {
      lastAccount = {
        email: 'dev@example.test',
        organization: state === 'console-flow' ? 'Console Org' : 'Claude Org',
        code,
        state,
      };
      completionResolve?.({
        account: lastAccount,
      });
    },
    async claudeOAuthWaitForCompletion() {
      return await completionPromise;
    },
    async accountInfo() {
      return lastAccount;
    },
    close() {
      if (!closed) {
        closed = true;
        completionResolve?.({ closed: true });
      }
    },
    async *[Symbol.asyncIterator]() {
      if (typeof prompt !== 'string') {
        return;
      }
      yield {
        type: 'result',
        subtype: 'success',
        result: prompt === 'Return exactly OK.'
          ? \`OK:\${options.permissionMode || 'default'}\`
          : \`SDK:\${prompt}\`,
      };
    },
  };
}
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'status' && args[2] === '--json') {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    authMethod: 'claudeai',
    apiProvider: 'firstParty',
  }));
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'login') {
  process.stdout.write('Opening browser to sign in...\\nhttps://claude.example.test/oauth/start\\n');
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'logout') {
  process.stdout.write('Logged out\\n');
  process.exit(0);
}

if (args.includes('-p') && args.includes('--output-format') && args.includes('stream-json')) {
  if (!args.includes('--verbose')) {
    process.stderr.write('missing --verbose\\n');
    process.exit(1);
  }
  const sessionIdIndex = args.indexOf('--session-id');
  const resumeIndex = args.indexOf('--resume');
  const permissionIndex = args.indexOf('--permission-mode');
  const sessionId =
    (sessionIdIndex >= 0 ? args[sessionIdIndex + 1] : null) ||
    (resumeIndex >= 0 ? args[resumeIndex + 1] : null) ||
    '22222222-2222-2222-2222-222222222222';
  const permissionMode = permissionIndex >= 0 ? args[permissionIndex + 1] : 'default';

  process.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-sonnet-test',
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'message_delta',
    session_id: sessionId,
    usage: {
      input_tokens: 13,
      output_tokens: 9,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 1,
    },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: process.env.HKCLAW_LITE_FAKE_CLAUDE_RESULT || \`OK:\${permissionMode}\`,
  }) + '\\n');
  process.exit(0);
}

process.stderr.write(\`unexpected args: \${args.join(' ')}\\n\`);
process.exit(1);
`,
    { mode: 0o755 },
  );
  return path.join(packageDir, 'package.json');
}

function resolveFakeClaudeCliPath(packageJsonPath) {
  return path.join(path.dirname(packageJsonPath), 'cli.js');
}

function createFakeGeminiBundle() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-admin-gemini-cli-'));
  const packageDir = path.join(rootDir, '@google', 'gemini-cli');
  const bundleDir = path.join(packageDir, 'bundle');
  const packageJsonPath = path.join(packageDir, 'package.json');
  const scriptPath = path.join(bundleDir, 'gemini.js');
  const supportChunkPath = path.join(bundleDir, 'chunk-2P3YD5SP.js');
  const coreChunkPath = path.join(bundleDir, 'chunk-JS5WSGB2.js');
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-gemini-home-'));

  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify({
      name: '@google/gemini-cli',
      version: '0.0.0-test',
      type: 'module',
      bin: {
        gemini: './bundle/gemini.js',
      },
    }),
  );
  fs.writeFileSync(
    coreChunkPath,
    `import path from 'node:path';
import os from 'node:os';

function resolveHomeDir() {
  return process.env.HKCLAW_LITE_TEST_GEMINI_HOME || os.homedir();
}

export const Storage = {
  getOAuthCredsPath() {
    return path.join(resolveHomeDir(), '.gemini', 'oauth_creds.json');
  },
};
`,
  );
  fs.writeFileSync(
    supportChunkPath,
    `import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Storage } from './chunk-JS5WSGB2.js';

var OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
var OAUTH_CLIENT_SECRET = "test-client-secret";
var OAUTH_SCOPE = ["openid", "email", "profile"];
const redirectUri = "https://codeassist.google.com/authcode";

function resolveHomeDir() {
  return process.env.HKCLAW_LITE_TEST_GEMINI_HOME || os.homedir();
}

function getGoogleAccountsPath() {
  return path.join(resolveHomeDir(), '.gemini', 'google_accounts.json');
}

export function getOauthClient() {
  return {
    clientId: OAUTH_CLIENT_ID,
    clientSecret: OAUTH_CLIENT_SECRET,
    redirectUri,
    scopes: OAUTH_SCOPE,
  };
}

export function generatePKCEParams() {
  return {
    codeVerifier: 'test-code-verifier',
    codeChallenge: 'test-code-challenge',
    state: 'test-state',
  };
}

export function buildAuthorizationUrl(config, pkceParams) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    state: pkceParams.state,
    code_challenge: pkceParams.codeChallenge,
    code_challenge_method: 'S256',
    scope: config.scopes.join(' '),
  });
  return \`\${process.env.HKCLAW_LITE_GEMINI_OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth'}?\${params.toString()}\`;
}

export async function exchangeCodeForToken(config, code, codeVerifier) {
  const response = await fetch(process.env.HKCLAW_LITE_GEMINI_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
  });
  return await response.json();
}

export class UserAccountManager {
  getGoogleAccountsCachePath() {
    return getGoogleAccountsPath();
  }

  getCachedGoogleAccount() {
    try {
      const parsed = JSON.parse(fs.readFileSync(getGoogleAccountsPath(), 'utf8'));
      return typeof parsed.email === 'string' ? parsed.email : '';
    } catch {
      return '';
    }
  }

  async cacheGoogleAccount(email) {
    const cachePath = getGoogleAccountsPath();
    await fsPromises.mkdir(path.dirname(cachePath), { recursive: true });
    await fsPromises.writeFile(cachePath, JSON.stringify({ email }, null, 2), 'utf8');
  }
}

export async function clearCachedCredentialFile() {
  await fsPromises.rm(Storage.getOAuthCredsPath(), { force: true }).catch(() => {});
}

export function clearOauthClientCache() {}
`,
  );
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { getOauthClient, UserAccountManager, clearCachedCredentialFile, clearOauthClientCache } from "./chunk-2P3YD5SP.js";
import { Storage } from "./chunk-JS5WSGB2.js";

void getOauthClient;
void UserAccountManager;
void clearCachedCredentialFile;
void clearOauthClientCache;
void Storage;

const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const prompt = promptIndex >= 0 ? (args[promptIndex + 1] || '') : '';

if (prompt) {
  if (process.env.GOOGLE_GENAI_USE_GCA !== 'true') {
    process.stderr.write(JSON.stringify({
      error: {
        message: 'GOOGLE_GENAI_USE_GCA must be true',
      },
    }));
    process.exit(41);
  }
  process.stdout.write(JSON.stringify({
    text: 'OK',
    _meta: {
      quota: {
        token_count: {
          input_tokens: 6,
          output_tokens: 4,
        },
      },
    },
  }));
  process.exit(0);
}

process.stderr.write(\`unexpected args: \${args.join(' ')}\\n\`);
process.exit(1);
`,
    { mode: 0o755 },
  );

  return {
    packageJsonPath,
    homeDir,
  };
}

function createFakeNpmForBundledCliUpdate() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-admin-fake-npm-'));
  const scriptPath = path.join(rootDir, 'fake-npm.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const prefixIndex = args.indexOf('--prefix');
const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : '';
if (!prefix) {
  process.stderr.write('missing --prefix\\n');
  process.exit(2);
}

for (const spec of args.filter((arg) => arg.startsWith('@openai/codex@') || arg.startsWith('@google/gemini-cli@') || arg.startsWith('@anthropic-ai/claude-agent-sdk@'))) {
  const separator = spec.lastIndexOf('@');
  const packageName = spec.slice(0, separator);
  const version = spec.slice(separator + 1) === 'latest' ? '9.9.9-admin-test' : spec.slice(separator + 1);
  const binaryName = packageName.includes('gemini') ? 'gemini' : packageName.includes('claude') ? 'claude' : 'codex';
  const packageDir = path.join(prefix, 'node_modules', ...packageName.split('/'));
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: packageName,
    version,
    type: 'module',
    bin: {
      [binaryName]: './bin/cli.js',
    },
    exports: {
      '.': './index.mjs',
    },
  }));
  fs.writeFileSync(path.join(packageDir, 'bin', 'cli.js'), '#!/usr/bin/env node\\n');
  fs.writeFileSync(path.join(packageDir, 'index.mjs'), 'export function query() {}\\n');
}

process.stdout.write('admin fake npm complete\\n');
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

async function withEnv(entries, callback) {
  const keys = Object.keys(entries);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(entries)) {
    process.env[key] = value;
  }

  try {
    await callback();
  } finally {
    for (const key of keys) {
      const original = previous.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

async function withJsonServer(handler, callback) {
  const server = await new Promise((resolve, reject) => {
    const started = http.createServer(handler);
    started.once('error', reject);
    started.listen(0, '127.0.0.1', () => {
      started.off('error', reject);
      resolve(started);
    });
  });

  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function withAdminServer(projectRoot, callback, options = {}) {
  const started = await startAdminServer(projectRoot, {
    host: '127.0.0.1',
    port: 0,
    ...(options || {}),
  });

  try {
    await callback(started);
  } finally {
    await started.close();
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      ...(options.body
        ? {
            'content-type': 'application/json',
          }
        : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return {
    response,
    payload,
  };
}

async function openSse(url, token) {
  const controller = new AbortController();
  const events = [];
  const waiters = [];
  const closeWaiters = [];
  const stream = fetch(url, {
    headers: {
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
    },
    signal: controller.signal,
  }).then(async (response) => {
    if (response.status !== 200) {
      assert.equal(response.status, 200, await response.text().catch(() => ''));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseKakaoSseChunk(buffer);
      if (parsed.consumed > 0) {
        buffer = buffer.slice(parsed.consumed);
      }
      for (const event of parsed.events) {
        events.push(event);
      }
      for (const waiter of [...waiters]) {
        const event = events.find((entry) => entry.event === waiter.eventName);
        if (event) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    }
  }).finally(() => {
    for (const waiter of closeWaiters.splice(0)) {
      waiter.resolve();
    }
  });

  return {
    waitForEvent(eventName, { timeoutMs = 3_000 } = {}) {
      const existing = events.find((event) => event.event === eventName);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const waiter = { eventName, resolve, reject };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for SSE event ${eventName}`));
          }
        }, timeoutMs);
      });
    },
    waitForClose({ timeoutMs = 3_000 } = {}) {
      return Promise.race([
        stream.then(() => undefined),
        new Promise((resolve, reject) => {
          const waiter = { resolve, reject };
          closeWaiters.push(waiter);
          setTimeout(() => {
            const index = closeWaiters.indexOf(waiter);
            if (index !== -1) {
              closeWaiters.splice(index, 1);
              reject(new Error('Timed out waiting for SSE stream to close'));
            }
          }, timeoutMs);
        }),
      ]);
    },
    async close() {
      controller.abort();
      await stream.catch((error) => {
        if (error?.name !== 'AbortError') {
          throw error;
        }
      });
    },
  };
}

async function waitFor(predicate, { timeoutMs = 8_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) {
      return result;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  return await predicate();
}

test('admin server exposes project snapshot and watcher logs', async () => {
  const projectRoot = createProject();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    discordToken: 'owner-token',
  });
  config.channels.main = buildChannelDefinition(
    projectRoot,
    config,
    'main',
    {
      name: 'main',
      discordChannelId: '123456789012345678',
      workspace: 'workspace',
      agent: 'worker',
    },
  );
  config.dashboards.ops = buildDashboardDefinition(
    projectRoot,
    'ops',
    {
      name: 'ops',
      monitors: ['worker'],
      refreshMs: 7000,
      showDetails: true,
    },
    config,
  );
  saveConfig(projectRoot, config);
  const loadedConfig = loadConfig(projectRoot);
  await executeChannelTurn({
    projectRoot,
    config: loadedConfig,
    channel: getChannel(loadedConfig, 'main'),
    prompt: 'admin snapshot runtime',
    workdir: workspacePath,
  });
  writeDiscordServiceStatus(projectRoot, {
    version: 1,
    projectRoot,
    pid: process.pid,
    running: true,
    startedAt: '2026-04-07T00:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
    agents: {
      worker: {
        agent: 'command',
        tokenConfigured: true,
        connected: true,
        tag: 'owner#0001',
        userId: '1',
      },
    },
  });

  saveCiWatcher(projectRoot, {
    id: 'ci-demo',
    provider: 'github',
    label: 'owner/repo#1',
    request: {
      repo: 'owner/repo',
      runId: '1',
    },
    status: 'completed',
    updatedAt: '2026-04-06T00:00:00.000Z',
    resultSummary: 'completed',
    completionMessage: 'completed',
    logPath: getCiWatcherLogPath(projectRoot, 'ci-demo'),
  });
  fs.writeFileSync(getCiWatcherLogPath(projectRoot, 'ci-demo'), 'watcher log\n');

  await withAdminServer(projectRoot, async ({ url }) => {
    const htmlResponse = await fetch(url);
    const html = await htmlResponse.text();
    assert.equal(htmlResponse.status, 200);
    assert.equal(htmlResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(htmlResponse.headers.get('x-frame-options'), 'DENY');
    assert.equal(htmlResponse.headers.get('referrer-policy'), 'no-referrer');
    assert.match(htmlResponse.headers.get('permissions-policy') || '', /camera=\(\)/u);
    assert.equal(
      htmlResponse.headers.get('content-security-policy'),
      "default-src 'none'; base-uri 'self'; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'self'; object-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com",
    );
    assert.match(html, /hkclaw-lite/i);
    assert.match(html, /\/favicon\.ico/u);
    assert.match(html, /\/favicon\.svg/u);
    assert.match(html, /\/favicon-32x32\.png/u);
    assert.match(html, /\/apple-touch-icon\.png/u);
    assert.match(html, /\/site\.webmanifest/u);

    const appJsResponse = await fetch(`${url}/app.js`);
    const appJs = await appJsResponse.text();
    assert.equal(appJsResponse.status, 200);
    assert.match(appJsResponse.headers.get('content-type') || '', /text\/javascript/u);
    assert.match(appJs, /ui-shell\.js/u);

    const appCssResponse = await fetch(`${url}/app.css`);
    const appCss = await appCssResponse.text();
    assert.equal(appCssResponse.status, 200);
    assert.match(appCssResponse.headers.get('content-type') || '', /text\/css/u);
    assert.match(appCss, /styles\.css/u);

    const shellJsResponse = await fetch(`${url}/ui-shell.js`);
    const shellJs = await shellJsResponse.text();
    assert.equal(shellJsResponse.status, 200);
    assert.match(shellJsResponse.headers.get('content-type') || '', /text\/javascript/u);
    assert.match(shellJs, /renderFrame/u);

    const viewsJsResponse = await fetch(`${url}/ui-views.js`);
    const viewsJs = await viewsJsResponse.text();
    assert.equal(viewsJsResponse.status, 200);
    assert.match(viewsJsResponse.headers.get('content-type') || '', /text\/javascript/u);
    assert.match(viewsJs, /renderHomeView/u);

    const faviconResponse = await fetch(`${url}/favicon.ico`);
    const favicon = Buffer.from(await faviconResponse.arrayBuffer());
    assert.equal(faviconResponse.status, 200);
    assert.match(faviconResponse.headers.get('content-type') || '', /image\/x-icon/u);
    assert.equal(favicon.subarray(0, 4).toString('hex'), '00000100');

    const svgFaviconResponse = await fetch(`${url}/favicon.svg`);
    const svgFavicon = await svgFaviconResponse.text();
    assert.equal(svgFaviconResponse.status, 200);
    assert.match(svgFaviconResponse.headers.get('content-type') || '', /image\/svg\+xml/u);
    assert.match(svgFavicon, /<svg/u);

    const pngFaviconResponse = await fetch(`${url}/favicon-32x32.png`);
    const pngFavicon = Buffer.from(await pngFaviconResponse.arrayBuffer());
    assert.equal(pngFaviconResponse.status, 200);
    assert.match(pngFaviconResponse.headers.get('content-type') || '', /image\/png/u);
    assert.equal(pngFavicon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

    const appleTouchIconResponse = await fetch(`${url}/apple-touch-icon.png`);
    const appleTouchIcon = Buffer.from(await appleTouchIconResponse.arrayBuffer());
    assert.equal(appleTouchIconResponse.status, 200);
    assert.match(appleTouchIconResponse.headers.get('content-type') || '', /image\/png/u);
    assert.equal(appleTouchIcon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

    const manifestResponse = await fetch(`${url}/site.webmanifest`);
    const manifest = await manifestResponse.json();
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get('content-type') || '', /application\/manifest\+json/u);
    assert.equal(manifest.short_name, 'hkclaw');
    assert.deepEqual(
      manifest.icons.map((entry) => entry.src),
      ['/favicon.svg', '/favicon-32x32.png', '/apple-touch-icon.png'],
    );

    const faviconHeadResponse = await fetch(`${url}/favicon.ico`, {
      method: 'HEAD',
    });
    assert.equal(faviconHeadResponse.status, 200);
    assert.match(faviconHeadResponse.headers.get('content-type') || '', /image\/x-icon/u);

    const healthResponse = await fetch(`${url}/healthz`);
    const healthPayload = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.status, 'healthy');

    const { response, payload } = await requestJson(`${url}/api/state`);
    assert.equal(response.status, 200);
    assert.equal(payload.projectRoot, projectRoot);
    assert.equal(payload.agents.length, 1);
    assert.equal(payload.channels.length, 1);
    assert.equal(payload.dashboards.length, 1);
    assert.equal(payload.watchers.length, 1);
    assert.equal(payload.agents[0].runtime.ready, true);
    assert.equal(payload.channels[0].mode, 'single');
    assert.equal(payload.channels[0].runtime.lastRun.status, 'completed');
    assert.equal(payload.channels[0].runtime.pendingOutboxCount, 1);
    assert.deepEqual(payload.agents[0].mappedChannelNames, ['main']);
    assert.equal(payload.agents[0].discordTokenConfigured, true);
    assert.equal(payload.discord.service.state, 'running');
    assert.equal(payload.discord.agents.worker.configured, true);
    assert.equal(payload.discord.agents.worker.required, true);
    assert.equal(payload.discord.agents.worker.agent, 'command');
    assert.equal(payload.discord.service.agents.worker.tag, 'owner#0001');
    assert.equal(payload.runtime.pendingOutboxCount, 1);
    assert.equal(payload.runtime.recentRuns.length, 1);
    assert.equal(payload.runtime.recentRuns[0].channelName, 'main');

    const watcherLogResponse = await fetch(
      `${url}/api/watchers/${encodeURIComponent('ci-demo')}/log`,
    );
    const watcherLog = await watcherLogResponse.text();
    assert.equal(watcherLogResponse.status, 200);
    assert.equal(watcherLog, 'watcher log\n');
  });
});

test('admin server exposes runtime history for agent and channel logs', async () => {
  const projectRoot = createProject();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    command: `node ${fixturePath}`,
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    discordChannelId: '123456789012345678',
    workspace: 'workspace',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const loadedConfig = loadConfig(projectRoot);
  await executeChannelTurn({
    projectRoot,
    config: loadedConfig,
    channel: getChannel(loadedConfig, 'main'),
    prompt: 'history check',
    workdir: workspacePath,
  });

  await withAdminServer(projectRoot, async ({ url }) => {
    const channelLog = await requestJson(
      `${url}/api/runtime-history?targetType=channel&name=${encodeURIComponent('main')}`,
    );
    assert.equal(channelLog.response.status, 200, JSON.stringify(channelLog.payload));
    assert.equal(channelLog.payload.target.type, 'channel');
    assert.equal(channelLog.payload.target.name, 'main');
    assert.equal(channelLog.payload.history.length, 1);
    assert.equal(channelLog.payload.history[0].channelName, 'main');
    assert.equal(channelLog.payload.history[0].prompt, 'history check');
    assert.equal(channelLog.payload.history[0].messages.length, 1);
    assert.equal(channelLog.payload.history[0].messages[0].agentName, 'owner');
    assert.match(channelLog.payload.history[0].messages[0].content, /response=HISTORY CHECK/u);
    assert.ok(
      channelLog.payload.history[0].events.some((entry) => entry.status === 'completed'),
    );

    const agentLog = await requestJson(
      `${url}/api/runtime-history?targetType=agent&name=${encodeURIComponent('owner')}`,
    );
    assert.equal(agentLog.response.status, 200, JSON.stringify(agentLog.payload));
    assert.equal(agentLog.payload.target.type, 'agent');
    assert.equal(agentLog.payload.target.name, 'owner');
    assert.equal(agentLog.payload.history.length, 1);
    assert.equal(agentLog.payload.history[0].runId, channelLog.payload.history[0].runId);
  });
});

test('admin server redirects Telegram getUpdates helper through the selected agent token', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const config = loadConfig(projectRoot);
  config.agents.telegram = buildAgentDefinition(projectRoot, 'telegram', {
    name: 'telegram',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'telegram',
    telegramBotToken: '123456:telegram-token',
  });
  saveConfig(projectRoot, config);

  await withAdminServer(projectRoot, async ({ url }) => {
    const response = await fetch(`${url}/api/telegram-get-updates?agent=telegram`, {
      redirect: 'manual',
    });
    const location = response.headers.get('location') || '';

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(location, 'https://api.telegram.org/bot123456:telegram-token/getUpdates');
  });
});

test('telegram service snapshot exposes recently discovered chats', () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  writeTelegramAgentServiceStatus(projectRoot, 'telegram-worker', {
    version: 1,
    projectRoot,
    agentName: 'telegram-worker',
    pid: process.pid,
    running: true,
    desiredRunning: true,
    startedAt: '2026-04-30T00:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
    agents: {
      'telegram-worker': {
        agent: 'command',
        tokenConfigured: true,
        connected: true,
        username: 'hkclaw_bot',
        userId: '100',
      },
    },
    recentChats: [
      {
        agentName: 'telegram-worker',
        chatId: '-1001234567890',
        threadId: '77',
        type: 'supergroup',
        title: 'Ops Room',
        lastSeenAt: '2026-04-30T00:01:00.000Z',
      },
    ],
  });

  const snapshot = buildTelegramServiceSnapshot(projectRoot);
  assert.equal(snapshot.recentChats[0].agentName, 'telegram-worker');
  assert.equal(snapshot.recentChats[0].chatId, '-1001234567890');
  assert.equal(snapshot.recentChats[0].threadId, '77');
  assert.equal(snapshot.agentServices['telegram-worker'].recentChats[0].title, 'Ops Room');
});

test('admin server saves config changes and can run a mapped channel', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  await withAdminServer(projectRoot, async ({ url }) => {
    const agentResponse = await requestJson(`${url}/api/agents`, {
      method: 'POST',
      body: {
        definition: {
          name: 'worker',
          agent: 'command',
          command: `node ${fixturePath}`,
        },
      },
    });
    assert.equal(agentResponse.response.status, 200, JSON.stringify(agentResponse.payload));

    const connectorResponse = await requestJson(`${url}/api/connectors`, {
      method: 'POST',
      body: {
        definition: {
          name: 'kakao-main',
          type: 'kakao',
          kakaoRelayUrl: 'https://relay.example/',
        },
      },
    });
    assert.equal(connectorResponse.response.status, 200, JSON.stringify(connectorResponse.payload));
    assert.equal(connectorResponse.payload.state.connectors[0].name, 'kakao-main');

    const channelResponse = await requestJson(`${url}/api/channels`, {
      method: 'POST',
      body: {
        definition: {
          name: 'discord-main',
          discordChannelId: '123456789012345678',
          workspace: 'workspace',
          agent: 'worker',
        },
      },
    });
    assert.equal(
      channelResponse.response.status,
      200,
      JSON.stringify(channelResponse.payload),
    );
    assert.equal(channelResponse.payload.state.channels[0].mode, 'single');

    const kakaoChannelResponse = await requestJson(`${url}/api/channels`, {
      method: 'POST',
      body: {
        definition: {
          name: 'kakao-main',
          platform: 'kakao',
          connector: 'kakao-main',
          kakaoChannelId: '*',
          workspace: 'workspace',
          agent: 'worker',
        },
      },
    });
    assert.equal(
      kakaoChannelResponse.response.status,
      200,
      JSON.stringify(kakaoChannelResponse.payload),
    );

    const duplicateKakaoChannel = await requestJson(`${url}/api/channels`, {
      method: 'POST',
      body: {
        definition: {
          name: 'kakao-duplicate',
          platform: 'kakao',
          connector: 'kakao-main',
          kakaoChannelId: '*',
          workspace: 'workspace',
          agent: 'worker',
        },
      },
    });
    assert.equal(duplicateKakaoChannel.response.status, 400);
    assert.match(duplicateKakaoChannel.payload.error, /overlaps with "kakao-main"/u);

    const blockedConnectorDelete = await requestJson(
      `${url}/api/connectors/${encodeURIComponent('kakao-main')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(blockedConnectorDelete.response.status, 400);
    assert.match(blockedConnectorDelete.payload.error, /referenced by channels/u);

    const dashboardResponse = await requestJson(`${url}/api/dashboards`, {
      method: 'POST',
      body: {
        definition: {
          name: 'ops',
          monitors: ['worker'],
          refreshMs: 9000,
          showDetails: true,
        },
      },
    });
    assert.equal(
      dashboardResponse.response.status,
      200,
      JSON.stringify(dashboardResponse.payload),
    );

    const blockedDelete = await requestJson(
      `${url}/api/agents/${encodeURIComponent('worker')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(blockedDelete.response.status, 400);
    assert.match(blockedDelete.payload.error, /referenced by/u);

    const runResponse = await requestJson(`${url}/api/run`, {
      method: 'POST',
      body: {
        channelName: 'discord-main',
        prompt: 'hello admin',
      },
    });
    assert.equal(runResponse.response.status, 200, JSON.stringify(runResponse.payload));
    assert.match(runResponse.payload.result.output, /response=HELLO ADMIN/u);

    const scheduleResponse = await requestJson(`${url}/api/schedules`, {
      method: 'POST',
      body: {
        definition: {
          name: 'admin-heartbeat',
          channelName: 'discord-main',
          scheduleType: 'interval',
          intervalMs: 60_000,
          prompt: 'scheduled admin',
          nextRunAt: '2099-01-01T00:00:00.000Z',
        },
      },
    });
    assert.equal(scheduleResponse.response.status, 200, JSON.stringify(scheduleResponse.payload));
    assert.equal(scheduleResponse.payload.state.schedules[0].name, 'admin-heartbeat');

    const scheduleList = await requestJson(`${url}/api/schedules`);
    assert.equal(scheduleList.response.status, 200, JSON.stringify(scheduleList.payload));
    assert.equal(scheduleList.payload.schedules[0].channelName, 'discord-main');

    const scheduleRun = await requestJson(
      `${url}/api/schedules/${encodeURIComponent('admin-heartbeat')}/run`,
      {
        method: 'POST',
      },
    );
    assert.equal(scheduleRun.response.status, 200, JSON.stringify(scheduleRun.payload));
    assert.equal(scheduleRun.payload.result.status, 'completed');
    assert.match(scheduleRun.payload.result.result.content, /SCHEDULED ADMIN/u);
    assert.equal(scheduleRun.payload.state.schedules[0].lastStatus, 'completed');

    const blockedScheduledChannelDelete = await requestJson(
      `${url}/api/channels/${encodeURIComponent('discord-main')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(blockedScheduledChannelDelete.response.status, 400);
    assert.match(blockedScheduledChannelDelete.payload.error, /referenced by schedules/u);

    const deleteScheduleResponse = await requestJson(
      `${url}/api/schedules/${encodeURIComponent('admin-heartbeat')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(deleteScheduleResponse.response.status, 200, JSON.stringify(deleteScheduleResponse.payload));

    const deleteChannel = await requestJson(
      `${url}/api/channels/${encodeURIComponent('discord-main')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(deleteChannel.response.status, 200, JSON.stringify(deleteChannel.payload));

    const deleteKakaoChannel = await requestJson(
      `${url}/api/channels/${encodeURIComponent('kakao-main')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(deleteKakaoChannel.response.status, 200, JSON.stringify(deleteKakaoChannel.payload));

    const deleteConnector = await requestJson(
      `${url}/api/connectors/${encodeURIComponent('kakao-main')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(deleteConnector.response.status, 200, JSON.stringify(deleteConnector.payload));

    const deleteDashboard = await requestJson(
      `${url}/api/dashboards/${encodeURIComponent('ops')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(deleteDashboard.response.status, 200, JSON.stringify(deleteDashboard.payload));

    const deleteAgent = await requestJson(
      `${url}/api/agents/${encodeURIComponent('worker')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(deleteAgent.response.status, 200, JSON.stringify(deleteAgent.payload));
  });

  const config = loadConfig(projectRoot);
  assert.equal(config.channels['discord-main'], undefined);
  assert.equal(config.connectors['kakao-main'], undefined);
  assert.equal(config.agents.worker, undefined);
  assert.equal(config.dashboards.ops, undefined);
});

test('admin server hides Kakao pairing state as a channel-managed connector', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  await withAdminServer(projectRoot, async ({ url }) => {
    const agentResponse = await requestJson(`${url}/api/agents`, {
      method: 'POST',
      body: {
        definition: {
          name: 'worker',
          agent: 'command',
          command: `node ${fixturePath}`,
        },
      },
    });
    assert.equal(agentResponse.response.status, 200, JSON.stringify(agentResponse.payload));

    const channelResponse = await requestJson(`${url}/api/channels`, {
      method: 'POST',
      body: {
        definition: {
          name: 'kakao-owned',
          platform: 'kakao',
          kakaoChannelId: 'managed',
          workspace: 'workspace',
          agent: 'worker',
        },
      },
    });
    assert.equal(channelResponse.response.status, 200, JSON.stringify(channelResponse.payload));

    let config = loadConfig(projectRoot);
    assert.equal(config.channels['kakao-owned'].connector, 'kakao-owned');
    assert.equal(config.connectors['kakao-owned'].type, 'kakao');
    assert.equal(config.connectors['kakao-owned'].description, 'Managed by channel routing');

    const renameKakaoChannel = await requestJson(`${url}/api/channels`, {
      method: 'POST',
      body: {
        currentName: 'kakao-owned',
        definition: {
          name: 'kakao-renamed',
          platform: 'kakao',
          connector: 'kakao-owned',
          kakaoChannelId: 'managed',
          workspace: 'workspace',
          agent: 'worker',
        },
      },
    });
    assert.equal(renameKakaoChannel.response.status, 200, JSON.stringify(renameKakaoChannel.payload));

    config = loadConfig(projectRoot);
    assert.equal(config.channels['kakao-renamed'].connector, 'kakao-renamed');
    assert.equal(config.connectors['kakao-owned'], undefined);
    assert.equal(config.connectors['kakao-renamed'].description, 'Managed by channel routing');

    const convertToDiscord = await requestJson(`${url}/api/channels`, {
      method: 'POST',
      body: {
        currentName: 'kakao-renamed',
        definition: {
          name: 'kakao-renamed',
          platform: 'discord',
          discordChannelId: '123456789012345678',
          workspace: 'workspace',
          agent: 'worker',
        },
      },
    });
    assert.equal(convertToDiscord.response.status, 200, JSON.stringify(convertToDiscord.payload));

    config = loadConfig(projectRoot);
    assert.equal(config.channels['kakao-renamed'].platform, 'discord');
    assert.equal(config.channels['kakao-renamed'].connector, undefined);
    assert.equal(config.connectors['kakao-renamed'], undefined);

    const convertToKakao = await requestJson(`${url}/api/channels`, {
      method: 'POST',
      body: {
        currentName: 'kakao-renamed',
        definition: {
          name: 'kakao-owned-renamed',
          platform: 'kakao',
          kakaoChannelId: 'managed',
          workspace: 'workspace',
          agent: 'worker',
        },
      },
    });
    assert.equal(convertToKakao.response.status, 200, JSON.stringify(convertToKakao.payload));

    config = loadConfig(projectRoot);
    assert.equal(config.channels['kakao-owned-renamed'].connector, 'kakao-owned-renamed');
    assert.equal(config.connectors['kakao-owned-renamed'].description, 'Managed by channel routing');

    const deleteKakaoChannel = await requestJson(
      `${url}/api/channels/${encodeURIComponent('kakao-owned-renamed')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(deleteKakaoChannel.response.status, 200, JSON.stringify(deleteKakaoChannel.payload));
  });

  const config = loadConfig(projectRoot);
  assert.equal(config.channels['kakao-owned-renamed'], undefined);
  assert.equal(config.connectors['kakao-owned-renamed'], undefined);
});

test('admin server plans and applies topology changes with redacted results', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);
  const spec = {
    version: 1,
    agents: [
      {
        name: 'auto-owner',
        agent: 'command',
        platform: 'kakao',
        command: `node ${fixturePath}`,
      },
    ],
    connectors: [
      {
        name: 'auto-kakao',
        type: 'kakao',
        secretRefs: {
          kakaoRelayTokenEnv: 'HKCLAW_TEST_ADMIN_KAKAO_TOKEN',
        },
      },
    ],
    channels: [
      {
        name: 'auto-kakao-main',
        platform: 'kakao',
        connector: 'auto-kakao',
        kakaoChannelId: '*',
        workspace: 'workspace',
        agent: 'auto-owner',
      },
    ],
  };

  const priorToken = process.env.HKCLAW_TEST_ADMIN_KAKAO_TOKEN;
  process.env.HKCLAW_TEST_ADMIN_KAKAO_TOKEN = 'admin-secret-token';
  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const plan = await requestJson(`${url}/api/topology/plan`, {
        method: 'POST',
        body: { spec },
      });
      assert.equal(plan.response.status, 200, JSON.stringify(plan.payload));
      assert.equal(plan.payload.ok, true);
      assert.equal(plan.payload.result.changedCount, 3);
      assert.match(plan.payload.summary, /Topology plan: changes=3/u);
      assert.equal(plan.payload.result.changes[1].after.kakaoRelayToken, '***');
      assert.doesNotMatch(JSON.stringify(plan.payload), /admin-secret-token/u);
      assert.equal(loadConfig(projectRoot).agents['auto-owner'], undefined);

      const apply = await requestJson(`${url}/api/topology/apply`, {
        method: 'POST',
        body: { spec },
      });
      assert.equal(apply.response.status, 200, JSON.stringify(apply.payload));
      assert.equal(apply.payload.ok, true);
      assert.equal(apply.payload.result.changedCount, 3);
      assert.doesNotMatch(JSON.stringify(apply.payload), /admin-secret-token/u);

      const config = loadConfig(projectRoot);
      assert.equal(config.agents['auto-owner'].agent, 'command');
      assert.equal(config.connectors['auto-kakao'].kakaoRelayToken, 'admin-secret-token');
      assert.equal(config.channels['auto-kakao-main'].connector, 'auto-kakao');

      const exported = await requestJson(`${url}/api/topology/export`);
      assert.equal(exported.response.status, 200, JSON.stringify(exported.payload));
      assert.equal(exported.payload.spec.connectors[0].kakaoRelayToken, '***');
      assert.doesNotMatch(JSON.stringify(exported.payload), /admin-secret-token/u);
    });
  } finally {
    if (priorToken === undefined) {
      delete process.env.HKCLAW_TEST_ADMIN_KAKAO_TOKEN;
    } else {
      process.env.HKCLAW_TEST_ADMIN_KAKAO_TOKEN = priorToken;
    }
  }
});

test('admin server removes deleted agent runtime artifacts from service snapshots', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'discord',
    discordToken: 'owner-token',
    telegramBotToken: 'telegram-token',
  });
  saveConfig(projectRoot, config);

  writeDiscordAgentServiceStatus(projectRoot, 'worker', {
    version: 1,
    projectRoot,
    agentName: 'worker',
    pid: 999999,
    running: false,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: '2026-04-15T00:00:00.000Z',
    agents: {
      worker: {
        agent: 'command',
        tokenConfigured: true,
        connected: false,
        tag: '',
        userId: '',
      },
    },
  });
  writeTelegramAgentServiceStatus(projectRoot, 'worker', {
    version: 1,
    projectRoot,
    agentName: 'worker',
    pid: 999999,
    running: false,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: '2026-04-15T00:00:00.000Z',
    agents: {
      worker: {
        agent: 'command',
        tokenConfigured: true,
        connected: false,
        username: '',
        userId: '',
      },
    },
  });
  enqueueDiscordServiceCommand(projectRoot, {
    action: 'reload-config',
    agentName: 'worker',
  });
  enqueueTelegramServiceCommand(projectRoot, {
    action: 'reload-config',
    agentName: 'worker',
  });

  await withAdminServer(projectRoot, async ({ url }) => {
    const deleteAgent = await requestJson(
      `${url}/api/agents/${encodeURIComponent('worker')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(deleteAgent.response.status, 200, JSON.stringify(deleteAgent.payload));
    assert.equal(deleteAgent.payload.state.agents.length, 0);
    assert.deepEqual(deleteAgent.payload.state.discord.service.agents, {});
    assert.deepEqual(deleteAgent.payload.state.telegram.service.agents, {});
  });

  assert.equal(fs.existsSync(getDiscordAgentStatusPath(projectRoot, 'worker')), false);
  assert.equal(fs.existsSync(getTelegramAgentStatusPath(projectRoot, 'worker')), false);
  assert.equal(listDiscordServiceCommands(projectRoot, { agentName: 'worker' }).length, 0);
  assert.equal(listTelegramServiceCommands(projectRoot, { agentName: 'worker' }).length, 0);
  assert.deepEqual(buildDiscordServiceSnapshot(projectRoot).agents, {});
  assert.deepEqual(buildTelegramServiceSnapshot(projectRoot).agents, {});
});

test('admin server queues manual Discord service commands instead of auto reloading', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    discordToken: 'owner-token',
  });
  saveConfig(projectRoot, config);

  writeDiscordAgentServiceStatus(projectRoot, 'worker', {
    version: 1,
    projectRoot,
    agentName: 'worker',
    pid: process.pid,
    running: true,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
    agents: {
      worker: {
        agent: 'command',
        tokenConfigured: true,
        connected: true,
        tag: 'owner#0001',
        userId: '1',
      },
    },
  });

  await withAdminServer(projectRoot, async ({ url }) => {
    const reconnectResponse = await requestJson(
      `${url}/api/agents/${encodeURIComponent('worker')}/reconnect`,
      {
        method: 'POST',
      },
    );
    assert.equal(reconnectResponse.response.status, 200, JSON.stringify(reconnectResponse.payload));
    assert.equal(reconnectResponse.payload.result.queued, true);
    assert.equal(reconnectResponse.payload.result.action, 'reconnect-agent');
    assert.equal(reconnectResponse.payload.result.agentName, 'worker');

    const reloadResponse = await requestJson(`${url}/api/discord-service/reload`, {
      method: 'POST',
    });
    assert.equal(reloadResponse.response.status, 200, JSON.stringify(reloadResponse.payload));
    assert.equal(reloadResponse.payload.result.action, 'reload-all');
    assert.equal(Array.isArray(reloadResponse.payload.result.agents), true);
    assert.equal(reloadResponse.payload.result.agents.length, 1);
    assert.equal(reloadResponse.payload.result.agents[0].queued, true);
    assert.equal(reloadResponse.payload.result.agents[0].action, 'reload-config');

    const commands = listDiscordServiceCommands(projectRoot, {
      agentName: 'worker',
    });
    assert.deepEqual(
      commands.map((entry) => ({
        action: entry.action,
        agentName: entry.agentName || null,
      })),
      [
        {
          action: 'reconnect-agent',
          agentName: 'worker',
        },
        {
          action: 'reload-config',
          agentName: 'worker',
        },
      ],
    );
  });
});

test('admin server reloads an already-running Telegram worker when its token changes', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'telegram',
    telegramBotToken: 'old-token',
  });
  config.channels.alerts = buildChannelDefinition(projectRoot, config, 'alerts', {
    name: 'alerts',
    platform: 'telegram',
    telegramChatId: '-100111222333',
    workspace: 'workspace',
    agent: 'worker',
  });
  saveConfig(projectRoot, config);

  writeTelegramAgentServiceStatus(projectRoot, 'worker', {
    version: 1,
    projectRoot,
    agentName: 'worker',
    pid: process.pid,
    running: true,
    desiredRunning: true,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
    agents: {
      worker: {
        agent: 'command',
        tokenConfigured: true,
        connected: true,
        username: 'old_bot',
        userId: '1',
      },
    },
  });

  await withEnv({ HKCLAW_LITE_CHANNEL_AUTOSTART: '1' }, async () => {
    await withAdminServer(projectRoot, async ({ url }) => {
      assert.equal(listTelegramServiceCommands(projectRoot, { agentName: 'worker' }).length, 0);

      const response = await requestJson(`${url}/api/agents`, {
        method: 'POST',
        body: {
          currentName: 'worker',
          definition: {
            name: 'worker',
            agent: 'command',
            command: `node ${fixturePath}`,
            platform: 'telegram',
            telegramBotToken: 'new-token',
          },
        },
      });

      assert.equal(response.response.status, 200, JSON.stringify(response.payload));
      assert.equal(loadConfig(projectRoot).agents.worker.telegramBotToken, 'new-token');

      const commands = listTelegramServiceCommands(projectRoot, { agentName: 'worker' });
      assert.deepEqual(
        commands.map((entry) => ({
          action: entry.action,
          agentName: entry.agentName || null,
        })),
        [
          {
            action: 'reload-config',
            agentName: 'worker',
          },
        ],
      );
    });
  });
});

test('admin server reloads an already-running Discord worker when its token changes', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'discord',
    discordToken: 'old-token',
  });
  config.channels.ops = buildChannelDefinition(projectRoot, config, 'ops', {
    name: 'ops',
    platform: 'discord',
    discordChannelId: '123456789012345678',
    workspace: 'workspace',
    agent: 'worker',
  });
  saveConfig(projectRoot, config);

  writeDiscordAgentServiceStatus(projectRoot, 'worker', {
    version: 1,
    projectRoot,
    agentName: 'worker',
    pid: process.pid,
    running: true,
    desiredRunning: true,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
    agents: {
      worker: {
        agent: 'command',
        tokenConfigured: true,
        connected: true,
        tag: 'old#0001',
        userId: '1',
      },
    },
  });

  await withEnv({ HKCLAW_LITE_CHANNEL_AUTOSTART: '1' }, async () => {
    await withAdminServer(projectRoot, async ({ url }) => {
      assert.equal(listDiscordServiceCommands(projectRoot, { agentName: 'worker' }).length, 0);

      const response = await requestJson(`${url}/api/agents`, {
        method: 'POST',
        body: {
          currentName: 'worker',
          definition: {
            name: 'worker',
            agent: 'command',
            command: `node ${fixturePath}`,
            platform: 'discord',
            discordToken: 'new-token',
          },
        },
      });

      assert.equal(response.response.status, 200, JSON.stringify(response.payload));
      assert.equal(loadConfig(projectRoot).agents.worker.discordToken, 'new-token');

      const commands = listDiscordServiceCommands(projectRoot, { agentName: 'worker' });
      assert.deepEqual(
        commands.map((entry) => ({
          action: entry.action,
          agentName: entry.agentName || null,
        })),
        [
          {
            action: 'reload-config',
            agentName: 'worker',
          },
        ],
      );
    });
  });
});

test('admin server reloads the Kakao platform worker when a Kakao connector changes', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
  });
  config.connectors['kakao-main'] = buildConnectorDefinition('kakao-main', {
    name: 'kakao-main',
    type: 'kakao',
    kakaoRelayUrl: 'https://relay.example/old',
  });
  config.channels.support = buildChannelDefinition(projectRoot, config, 'support', {
    name: 'support',
    platform: 'kakao',
    connector: 'kakao-main',
    kakaoChannelId: 'support',
    workspace: 'workspace',
    agent: 'worker',
  });
  saveConfig(projectRoot, config);

  writeKakaoServiceStatus(projectRoot, {
    version: 1,
    projectRoot,
    agentName: null,
    pid: process.pid,
    running: true,
    desiredRunning: true,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
    agents: {
      'kakao-main': {
        agent: '',
        tokenConfigured: true,
        connected: true,
        relayUrl: 'https://relay.example/old',
        pairedUserId: 'user-1',
      },
    },
  });

  await withEnv({ HKCLAW_LITE_CHANNEL_AUTOSTART: '1' }, async () => {
    await withAdminServer(projectRoot, async ({ url }) => {
      assert.equal(listKakaoServiceCommands(projectRoot).length, 0);

      const response = await requestJson(`${url}/api/connectors`, {
        method: 'POST',
        body: {
          currentName: 'kakao-main',
          definition: {
            name: 'kakao-main',
            type: 'kakao',
            kakaoRelayUrl: 'https://relay.example/new',
          },
        },
      });

      assert.equal(response.response.status, 200, JSON.stringify(response.payload));
      assert.equal(loadConfig(projectRoot).connectors['kakao-main'].kakaoRelayUrl, 'https://relay.example/new');

      const commands = listKakaoServiceCommands(projectRoot);
      assert.deepEqual(
        commands.map((entry) => ({
          action: entry.action,
          agentName: entry.agentName || null,
        })),
        [
          {
            action: 'reload-config',
            agentName: null,
          },
        ],
      );
    });
  });
});

test('admin server reloads the Kakao platform worker when a Kakao agent creates a derived connection without a channel', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  writeKakaoServiceStatus(projectRoot, {
    version: 1,
    projectRoot,
    agentName: null,
    pid: process.pid,
    running: true,
    desiredRunning: true,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
    agents: {},
  });

  await withEnv({ HKCLAW_LITE_CHANNEL_AUTOSTART: '1' }, async () => {
    await withAdminServer(projectRoot, async ({ url }) => {
      assert.equal(listKakaoServiceCommands(projectRoot).length, 0);

      const response = await requestJson(`${url}/api/agents`, {
        method: 'POST',
        body: {
          definition: {
            name: 'kao',
            agent: 'codex',
            platform: 'kakao',
            kakaoRelayUrl: 'https://relay.example/',
          },
        },
      });

      assert.equal(response.response.status, 200, JSON.stringify(response.payload));
      const config = loadConfig(projectRoot);
      assert.equal(config.agents.kao.platform, 'kakao');
      assert.equal(config.connectors.kao.type, 'kakao');
      assert.equal(config.channels.kao, undefined);

      const commands = listKakaoServiceCommands(projectRoot);
      assert.deepEqual(
        commands.map((entry) => ({
          action: entry.action,
          agentName: entry.agentName || null,
        })),
        [
          {
            action: 'reload-config',
            agentName: null,
          },
        ],
      );
    });
  });
});

test('admin snapshot scopes channel worker requirements to connector platform routes', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  await withAdminServer(projectRoot, async ({ url }) => {
    const agentResponse = await requestJson(`${url}/api/agents`, {
      method: 'POST',
      body: {
        definition: {
          name: 'worker',
          agent: 'command',
          command: `node ${fixturePath}`,
        },
      },
    });
    assert.equal(agentResponse.response.status, 200, JSON.stringify(agentResponse.payload));

    const telegramAgentResponse = await requestJson(`${url}/api/agents`, {
      method: 'POST',
      body: {
        definition: {
          name: 'telegram-worker',
          agent: 'command',
          platform: 'telegram',
          telegramBotToken: 'telegram-token',
          command: `node ${fixturePath}`,
        },
      },
    });
    assert.equal(telegramAgentResponse.response.status, 200, JSON.stringify(telegramAgentResponse.payload));

    const discordAgentResponse = await requestJson(`${url}/api/agents`, {
      method: 'POST',
      body: {
        definition: {
          name: 'discord-worker',
          agent: 'command',
          platform: 'discord',
          discordToken: 'discord-token',
          command: `node ${fixturePath}`,
        },
      },
    });
    assert.equal(discordAgentResponse.response.status, 200, JSON.stringify(discordAgentResponse.payload));

    const connectorResponse = await requestJson(`${url}/api/connectors`, {
      method: 'POST',
      body: {
        definition: {
          name: 'kakao-main',
          type: 'kakao',
          kakaoRelayUrl: 'https://relay.example/',
        },
      },
    });
    assert.equal(connectorResponse.response.status, 200, JSON.stringify(connectorResponse.payload));

    for (const definition of [
      {
        name: 'discord-ops',
        platform: 'discord',
        discordChannelId: '123456789012345678',
        workspace: 'workspace',
        agent: 'discord-worker',
      },
      {
        name: 'telegram-alerts',
        platform: 'telegram',
        telegramChatId: '-100111222333',
        workspace: 'workspace',
        agent: 'telegram-worker',
      },
      {
        name: 'kakao-support',
        platform: 'kakao',
        connector: 'kakao-main',
        kakaoChannelId: 'support',
        workspace: 'workspace',
        agent: 'worker',
      },
    ]) {
      const response = await requestJson(`${url}/api/channels`, {
        method: 'POST',
        body: { definition },
      });
      assert.equal(response.response.status, 200, JSON.stringify(response.payload));
    }

    const { payload } = await requestJson(`${url}/api/state`);

    assert.equal(payload.discord.singleChannelCount, 1);
    assert.equal(payload.discord.tribunalChannelCount, 0);
    assert.equal(payload.telegram.telegramChannelCount, 1);
    assert.equal(payload.kakao.kakaoChannelCount, 1);

    assert.equal(payload.discord.agents['discord-worker'].required, true);
    assert.equal(payload.telegram.agents['telegram-worker'].required, true);
    assert.equal(payload.kakao.agents.worker.required, false);

    assert.equal(payload.discord.agents['discord-worker'].connector, false);
    assert.equal(payload.telegram.agents['telegram-worker'].connector, false);
    assert.equal(payload.kakao.agents['kakao-main'].connector, true);
    assert.equal(payload.kakao.agents['kakao-main'].required, true);

    const worker = payload.agents.find((agent) => agent.name === 'worker');
    assert.deepEqual(
      worker.mappedChannels.map((channel) => ({
        name: channel.name,
        platform: channel.platform,
        connector: channel.connector,
      })),
      [
        { name: 'kakao-support', platform: 'kakao', connector: 'kakao-main' },
      ],
    );
  });
});

test('admin server auto-starts messaging workers for configured channels', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  const previousAutostart = process.env.HKCLAW_LITE_CHANNEL_AUTOSTART;
  const previousDiscordEntry = process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
  const previousTelegramEntry = process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY;
  const previousKakaoEntry = process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_CHANNEL_AUTOSTART = '1';
  process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = fakeDiscordServicePath;
  process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY = fakeTelegramServicePath;
  process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY = fakeKakaoServicePath;

  const config = loadConfig(projectRoot);
  config.agents['discord-worker'] = buildAgentDefinition(projectRoot, 'discord-worker', {
    name: 'discord-worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'discord',
    discordToken: 'discord-token',
  });
  config.agents['telegram-worker'] = buildAgentDefinition(projectRoot, 'telegram-worker', {
    name: 'telegram-worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'telegram',
    telegramBotToken: 'telegram-token',
  });
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
  });
  config.connectors['kakao-main'] = buildConnectorDefinition('kakao-main', {
    name: 'kakao-main',
    type: 'kakao',
    kakaoRelayUrl: 'https://relay.example/',
  });
  config.channels['discord-ops'] = buildChannelDefinition(projectRoot, config, 'discord-ops', {
    name: 'discord-ops',
    platform: 'discord',
    discordChannelId: '123456789012345678',
    workspace: 'workspace',
    agent: 'discord-worker',
  });
  config.channels['telegram-alerts'] = buildChannelDefinition(projectRoot, config, 'telegram-alerts', {
    name: 'telegram-alerts',
    platform: 'telegram',
    telegramChatId: '-100111222333',
    workspace: 'workspace',
    agent: 'telegram-worker',
  });
  config.channels['kakao-support'] = buildChannelDefinition(projectRoot, config, 'kakao-support', {
    name: 'kakao-support',
    platform: 'kakao',
    connector: 'kakao-main',
    kakaoChannelId: 'support',
    workspace: 'workspace',
    agent: 'worker',
  });
  saveConfig(projectRoot, config);

  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const discord = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        return snapshot.agentServices?.['discord-worker']?.running ? snapshot : null;
      });
      assert.equal(discord?.agentServices?.['discord-worker']?.desiredRunning, true);

      const telegram = await waitFor(() => {
        const snapshot = buildTelegramServiceSnapshot(projectRoot);
        return snapshot.agentServices?.['telegram-worker']?.running ? snapshot : null;
      });
      assert.equal(telegram?.agentServices?.['telegram-worker']?.desiredRunning, true);

      const kakao = await waitFor(() => {
        const snapshot = buildKakaoServiceSnapshot(projectRoot);
        return snapshot.running ? snapshot : null;
      });
      assert.equal(kakao?.desiredRunning, true);

      const { payload } = await requestJson(`${url}/api/state`);
      assert.equal(payload.discord.service.running, true);
      assert.equal(payload.telegram.service.running, true);
      assert.equal(payload.kakao.service.running, true);

      await Promise.allSettled([
        requestJson(`${url}/api/discord-service/stop`, { method: 'POST' }),
        requestJson(`${url}/api/telegram-service/stop`, { method: 'POST' }),
        requestJson(`${url}/api/kakao-service/stop`, { method: 'POST' }),
      ]);
    });
  } finally {
    if (previousAutostart === undefined) {
      process.env.HKCLAW_LITE_CHANNEL_AUTOSTART = '0';
    } else {
      process.env.HKCLAW_LITE_CHANNEL_AUTOSTART = previousAutostart;
    }
    if (previousDiscordEntry === undefined) {
      delete process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = previousDiscordEntry;
    }
    if (previousTelegramEntry === undefined) {
      delete process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY = previousTelegramEntry;
    }
    if (previousKakaoEntry === undefined) {
      delete process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY = previousKakaoEntry;
    }
  }
});

test('admin server keeps messaging worker controls on agents instead of channels', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = fakeDiscordServicePath;

  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    discordToken: 'owner-token',
  });
  config.channels.ops = buildChannelDefinition(projectRoot, config, 'ops', {
    name: 'ops',
    platform: 'discord',
    discordChannelId: '123456789012345678',
    workspace: 'workspace',
    agent: 'worker',
  });
  saveConfig(projectRoot, config);

  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const channelStartResponse = await requestJson(`${url}/api/channels/ops/receiver/start`, {
        method: 'POST',
      });
      assert.equal(channelStartResponse.response.status, 404, JSON.stringify(channelStartResponse.payload));

      const startResponse = await requestJson(`${url}/api/agents/worker/start`, {
        method: 'POST',
      });
      assert.equal(startResponse.response.status, 200, JSON.stringify(startResponse.payload));
      assert.equal(startResponse.payload.result.action, 'start');
      assert.equal(startResponse.payload.result.agentName, 'worker');

      const started = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(started?.agentServices?.worker?.desiredRunning, true);

      const channelRestartResponse = await requestJson(`${url}/api/channels/ops/receiver/restart`, {
        method: 'POST',
      });
      assert.equal(channelRestartResponse.response.status, 404, JSON.stringify(channelRestartResponse.payload));

      const restartResponse = await requestJson(`${url}/api/agents/worker/restart`, {
        method: 'POST',
      });
      assert.equal(restartResponse.response.status, 200, JSON.stringify(restartResponse.payload));
      assert.equal(restartResponse.payload.result.action, 'restart');
      assert.equal(restartResponse.payload.result.agentName, 'worker');

      const restarted = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(restarted?.agentServices?.worker?.desiredRunning, true);

      const stopResponse = await requestJson(`${url}/api/agents/worker/stop`, {
        method: 'POST',
      });
      assert.equal(stopResponse.response.status, 200, JSON.stringify(stopResponse.payload));
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = previousEntry;
    }
  }
});

test('admin server can start, restart, and stop Discord service', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = fakeDiscordServicePath;
  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    discordToken: 'owner-token',
  });
  saveConfig(projectRoot, config);

  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const startResponse = await requestJson(`${url}/api/agents/worker/start`, {
        method: 'POST',
      });
      assert.equal(startResponse.response.status, 200, JSON.stringify(startResponse.payload));
      assert.equal(startResponse.payload.result.action, 'start');
      assert.equal(startResponse.payload.result.agentName, 'worker');

      const running = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(Boolean(running?.running), true);
      assert.equal(Number.isInteger(running?.agentServices?.worker?.pid), true);

      const restartResponse = await requestJson(`${url}/api/agents/worker/restart`, {
        method: 'POST',
      });
      assert.equal(restartResponse.response.status, 200, JSON.stringify(restartResponse.payload));
      assert.equal(restartResponse.payload.result.action, 'restart');
      assert.equal(restartResponse.payload.result.agentName, 'worker');

      const restarted = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(Boolean(restarted?.running), true);
      assert.equal(Number.isInteger(restarted?.agentServices?.worker?.pid), true);

      const stopResponse = await requestJson(`${url}/api/agents/worker/stop`, {
        method: 'POST',
      });
      assert.equal(stopResponse.response.status, 200, JSON.stringify(stopResponse.payload));
      assert.equal(stopResponse.payload.result.action, 'stop');
      assert.equal(stopResponse.payload.result.agentName, 'worker');

      const stopped = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        const worker = snapshot.agentServices?.worker;
        return worker && !worker.running && !worker.pidAlive ? snapshot : null;
      });
      assert.equal(stopped?.agentServices?.worker?.running, false);
      assert.equal(readDiscordAgentServiceStatus(projectRoot, 'worker')?.desiredRunning, false);
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = previousEntry;
    }
  }
});

test('admin server accepts Discord service while it is still starting', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = fakeSlowDiscordServicePath;
  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    discordToken: 'owner-token',
  });
  saveConfig(projectRoot, config);

  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const startResponse = await requestJson(`${url}/api/agents/worker/start`, {
        method: 'POST',
      });
      assert.equal(startResponse.response.status, 200, JSON.stringify(startResponse.payload));
      assert.equal(startResponse.payload.result.action, 'start');
      assert.equal(startResponse.payload.result.agentName, 'worker');
      assert.equal(Boolean(startResponse.payload.result.running || startResponse.payload.result.starting), true);

      const starting = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        const worker = snapshot.agentServices?.worker;
        return worker?.starting ? snapshot : null;
      });
      assert.equal(starting?.agentServices?.worker?.state, 'starting');

      const running = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(Boolean(running?.agentServices?.worker?.running), true);
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = previousEntry;
    }
  }
});

test('admin server restores desired Discord service on startup', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = fakeDiscordServicePath;
  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    discordToken: 'owner-token',
  });
  saveConfig(projectRoot, config);
  writeDiscordAgentServiceStatus(projectRoot, 'worker', {
    version: 1,
    projectRoot,
    agentName: 'worker',
    pid: 999999,
    running: false,
    desiredRunning: true,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: '2026-04-15T00:00:00.000Z',
    agents: {
      worker: {
        agent: 'command',
        tokenConfigured: true,
        connected: true,
        tag: 'worker#0001',
        userId: '1',
      },
    },
  });

  try {
    await setManagedServiceEnvSnapshot(projectRoot, {
      platform: 'discord',
      agentName: 'worker',
      env: process.env,
    });
    await withAdminServer(projectRoot, async ({ url }) => {
      const restored = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(Boolean(restored?.agentServices?.worker?.running), true);
      assert.equal(restored?.agentServices?.worker?.desiredRunning, true);
      assert.equal(Number.isInteger(restored?.agentServices?.worker?.pid), true);
      assert.notEqual(restored?.agentServices?.worker?.pid, 999999);

      const stopResponse = await requestJson(`${url}/api/agents/worker/stop`, {
        method: 'POST',
      });
      assert.equal(stopResponse.response.status, 200, JSON.stringify(stopResponse.payload));
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = previousEntry;
    }
  }
});

test('admin server restores desired Discord service on startup using runtime db env snapshot', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
  const previousRequiredEnvName = process.env.HKCLAW_LITE_TEST_REQUIRED_ENV_NAME;
  const previousRestoreToken = process.env.HKCLAW_RESTORE_TOKEN;
  process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = fakeDiscordServicePath;
  process.env.HKCLAW_LITE_TEST_REQUIRED_ENV_NAME = 'HKCLAW_RESTORE_TOKEN';
  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    discordToken: 'owner-token',
  });
  saveConfig(projectRoot, config);
  writeDiscordAgentServiceStatus(projectRoot, 'worker', {
    version: 1,
    projectRoot,
    agentName: 'worker',
    pid: 999999,
    running: false,
    desiredRunning: true,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: '2026-04-15T00:00:00.000Z',
    agents: {
      worker: {
        agent: 'command',
        tokenConfigured: true,
        connected: true,
        tag: 'worker#0001',
        userId: '1',
      },
    },
  });

  try {
    await setManagedServiceEnvSnapshot(projectRoot, {
      platform: 'discord',
      agentName: 'worker',
      env: {
        ...process.env,
        HKCLAW_RESTORE_TOKEN: 'from-runtime-db',
      },
    });
    delete process.env.HKCLAW_RESTORE_TOKEN;
    await withAdminServer(projectRoot, async () => {
      const restored = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(Boolean(restored?.agentServices?.worker?.running), true);
      assert.equal(restored?.agentServices?.worker?.desiredRunning, true);
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = previousEntry;
    }
    if (previousRequiredEnvName === undefined) {
      delete process.env.HKCLAW_LITE_TEST_REQUIRED_ENV_NAME;
    } else {
      process.env.HKCLAW_LITE_TEST_REQUIRED_ENV_NAME = previousRequiredEnvName;
    }
    if (previousRestoreToken === undefined) {
      delete process.env.HKCLAW_RESTORE_TOKEN;
    } else {
      process.env.HKCLAW_RESTORE_TOKEN = previousRestoreToken;
    }
  }
});

test('admin server restores legacy global Discord service state for existing agents', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = fakeDiscordServicePath;
  const config = loadConfig(projectRoot);
  config.agents.legacy = buildAgentDefinition(projectRoot, 'legacy', {
    name: 'legacy',
    agent: 'command',
    command: `node ${fixturePath}`,
    discordToken: 'legacy-token',
  });
  config.agents.fresh = buildAgentDefinition(projectRoot, 'fresh', {
    name: 'fresh',
    agent: 'command',
    command: `node ${fixturePath}`,
    discordToken: 'fresh-token',
  });
  saveConfig(projectRoot, config);

  writeDiscordServiceStatus(projectRoot, {
    version: 1,
    projectRoot,
    pid: 999999,
    running: false,
    desiredRunning: true,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: '2026-04-15T00:00:00.000Z',
    agents: {
      legacy: {
        agent: 'command',
        tokenConfigured: true,
        connected: true,
        tag: 'legacy#0001',
        userId: '11',
      },
    },
  });
  writeDiscordAgentServiceStatus(projectRoot, 'fresh', {
    version: 1,
    projectRoot,
    agentName: 'fresh',
    pid: 999999,
    running: false,
    desiredRunning: true,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: '2026-04-15T00:00:00.000Z',
    agents: {
      fresh: {
        agent: 'command',
        tokenConfigured: true,
        connected: true,
        tag: 'fresh#0001',
        userId: '22',
      },
    },
  });

  try {
    await setManagedServiceEnvSnapshot(projectRoot, {
      platform: 'discord',
      agentName: 'legacy',
      env: process.env,
    });
    await setManagedServiceEnvSnapshot(projectRoot, {
      platform: 'discord',
      agentName: 'fresh',
      env: process.env,
    });
    await withAdminServer(projectRoot, async () => {
      const restored = await waitFor(() => {
        const snapshot = buildDiscordServiceSnapshot(projectRoot);
        const legacy = snapshot.agentServices?.legacy;
        const fresh = snapshot.agentServices?.fresh;
        return legacy?.running && fresh?.running ? snapshot : null;
      });
      assert.equal(Boolean(restored?.agentServices?.legacy?.running), true);
      assert.equal(Boolean(restored?.agentServices?.fresh?.running), true);
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_DISCORD_SERVICE_ENTRY = previousEntry;
    }
  }
});

test('admin server can start, restart, and stop Telegram service', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY = fakeTelegramServicePath;
  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'telegram',
    telegramBotToken: 'telegram-token',
  });
  saveConfig(projectRoot, config);

  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const startResponse = await requestJson(`${url}/api/agents/worker/start`, {
        method: 'POST',
      });
      assert.equal(startResponse.response.status, 200, JSON.stringify(startResponse.payload));
      assert.equal(startResponse.payload.result.action, 'start');
      assert.equal(startResponse.payload.result.agentName, 'worker');
      assert.equal(startResponse.payload.result.platform, 'telegram');

      const running = await waitFor(() => {
        const snapshot = buildTelegramServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(Boolean(running?.running), true);
      assert.equal(Number.isInteger(running?.agentServices?.worker?.pid), true);

      const restartResponse = await requestJson(`${url}/api/agents/worker/restart`, {
        method: 'POST',
      });
      assert.equal(restartResponse.response.status, 200, JSON.stringify(restartResponse.payload));
      assert.equal(restartResponse.payload.result.action, 'restart');
      assert.equal(restartResponse.payload.result.agentName, 'worker');
      assert.equal(restartResponse.payload.result.platform, 'telegram');

      const restarted = await waitFor(() => {
        const snapshot = buildTelegramServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(Boolean(restarted?.running), true);
      assert.equal(Number.isInteger(restarted?.agentServices?.worker?.pid), true);

      const stopResponse = await requestJson(`${url}/api/agents/worker/stop`, {
        method: 'POST',
      });
      assert.equal(stopResponse.response.status, 200, JSON.stringify(stopResponse.payload));
      assert.equal(stopResponse.payload.result.action, 'stop');
      assert.equal(stopResponse.payload.result.agentName, 'worker');
      assert.equal(stopResponse.payload.result.platform, 'telegram');

      const stopped = await waitFor(() => {
        const snapshot = buildTelegramServiceSnapshot(projectRoot);
        const worker = snapshot.agentServices?.worker;
        return worker && !worker.running && !worker.pidAlive ? snapshot : null;
      });
      assert.equal(stopped?.agentServices?.worker?.running, false);
      assert.equal(readTelegramAgentServiceStatus(projectRoot, 'worker')?.desiredRunning, false);
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY = previousEntry;
    }
  }
});

test('admin server can start, restart, and stop Kakao service', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY = fakeKakaoServicePath;
  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'kakao',
    kakaoRelayUrl: 'https://relay.example/',
  });
  saveConfig(projectRoot, config);

  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const startResponse = await requestJson(`${url}/api/agents/worker/start`, {
        method: 'POST',
      });
      assert.equal(startResponse.response.status, 200, JSON.stringify(startResponse.payload));
      assert.equal(startResponse.payload.result.action, 'start');
      assert.equal(startResponse.payload.result.agentName, 'worker');
      assert.equal(startResponse.payload.result.platform, 'kakao');

      const running = await waitFor(() => {
        const snapshot = buildKakaoServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(Boolean(running?.running), true);
      assert.equal(Number.isInteger(running?.agentServices?.worker?.pid), true);

      const restartResponse = await requestJson(`${url}/api/agents/worker/restart`, {
        method: 'POST',
      });
      assert.equal(restartResponse.response.status, 200, JSON.stringify(restartResponse.payload));
      assert.equal(restartResponse.payload.result.action, 'restart');
      assert.equal(restartResponse.payload.result.agentName, 'worker');
      assert.equal(restartResponse.payload.result.platform, 'kakao');

      const restarted = await waitFor(() => {
        const snapshot = buildKakaoServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(Boolean(restarted?.running), true);
      assert.equal(Number.isInteger(restarted?.agentServices?.worker?.pid), true);

      const stopResponse = await requestJson(`${url}/api/agents/worker/stop`, {
        method: 'POST',
      });
      assert.equal(stopResponse.response.status, 200, JSON.stringify(stopResponse.payload));
      assert.equal(stopResponse.payload.result.action, 'stop');
      assert.equal(stopResponse.payload.result.agentName, 'worker');
      assert.equal(stopResponse.payload.result.platform, 'kakao');

      const stopped = await waitFor(() => {
        const snapshot = buildKakaoServiceSnapshot(projectRoot);
        const worker = snapshot.agentServices?.worker;
        return worker && !worker.running && !worker.pidAlive ? snapshot : null;
      });
      assert.equal(stopped?.agentServices?.worker?.running, false);
      assert.equal(readKakaoAgentServiceStatus(projectRoot, 'worker')?.desiredRunning, false);
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY = previousEntry;
    }
  }
});

test('admin Kakao channel worker starts one platform process for connector-only channels', async () => {
  const projectRoot = createProject();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY = fakeKakaoServicePath;
  const config = loadConfig(projectRoot);
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'command',
    command: `node ${fixturePath}`,
  });
  config.connectors.kakaoMain = buildConnectorDefinition('kakaoMain', {
    type: 'kakao',
    kakaoRelayUrl: 'https://relay.example/',
    kakaoSessionToken: 'session-token',
  });
  config.channels.support = buildChannelDefinition(projectRoot, config, 'support', {
    platform: 'kakao',
    connector: 'kakaoMain',
    kakaoChannelId: '*',
    workspace: workspacePath,
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const startResponse = await requestJson(`${url}/api/kakao-service/start`, {
        method: 'POST',
      });
      assert.equal(startResponse.response.status, 200, JSON.stringify(startResponse.payload));
      assert.equal(startResponse.payload.result.action, 'start');
      assert.equal(startResponse.payload.result.platform, 'kakao');
      assert.equal(startResponse.payload.result.agentName, null);

      const running = await waitFor(() => {
        const snapshot = buildKakaoServiceSnapshot(projectRoot);
        return snapshot.running ? snapshot : null;
      });
      assert.equal(Boolean(running?.running), true);
      assert.equal(Number.isInteger(running?.pid), true);
      assert.equal(readKakaoServiceStatus(projectRoot)?.agentName, null);

      const stopResponse = await requestJson(`${url}/api/kakao-service/stop`, {
        method: 'POST',
      });
      assert.equal(stopResponse.response.status, 200, JSON.stringify(stopResponse.payload));
      assert.equal(stopResponse.payload.result.action, 'stop');
      assert.equal(stopResponse.payload.result.platform, 'kakao');
      assert.equal(stopResponse.payload.result.agentName, null);

      const stopped = await waitFor(() => {
        const snapshot = buildKakaoServiceSnapshot(projectRoot);
        return !snapshot.running && !snapshot.pidAlive ? snapshot : null;
      });
      assert.equal(stopped?.running, false);
      assert.equal(readKakaoServiceStatus(projectRoot)?.desiredRunning, false);
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY = previousEntry;
    }
  }
});

test('admin reuses the Kakao platform worker when an agent start is requested', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY = fakeKakaoServicePath;
  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'kakao',
    kakaoRelayUrl: 'https://relay.example/',
  });
  saveConfig(projectRoot, config);
  writeKakaoServiceStatus(projectRoot, {
    version: 1,
    projectRoot,
    agentName: null,
    pid: 999_999_999,
    running: true,
    desiredRunning: true,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    heartbeatAt: new Date().toISOString(),
    lastError: null,
    agents: {
      worker: {
        tokenConfigured: true,
        connected: true,
        relayUrl: 'https://relay.example/',
      },
    },
  });

  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const startResponse = await requestJson(`${url}/api/agents/worker/start`, {
        method: 'POST',
      });
      assert.equal(startResponse.response.status, 200, JSON.stringify(startResponse.payload));
      assert.equal(startResponse.payload.result.delegatedTo, 'kakao-platform');
      assert.equal(startResponse.payload.result.alreadyRunning, true);
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_KAKAO_SERVICE_ENTRY = previousEntry;
    }
  }
});

test('admin server exposes embedded Kakao relay session, webhook, SSE, and reply APIs', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  await withAdminServer(projectRoot, async ({ url }) => {
    const health = await requestJson(`${url}/v1/healthz`);
    assert.equal(health.response.status, 200, JSON.stringify(health.payload));
    assert.deepEqual(health.payload, {
      ok: true,
      status: 'healthy',
      relay: 'kakao-talkchannel',
      activeEventStreams: 0,
    });

    const healthHead = await fetch(`${url}/kakao-talkchannel/healthz`, { method: 'HEAD' });
    assert.equal(healthHead.status, 200);
    assert.match(healthHead.headers.get('content-type') || '', /application\/json/u);

    const invalidJson = await fetch(`${url}/kakao-talkchannel/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const invalidJsonPayload = await invalidJson.json();
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(invalidJsonPayload, { error: 'Invalid JSON body.' });

    const session = await requestJson(`${url}/v1/sessions/create`, {
      method: 'POST',
      body: {},
    });
    assert.equal(session.response.status, 200, JSON.stringify(session.payload));
    assert.equal(typeof session.payload.sessionToken, 'string');
    assert.match(session.payload.pairingCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);

    const sse = await openSse(`${url}/v1/events`, session.payload.sessionToken);
    try {
      const pair = await requestJson(`${url}/kakao-talkchannel/webhook`, {
        method: 'POST',
        body: {
          bot: { id: 'talk-channel' },
          userRequest: {
            utterance: `/pair ${session.payload.pairingCode}`,
            user: {
              id: 'kakao-user',
              properties: {
                plusfriendUserKey: 'plusfriend-user',
              },
            },
          },
        },
      });
      assert.equal(pair.response.status, 200, JSON.stringify(pair.payload));
      assert.match(pair.payload.template.outputs[0].simpleText.text, /연결되었습니다/u);

      const paired = await sse.waitForEvent('pairing_complete');
      assert.equal(paired.data.kakaoUserId, 'plusfriend-user');

      let callbackPayload = null;
      await withJsonServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          callbackPayload = JSON.parse(body || '{}');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true }));
        });
      }, async (callbackUrl) => {
        const webhook = await requestJson(`${url}/kakao-talkchannel/webhook`, {
          method: 'POST',
          body: {
            bot: { id: 'talk-channel' },
            userRequest: {
              utterance: '안녕',
              callbackUrl,
              user: {
                id: 'kakao-user',
                properties: {
                  plusfriendUserKey: 'plusfriend-user',
                },
              },
            },
          },
        });
        assert.equal(webhook.response.status, 200, JSON.stringify(webhook.payload));
        assert.equal(webhook.payload.useCallback, true);
        assert.match(webhook.payload.data.text, /서버에 도착했습니다/u);
        assert.match(webhook.payload.data.text, /답변을 준비 중/u);

        const message = await sse.waitForEvent('message');
        assert.equal(message.data.normalized.text, '안녕');
        assert.equal(message.data.normalized.channelId, 'talk-channel');

        const replyBody = {
          version: '2.0',
          template: {
            outputs: [{ simpleText: { text: '응답' } }],
          },
        };
        const reply = await requestJson(`${url}/openclaw/reply`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.payload.sessionToken}`,
          },
          body: {
            messageId: message.data.id,
            response: replyBody,
          },
        });
        assert.equal(reply.response.status, 200, JSON.stringify(reply.payload));
        assert.equal(reply.payload.success, true);
        await waitFor(() => callbackPayload);
        assert.deepEqual(callbackPayload, replyBody);
      });
    } finally {
      await sse.close();
    }
  });
});

test('embedded Kakao relay requires the explicit /pair pairing command', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  await withAdminServer(projectRoot, async ({ url }) => {
    const codeOnlySession = await requestJson(`${url}/v1/sessions/create`, {
      method: 'POST',
      body: {},
    });
    assert.equal(codeOnlySession.response.status, 200, JSON.stringify(codeOnlySession.payload));

    const codeOnlyPair = await requestJson(`${url}/kakao-talkchannel/webhook`, {
      method: 'POST',
      body: {
        bot: { id: 'talk-channel' },
        userRequest: {
          utterance: codeOnlySession.payload.pairingCode,
          user: {
            id: 'kakao-code-only-user',
            properties: {
              plusfriendUserKey: 'plusfriend-code-only-user',
            },
          },
        },
      },
    });
    assert.equal(codeOnlyPair.response.status, 200, JSON.stringify(codeOnlyPair.payload));
    assert.match(codeOnlyPair.payload.template.outputs[0].simpleText.text, /\/pair <코드>/u);

    const codeOnlyStatus = await requestJson(
      `${url}/v1/sessions/${encodeURIComponent(codeOnlySession.payload.sessionToken)}/status`,
    );
    assert.equal(codeOnlyStatus.payload.status, 'pending_pairing');
    assert.equal(codeOnlyStatus.payload.kakaoUserId, null);

    const aliasSession = await requestJson(`${url}/v1/sessions/create`, {
      method: 'POST',
      body: {},
    });
    assert.equal(aliasSession.response.status, 200, JSON.stringify(aliasSession.payload));

    const aliasPair = await requestJson(`${url}/kakao-talkchannel/webhook`, {
      method: 'POST',
      body: {
        bot: { id: 'talk-channel' },
        userRequest: {
          utterance: `pair ${aliasSession.payload.pairingCode.toLowerCase()}`,
          user: {
            id: 'kakao-pair-alias-user',
            properties: {
              plusfriendUserKey: 'plusfriend-pair-alias-user',
            },
          },
        },
      },
    });
    assert.equal(aliasPair.response.status, 200, JSON.stringify(aliasPair.payload));
    assert.match(aliasPair.payload.template.outputs[0].simpleText.text, /\/pair <코드>/u);

    const aliasStatus = await requestJson(
      `${url}/v1/sessions/${encodeURIComponent(aliasSession.payload.sessionToken)}/status`,
    );
    assert.equal(aliasStatus.payload.status, 'pending_pairing');
    assert.equal(aliasStatus.payload.kakaoUserId, null);

    const explicitPair = await requestJson(`${url}/kakao-talkchannel/webhook`, {
      method: 'POST',
      body: {
        bot: { id: 'talk-channel' },
        userRequest: {
          utterance: `/pair ${aliasSession.payload.pairingCode.toLowerCase()}`,
          user: {
            id: 'kakao-pair-alias-user',
            properties: {
              plusfriendUserKey: 'plusfriend-pair-alias-user',
            },
          },
        },
      },
    });
    assert.equal(explicitPair.response.status, 200, JSON.stringify(explicitPair.payload));
    assert.match(explicitPair.payload.template.outputs[0].simpleText.text, /연결되었습니다/u);
  });
});

test('embedded Kakao relay keeps only one SSE consumer per session token', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  await withAdminServer(projectRoot, async ({ url }) => {
    const session = await requestJson(`${url}/v1/sessions/create`, {
      method: 'POST',
      body: {},
    });
    assert.equal(session.response.status, 200, JSON.stringify(session.payload));

    const first = await openSse(`${url}/v1/events`, session.payload.sessionToken);
    await first.waitForEvent('connected');
    const second = await openSse(`${url}/v1/events`, session.payload.sessionToken);
    try {
      await second.waitForEvent('connected');
      await first.waitForClose();

      const health = await requestJson(`${url}/v1/healthz`);
      assert.equal(health.response.status, 200, JSON.stringify(health.payload));
      assert.equal(health.payload.activeEventStreams, 1);

      const pair = await requestJson(`${url}/kakao-talkchannel/webhook`, {
        method: 'POST',
        body: {
          bot: { id: 'talk-channel' },
          userRequest: {
            utterance: `/pair ${session.payload.pairingCode}`,
            user: {
              id: 'kakao-user',
              properties: {
                plusfriendUserKey: 'plusfriend-user',
              },
            },
          },
        },
      });
      assert.equal(pair.response.status, 200, JSON.stringify(pair.payload));
      const paired = await second.waitForEvent('pairing_complete');
      assert.equal(paired.data.kakaoUserId, 'plusfriend-user');
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  });
});

test('admin server restores desired Telegram service on startup', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousEntry = process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY;
  process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY = fakeTelegramServicePath;
  const config = loadConfig(projectRoot);
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
    platform: 'telegram',
    telegramBotToken: 'telegram-token',
  });
  saveConfig(projectRoot, config);
  writeTelegramAgentServiceStatus(projectRoot, 'worker', {
    version: 1,
    projectRoot,
    agentName: 'worker',
    pid: 999999,
    running: false,
    desiredRunning: true,
    startedAt: '2026-04-15T00:00:00.000Z',
    heartbeatAt: '2026-04-15T00:00:00.000Z',
    agents: {
      worker: {
        agent: 'command',
        tokenConfigured: true,
        connected: true,
        username: 'worker_bot',
        userId: '1',
      },
    },
  });

  try {
    await setManagedServiceEnvSnapshot(projectRoot, {
      platform: 'telegram',
      agentName: 'worker',
      env: process.env,
    });
    await withAdminServer(projectRoot, async ({ url }) => {
      const restored = await waitFor(() => {
        const snapshot = buildTelegramServiceSnapshot(projectRoot);
        return snapshot.agentServices?.worker?.running ? snapshot : null;
      });
      assert.equal(Boolean(restored?.agentServices?.worker?.running), true);
      assert.equal(restored?.agentServices?.worker?.desiredRunning, true);
      assert.equal(Number.isInteger(restored?.agentServices?.worker?.pid), true);
      assert.notEqual(restored?.agentServices?.worker?.pid, 999999);

      const stopResponse = await requestJson(`${url}/api/agents/worker/stop`, {
        method: 'POST',
      });
      assert.equal(stopResponse.response.status, 200, JSON.stringify(stopResponse.payload));
    });
  } finally {
    if (previousEntry === undefined) {
      delete process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY;
    } else {
      process.env.HKCLAW_LITE_TELEGRAM_SERVICE_ENTRY = previousEntry;
    }
  }
});

test('admin server supports lightweight password login via env', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousPassword = process.env.HKCLAW_LITE_ADMIN_PASSWORD;
  process.env.HKCLAW_LITE_ADMIN_PASSWORD = 'very-secret';

  try {
    await withAdminServer(projectRoot, async ({ url, passwordEnv, authEnabled }) => {
      assert.equal(passwordEnv, 'HKCLAW_LITE_ADMIN_PASSWORD');
      assert.equal(authEnabled, true);

      const authStatus = await requestJson(`${url}/api/auth/status`);
      assert.equal(authStatus.response.status, 200);
      assert.equal(authStatus.payload.enabled, true);
      assert.equal(authStatus.payload.authenticated, false);

      const blockedState = await requestJson(`${url}/api/state`);
      assert.equal(blockedState.response.status, 401);
      assert.match(blockedState.payload.error, /Authentication required/u);

      const wrongPassword = await requestJson(`${url}/api/login`, {
        method: 'POST',
        body: {
          password: 'wrong',
        },
      });
      assert.equal(wrongPassword.response.status, 401);
      assert.match(wrongPassword.payload.error, /Invalid password/u);

      const login = await requestJson(`${url}/api/login`, {
        method: 'POST',
        body: {
          password: 'very-secret',
        },
      });
      assert.equal(login.response.status, 200, JSON.stringify(login.payload));
      assert.equal(login.payload.authenticated, true);
      assert.equal(login.payload.storage, 'sqlite');
      const cookie = login.response.headers.get('set-cookie');
      assert.match(cookie, /hkclaw_lite_admin_session=/u);
      assert.doesNotMatch(cookie, /;\s*Secure/u);
      assert.match(cookie, /Max-Age=604800/u);

      const secureLogin = await requestJson(`${url}/api/login`, {
        method: 'POST',
        headers: {
          'x-forwarded-proto': 'https',
        },
        body: {
          password: 'very-secret',
        },
      });
      assert.equal(secureLogin.response.status, 200, JSON.stringify(secureLogin.payload));
      assert.match(secureLogin.response.headers.get('set-cookie') || '', /;\s*Secure/u);
      assert.equal(
        secureLogin.response.headers.get('strict-transport-security'),
        'max-age=31536000; includeSubDomains; preload',
      );

      const authedState = await requestJson(`${url}/api/state`, {
        headers: {
          cookie,
        },
      });
      assert.equal(authedState.response.status, 200);

      const logout = await requestJson(`${url}/api/logout`, {
        method: 'POST',
        headers: {
          cookie,
        },
      });
      assert.equal(logout.response.status, 200);
      assert.equal(logout.payload.authenticated, false);

      const afterLogout = await requestJson(`${url}/api/state`, {
        headers: {
          cookie,
        },
      });
      assert.equal(afterLogout.response.status, 401);
    });
  } finally {
    if (previousPassword === undefined) {
      delete process.env.HKCLAW_LITE_ADMIN_PASSWORD;
    } else {
      process.env.HKCLAW_LITE_ADMIN_PASSWORD = previousPassword;
    }
  }
});

test('admin server starts with login disabled when no initial password is configured', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousPassword = process.env.HKCLAW_LITE_ADMIN_PASSWORD;
  delete process.env.HKCLAW_LITE_ADMIN_PASSWORD;

  try {
    await withAdminServer(projectRoot, async ({ url, passwordEnv, authEnabled }) => {
      assert.equal(passwordEnv, 'HKCLAW_LITE_ADMIN_PASSWORD');
      assert.equal(authEnabled, false);

      const authStatus = await requestJson(`${url}/api/auth/status`);
      assert.equal(authStatus.response.status, 200);
      assert.equal(authStatus.payload.enabled, false);
      assert.equal(authStatus.payload.authenticated, true);

      const stateResponse = await requestJson(`${url}/api/state`);
      assert.equal(stateResponse.response.status, 200, JSON.stringify(stateResponse.payload));
      assert.equal(stateResponse.payload.projectRoot, projectRoot);
    });
  } finally {
    if (previousPassword === undefined) {
      delete process.env.HKCLAW_LITE_ADMIN_PASSWORD;
    } else {
      process.env.HKCLAW_LITE_ADMIN_PASSWORD = previousPassword;
    }
  }
});

test('admin password can be changed and old password stops working', async () => {
  const projectRoot = createProject();
  const passwordFile = path.join(projectRoot, '.admin-password');
  fs.writeFileSync(passwordFile, 'old-secret\n');
  initProject(projectRoot);

  await withAdminServer(
    projectRoot,
    async ({ url }) => {
      const login = await requestJson(`${url}/api/login`, {
        method: 'POST',
        body: {
          password: 'old-secret',
        },
      });
      assert.equal(login.response.status, 200, JSON.stringify(login.payload));
      const cookie = login.response.headers.get('set-cookie');

      const changed = await requestJson(`${url}/api/admin-password`, {
        method: 'PUT',
        headers: {
          cookie,
        },
        body: {
          currentPassword: 'old-secret',
          newPassword: 'new-secret-123',
        },
      });
      assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));

      const oldLogin = await requestJson(`${url}/api/login`, {
        method: 'POST',
        body: {
          password: 'old-secret',
        },
      });
      assert.equal(oldLogin.response.status, 401);

      const newLogin = await requestJson(`${url}/api/login`, {
        method: 'POST',
        body: {
          password: 'new-secret-123',
        },
      });
      assert.equal(newLogin.response.status, 200, JSON.stringify(newLogin.payload));
    },
    {
      passwordFile,
    },
  );

  await withAdminServer(projectRoot, async ({ url, authEnabled, authStorage }) => {
    assert.equal(authEnabled, true);
    assert.equal(authStorage, 'sqlite');

    const authStatus = await requestJson(`${url}/api/auth/status`);
    assert.equal(authStatus.response.status, 200);
    assert.equal(authStatus.payload.enabled, true);
    assert.equal(authStatus.payload.storage, 'sqlite');

    const relogin = await requestJson(`${url}/api/login`, {
      method: 'POST',
      body: {
        password: 'new-secret-123',
      },
    });
    assert.equal(relogin.response.status, 200, JSON.stringify(relogin.payload));
  });
});

test('admin auth migrates env bootstrap password into sqlite', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const previousPassword = process.env.HKCLAW_LITE_ADMIN_PASSWORD;
  process.env.HKCLAW_LITE_ADMIN_PASSWORD = 'migrate-me-123';

  try {
    await withAdminServer(projectRoot, async ({ authEnabled, authStorage }) => {
      assert.equal(authEnabled, true);
      assert.equal(authStorage, 'sqlite');
    });
  } finally {
    if (previousPassword === undefined) {
      delete process.env.HKCLAW_LITE_ADMIN_PASSWORD;
    } else {
      process.env.HKCLAW_LITE_ADMIN_PASSWORD = previousPassword;
    }
  }

  await withAdminServer(projectRoot, async ({ url, authEnabled, authStorage }) => {
    assert.equal(authEnabled, true);
    assert.equal(authStorage, 'sqlite');

    const login = await requestJson(`${url}/api/login`, {
      method: 'POST',
      body: {
        password: 'migrate-me-123',
      },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    assert.equal(login.payload.storage, 'sqlite');
  });
});

test('admin server supports agent auth status, login, and test call', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  const fakePackageJson = createFakeCodexBundle();
  await withEnv(
    {
      HKCLAW_LITE_CODEX_CLI_PACKAGE_JSON: fakePackageJson,
    },
    async () => {
      await withAdminServer(projectRoot, async ({ url }) => {
        const status = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'codex',
            action: 'status',
          },
        });
        assert.equal(status.response.status, 200, JSON.stringify(status.payload));
        assert.equal(status.payload.result.details.loggedIn, true);

        const login = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'codex',
            action: 'login',
          },
        });
        assert.equal(login.response.status, 200, JSON.stringify(login.payload));
        assert.match(login.payload.result.details.url, /example\.test/u);
        assert.doesNotMatch(login.payload.result.details.url, /\u001b/u);
        assert.equal(login.payload.result.details.code, 'CODE-12345');

        const testCall = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'codex',
            action: 'test',
            workdir: 'workspace',
            definition: {
              name: 'wizard-agent',
              agent: 'codex',
              sandbox: 'read-only',
            },
          },
        });
        assert.equal(testCall.response.status, 200, JSON.stringify(testCall.payload));
        assert.equal(testCall.payload.result.details.success, true);
        assert.match(testCall.payload.result.output, /OK/u);
        assert.deepEqual(testCall.payload.result.details.usage, {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 5,
        });
        assert.equal(testCall.payload.result.details.usageSummary.supported, true);
        assert.equal(testCall.payload.result.details.usageSummary.recordedEvents, 1);
        assert.equal(testCall.payload.result.details.usageSummary.totalTokens, 15);
      });
    },
  );
});

test('admin server strips benign Codex status warnings and detects not logged in correctly', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const fakePackageJson = createFakeCodexBundle();
  await withEnv(
    {
      HKCLAW_LITE_CODEX_CLI_PACKAGE_JSON: fakePackageJson,
      HKCLAW_LITE_TEST_CODEX_STATUS_OUTPUT: 'Not logged in',
      HKCLAW_LITE_TEST_CODEX_STATUS_WARNING:
        'WARNING: failed to clean up stale arg0 temp dirs: Directory not empty (os error 39)',
    },
    async () => {
      await withAdminServer(projectRoot, async ({ url }) => {
        const status = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'codex',
            action: 'status',
          },
        });
        assert.equal(status.response.status, 200, JSON.stringify(status.payload));
        assert.equal(status.payload.result.details.loggedIn, false);
        assert.equal(status.payload.result.details.summary, '로그인 안 됨');
        assert.doesNotMatch(status.payload.result.output, /failed to clean up stale arg0 temp dirs/u);
        assert.match(status.payload.result.output, /Not logged in/u);

        const snapshot = await requestJson(`${url}/api/ai-statuses`);
        assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.payload));
        assert.equal(snapshot.payload.statuses.codex.authResult.details.loggedIn, false);
        assert.match(snapshot.payload.statuses.codex.authResult.output, /Not logged in/u);
        assert.doesNotMatch(
          snapshot.payload.statuses.codex.authResult.output,
          /failed to clean up stale arg0 temp dirs/u,
        );
      });
    },
  );
});

test('admin server reports codex, Claude ACP, Gemini, and local LLM status details', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const config = loadConfig(projectRoot);
  config.localLlmConnections = {
    LLM1: {
      baseUrl: 'http://127.0.0.1:11434/v1',
    },
    LLM2: {
      baseUrl: 'http://127.0.0.1:22434/v1',
      apiKey: 'test-local-key',
    },
  };
  saveConfig(projectRoot, config);

  const fakeCodexPackageJson = createFakeCodexBundle();
  const fakeClaudePackageJson = createFakeClaudeAgentSdkBundle();
  const fakeGeminiBundle = createFakeGeminiBundle();
  await withEnv(
    {
      HKCLAW_LITE_CODEX_CLI_PACKAGE_JSON: fakeCodexPackageJson,
      HKCLAW_LITE_CLAUDE_AGENT_SDK_PACKAGE_JSON: fakeClaudePackageJson,
      HKCLAW_LITE_GEMINI_CLI_PACKAGE_JSON: fakeGeminiBundle.packageJsonPath,
      HKCLAW_LITE_TEST_GEMINI_HOME: fakeGeminiBundle.homeDir,
    },
    async () => {
      const geminiStateDir = path.join(fakeGeminiBundle.homeDir, '.gemini');
      fs.mkdirSync(geminiStateDir, { recursive: true });
      fs.writeFileSync(
        path.join(geminiStateDir, 'oauth_creds.json'),
        JSON.stringify({ access_token: 'ya29.cached', refresh_token: 'refresh-token' }),
      );
      fs.writeFileSync(
        path.join(geminiStateDir, 'google_accounts.json'),
        JSON.stringify({ email: 'gemini@example.test' }),
      );
      await withAdminServer(projectRoot, async ({ url }) => {
        const snapshot = await requestJson(`${url}/api/ai-statuses`);
        assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.payload));
        assert.equal(snapshot.payload.statuses.codex.authResult.details.loggedIn, true);
        assert.equal(snapshot.payload.statuses.codex.authResult.details.runtimePackageName, '@openai/codex');
        assert.equal(snapshot.payload.statuses.codex.authResult.details.runtimePackageVersion, '0.0.0-test');
        assert.equal(snapshot.payload.statuses['claude-code'].authResult.details.ready, true);
        assert.equal(snapshot.payload.statuses['claude-code'].authResult.details.loggedIn, true);
        assert.equal(snapshot.payload.statuses['claude-code'].authResult.details.authMethod, 'claudeai');
        assert.equal(snapshot.payload.statuses['claude-code'].authResult.details.runtimeSource, 'bundled');
        assert.equal(snapshot.payload.statuses['claude-code'].authResult.details.runtimePackageName, '@anthropic-ai/claude-agent-sdk');
        assert.equal(snapshot.payload.statuses['claude-code'].authResult.details.runtimePackageVersion, '0.0.0-test');
        assert.match(
          snapshot.payload.statuses['claude-code'].authResult.details.runtimeDetail,
          /@anthropic-ai\/claude-agent-sdk@0\.0\.0-test/u,
        );
        assert.equal('credentialKey' in snapshot.payload.statuses['claude-code'].authResult.details, false);
        assert.equal(snapshot.payload.statuses['gemini-cli'].authResult.details.ready, true);
        assert.equal(snapshot.payload.statuses['gemini-cli'].authResult.details.loggedIn, true);
        assert.equal(snapshot.payload.statuses['gemini-cli'].authResult.details.authMethod, 'google');
        assert.equal(snapshot.payload.statuses['gemini-cli'].authResult.details.runtimePackageName, '@google/gemini-cli');
        assert.equal(snapshot.payload.statuses['gemini-cli'].authResult.details.runtimePackageVersion, '0.0.0-test');
        assert.equal('credentialKey' in snapshot.payload.statuses['gemini-cli'].authResult.details, false);
        assert.equal(snapshot.payload.statuses['local-llm'].authResult.details.baseUrl, 'http://127.0.0.1:11434/v1');
        assert.equal(snapshot.payload.statuses['local-llm'].authResult.details.primaryConnection, 'LLM1');
        assert.equal(snapshot.payload.statuses['local-llm'].authResult.details.connections.length, 2);
        assert.deepEqual(
          snapshot.payload.statuses['local-llm'].authResult.details.connections.map((entry) => ({
            name: entry.name,
            baseUrl: entry.baseUrl,
            apiKeyConfigured: entry.apiKeyConfigured,
          })),
          [
            {
              name: 'LLM1',
              baseUrl: 'http://127.0.0.1:11434/v1',
              apiKeyConfigured: false,
            },
            {
              name: 'LLM2',
              baseUrl: 'http://127.0.0.1:22434/v1',
              apiKeyConfigured: true,
            },
          ],
        );
      });
    },
  );
});

test('admin server updates project-local bundled CLI overlays', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const fakeNpm = createFakeNpmForBundledCliUpdate();

  await withEnv({ HKCLAW_LITE_NPM_COMMAND: fakeNpm }, async () => {
    await withAdminServer(projectRoot, async ({ url }) => {
      const update = await requestJson(`${url}/api/bundled-cli-update`, {
        method: 'POST',
        body: {
          agentType: 'codex',
        },
      });

      assert.equal(update.response.status, 200, JSON.stringify(update.payload));
      assert.equal(update.payload.result.packages[0].packageName, '@openai/codex');
      assert.equal(update.payload.result.packages[0].installedVersion, '9.9.9-admin-test');
      assert.match(update.payload.result.overlayRoot, /\.hkclaw-lite\/bundled-clis/u);
      assert.equal(
        update.payload.statuses.codex.authResult.details.runtimePackageVersion,
        '9.9.9-admin-test',
      );
    });
  });
});

test('admin server keeps the Codex device login helper alive until browser auth completes', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const fakePackageJson = createFakeCodexBundle();
  const statusFile = path.join(projectRoot, 'codex-login-status.txt');
  await withEnv(
    {
      HKCLAW_LITE_CODEX_CLI_PACKAGE_JSON: fakePackageJson,
      HKCLAW_LITE_TEST_CODEX_STATUS_FILE: statusFile,
      HKCLAW_LITE_TEST_CODEX_LOGIN_DELAY_MS: '3000',
    },
    async () => {
      await withAdminServer(projectRoot, async ({ url }) => {
        const login = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'codex',
            action: 'login',
          },
        });
        assert.equal(login.response.status, 200, JSON.stringify(login.payload));
        assert.equal(login.payload.result.details.pendingLogin, true);
        assert.equal(fs.existsSync(statusFile), false);

        await new Promise((resolve) => setTimeout(resolve, 3_300));

        const status = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'codex',
            action: 'status',
          },
        });
        assert.equal(status.response.status, 200, JSON.stringify(status.payload));
        assert.equal(status.payload.result.details.loggedIn, true);
        assert.equal(status.payload.result.details.pendingLogin, false);
      });
    },
  );
});

test('admin server starts and completes Gemini CLI Google login flow through the bundled runtime', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const fakeGeminiBundle = createFakeGeminiBundle();
  const oauthRequests = [];

  await withJsonServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/oauth/token') {
      const body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
      oauthRequests.push(new URLSearchParams(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'ya29.test-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/userinfo') {
      assert.equal(req.headers.authorization, 'Bearer ya29.test-token');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        email: 'gemini@example.test',
        name: 'Gemini Test',
      }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not-found' }));
  }, async (oauthUrl) => {
    await withEnv(
      {
        HKCLAW_LITE_GEMINI_CLI_PACKAGE_JSON: fakeGeminiBundle.packageJsonPath,
        HKCLAW_LITE_TEST_GEMINI_HOME: fakeGeminiBundle.homeDir,
        HKCLAW_LITE_GEMINI_OAUTH_AUTH_URL: `${oauthUrl}/oauth/authorize`,
        HKCLAW_LITE_GEMINI_OAUTH_TOKEN_URL: `${oauthUrl}/oauth/token`,
        HKCLAW_LITE_GEMINI_OAUTH_USERINFO_URL: `${oauthUrl}/userinfo`,
      },
      async () => {
        await withAdminServer(projectRoot, async ({ url }) => {
          const statusBefore = await requestJson(`${url}/api/agent-auth`, {
            method: 'POST',
            body: {
              agentType: 'gemini-cli',
              action: 'status',
            },
          });
          assert.equal(statusBefore.response.status, 200, JSON.stringify(statusBefore.payload));
          assert.equal(statusBefore.payload.result.details.loggedIn, false);
          assert.equal(statusBefore.payload.result.details.ready, false);

          const login = await requestJson(`${url}/api/agent-auth`, {
            method: 'POST',
            body: {
              agentType: 'gemini-cli',
              action: 'login',
            },
          });
          assert.equal(login.response.status, 200, JSON.stringify(login.payload));
          assert.equal(login.payload.result.details.requiresCode, true);
          assert.match(login.payload.result.details.url, /oauth\/authorize/u);
          assert.match(login.payload.result.details.url, /redirect_uri=https%3A%2F%2Fcodeassist\.google\.com%2Fauthcode/u);
          assert.match(login.payload.result.details.url, /access_type=offline/u);
          assert.match(login.payload.result.details.url, /state=test-state/u);
          assert.match(login.payload.result.details.url, /code_challenge=test-code-challenge/u);
          assert.match(login.payload.result.output, /authorization code/u);

          const complete = await requestJson(`${url}/api/agent-auth`, {
            method: 'POST',
            body: {
              agentType: 'gemini-cli',
              action: 'complete-login',
              authorizationCode: 'google-auth-code-123',
            },
          });
          assert.equal(complete.response.status, 200, JSON.stringify(complete.payload));
          assert.equal(complete.payload.result.details.loggedIn, true);
          assert.equal(complete.payload.result.details.account.email, 'gemini@example.test');

          assert.equal(oauthRequests.length, 1);
          assert.equal(oauthRequests[0].get('code'), 'google-auth-code-123');
          assert.equal(oauthRequests[0].get('grant_type'), 'authorization_code');
          assert.equal(
            oauthRequests[0].get('redirect_uri'),
            'https://codeassist.google.com/authcode',
          );

          const credsPath = path.join(fakeGeminiBundle.homeDir, '.gemini', 'oauth_creds.json');
          const accountsPath = path.join(fakeGeminiBundle.homeDir, '.gemini', 'google_accounts.json');
          assert.equal(fs.existsSync(credsPath), true);
          assert.equal(fs.existsSync(accountsPath), true);
          const cachedCreds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
          assert.equal(cachedCreds.access_token, 'ya29.test-token');
          assert.equal(typeof cachedCreds.expiry_date, 'number');
          assert.equal(cachedCreds.expiry_date > Date.now(), true);

          const statusAfter = await requestJson(`${url}/api/agent-auth`, {
            method: 'POST',
            body: {
              agentType: 'gemini-cli',
              action: 'status',
            },
          });
          assert.equal(statusAfter.response.status, 200, JSON.stringify(statusAfter.payload));
          assert.equal(statusAfter.payload.result.details.loggedIn, true);
          assert.equal(statusAfter.payload.result.details.ready, true);
          assert.equal(statusAfter.payload.result.details.authMethod, 'google');
          assert.equal(statusAfter.payload.result.details.email, 'gemini@example.test');

          const testCall = await requestJson(`${url}/api/agent-auth`, {
            method: 'POST',
            body: {
              agentType: 'gemini-cli',
              action: 'test',
              workdir: '.',
              definition: {
                name: 'gemini-wizard',
                agent: 'gemini-cli',
              },
            },
          });
          assert.equal(testCall.response.status, 200, JSON.stringify(testCall.payload));
          assert.equal(testCall.payload.result.details.success, true);
          assert.match(testCall.payload.result.output, /OK/u);
          assert.deepEqual(testCall.payload.result.details.usage, {
            inputTokens: 6,
            outputTokens: 4,
            totalTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          });
          assert.equal(testCall.payload.result.details.usageSummary.recordedEvents, 1);
          assert.equal(testCall.payload.result.details.usageSummary.totalTokens, 10);

          const logout = await requestJson(`${url}/api/agent-auth`, {
            method: 'POST',
            body: {
              agentType: 'gemini-cli',
              action: 'logout',
            },
          });
          assert.equal(logout.response.status, 200, JSON.stringify(logout.payload));
          assert.equal(logout.payload.result.details.loggedIn, false);
          assert.equal(fs.existsSync(credsPath), false);
          assert.equal(fs.existsSync(accountsPath), false);

          const statusAfterLogout = await requestJson(`${url}/api/agent-auth`, {
            method: 'POST',
            body: {
              agentType: 'gemini-cli',
              action: 'status',
            },
          });
          assert.equal(statusAfterLogout.response.status, 200, JSON.stringify(statusAfterLogout.payload));
          assert.equal(statusAfterLogout.payload.result.details.loggedIn, false);
          assert.equal(statusAfterLogout.payload.result.details.ready, false);
        });
      },
    );
  });
});

test('admin server starts and completes Claude ACP login flow through the bundled sdk', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const fakePackageJson = createFakeClaudeAgentSdkBundle();

  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_AGENT_SDK_PACKAGE_JSON: fakePackageJson,
    },
    async () => {
      await withAdminServer(projectRoot, async ({ url }) => {
        const login = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'claude-code',
            action: 'login',
            options: {
              loginMode: 'console',
            },
          },
        });
        assert.equal(login.response.status, 200, JSON.stringify(login.payload));
        assert.equal(login.payload.result.details.summary, '브라우저에서 로그인을 완료하세요.');
        assert.equal(login.payload.result.details.requiresCode, true);
        assert.equal(login.payload.result.details.url, 'https://console.example.test/oauth/manual?state=console-flow');
        assert.equal(login.payload.result.details.manualUrl, 'https://console.example.test/oauth/manual?state=console-flow');
        assert.equal(login.payload.result.details.automaticUrl, 'http://localhost:4455/callback?mode=console&state=console-flow');

        const complete = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'claude-code',
            action: 'complete-login',
            callbackUrl:
              'http://localhost:4455/callback?code=test-code&state=console-flow',
          },
        });
        assert.equal(complete.response.status, 200, JSON.stringify(complete.payload));
        assert.equal(complete.payload.result.details.loggedIn, true);
        assert.equal(complete.payload.result.details.account.email, 'dev@example.test');
        assert.equal(complete.payload.result.details.account.organization, 'Console Org');
      });
    },
  );
});

test('admin server accepts a Claude callback URL pasted into the callbackUrl field', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const fakePackageJson = createFakeClaudeAgentSdkBundle();

  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_AGENT_SDK_PACKAGE_JSON: fakePackageJson,
    },
    async () => {
      await withAdminServer(projectRoot, async ({ url }) => {
        const login = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'claude-code',
            action: 'login',
            options: {
              loginMode: 'claudeai',
            },
          },
        });
        assert.equal(login.response.status, 200, JSON.stringify(login.payload));

        const complete = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'claude-code',
            action: 'complete-login',
            callbackUrl:
              'http://localhost:4455/callback?code=callback-code-123&state=claudeai-flow',
          },
        });
        assert.equal(complete.response.status, 200, JSON.stringify(complete.payload));
        assert.equal(complete.payload.result.details.loggedIn, true);
        assert.equal(complete.payload.result.details.account.email, 'dev@example.test');
        assert.equal(complete.payload.result.details.account.organization, 'Claude Org');
        assert.equal(complete.payload.result.details.account.code, 'callback-code-123');
        assert.equal(complete.payload.result.details.account.state, 'claudeai-flow');
      });
    },
  );
});

test('admin server reports external Claude CLI status and terminal-login guidance when configured', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const fakePackageJson = createFakeClaudeAgentSdkBundle();
  const fakeCliPath = resolveFakeClaudeCliPath(fakePackageJson);

  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_CLI: fakeCliPath,
    },
    async () => {
      await withAdminServer(projectRoot, async ({ url }) => {
        const status = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'claude-code',
            action: 'status',
          },
        });
        assert.equal(status.response.status, 200, JSON.stringify(status.payload));
        assert.equal(status.payload.result.details.runtimeReady, true);
        assert.equal(status.payload.result.details.loggedIn, true);
        assert.equal(status.payload.result.details.ready, true);
        assert.equal(status.payload.result.details.sharedLogin, true);
        assert.equal(status.payload.result.details.externalCli, true);
        assert.equal(status.payload.result.details.runtimeSource, 'external');
        assert.match(status.payload.result.details.runtimeDetail, /external Claude CLI/u);

        const login = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'claude-code',
            action: 'login',
            options: {
              loginMode: 'claudeai',
            },
          },
        });
        assert.equal(login.response.status, 200, JSON.stringify(login.payload));
        assert.equal(login.payload.result.details.summary, '외부 Claude CLI 로그인은 터미널에서 진행하세요.');
        assert.equal(login.payload.result.details.externalCli, true);
        assert.equal(login.payload.result.details.requiresCode, false);
        assert.equal(login.payload.result.details.runtimeSource, 'external');
        assert.match(login.payload.result.command, /auth login --claudeai/u);

        const complete = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'claude-code',
            action: 'complete-login',
          },
        });
        assert.equal(complete.response.status, 200, JSON.stringify(complete.payload));
        assert.equal(complete.payload.result.details.summary, '외부 Claude CLI는 상태 확인만 하면 됩니다.');
        assert.equal(complete.payload.result.details.externalCli, true);
        assert.equal(complete.payload.result.details.runtimeSource, 'external');
      });
    },
  );
});

test('admin server runs claude test calls through the bundled cli stream-json runtime', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  const fakePackageJson = createFakeClaudeAgentSdkBundle();
  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_AGENT_SDK_PACKAGE_JSON: fakePackageJson,
    },
    async () => {
      await withAdminServer(projectRoot, async ({ url }) => {
        const testCall = await requestJson(`${url}/api/agent-auth`, {
          method: 'POST',
          body: {
            agentType: 'claude-code',
            action: 'test',
            workdir: 'workspace',
            definition: {
              name: 'wizard-agent',
              agent: 'claude-code',
              permissionMode: 'acceptEdits',
            },
          },
        });
        assert.equal(testCall.response.status, 200, JSON.stringify(testCall.payload));
        assert.equal(testCall.payload.result.details.success, true);
        assert.match(testCall.payload.result.output, /OK:acceptEdits/u);
        assert.deepEqual(testCall.payload.result.details.usage, {
          inputTokens: 13,
          outputTokens: 9,
          totalTokens: 22,
          cacheCreationInputTokens: 4,
          cacheReadInputTokens: 1,
        });
        assert.equal(testCall.payload.result.details.usageSummary.recordedEvents, 1);
        assert.equal(testCall.payload.result.details.usageSummary.totalTokens, 22);
      });
    },
  );
});

test('admin server can reset stored Claude channel runtime sessions', async () => {
  const projectRoot = createProject();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'claude-code',
    model: 'claude-sonnet-4-6',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    mode: 'single',
    discordChannelId: '123456789012345678',
    workspace: 'workspace',
    agent: 'owner',
  });
  saveConfig(projectRoot, config);

  const fakePackageJson = createFakeClaudeAgentSdkBundle();
  await withEnv(
    {
      HKCLAW_LITE_CLAUDE_AGENT_SDK_PACKAGE_JSON: fakePackageJson,
    },
    async () => {
      await withAdminServer(projectRoot, async ({ url }) => {
        const runResponse = await requestJson(`${url}/api/run`, {
          method: 'POST',
          body: {
            channelName: 'main',
            prompt: 'hello from admin',
          },
        });
        assert.equal(runResponse.response.status, 200, JSON.stringify(runResponse.payload));

        const stateBefore = await requestJson(`${url}/api/state`);
        assert.equal(stateBefore.response.status, 200, JSON.stringify(stateBefore.payload));
        const channelBefore = stateBefore.payload.channels.find((entry) => entry.name === 'main');
        assert.equal(channelBefore.runtime.sessions.length, 1);
        assert.equal(channelBefore.runtime.sessions[0].runtimeBackend, 'claude-cli');

        const resetResponse = await requestJson(
          `${url}/api/channels/${encodeURIComponent('main')}/runtime-sessions`,
          {
            method: 'DELETE',
          },
        );
        assert.equal(resetResponse.response.status, 200, JSON.stringify(resetResponse.payload));
        const channelAfter = resetResponse.payload.state.channels.find((entry) => entry.name === 'main');
        assert.deepEqual(channelAfter.runtime.sessions, []);
      });
    },
  );
});

test('admin server can reset stored Claude channel runtime sessions by role', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.agents.owner = buildAgentDefinition(projectRoot, 'owner', {
    name: 'owner',
    agent: 'claude-code',
  });
  config.agents.reviewer = buildAgentDefinition(projectRoot, 'reviewer', {
    name: 'reviewer',
    agent: 'claude-code',
  });
  config.agents.arbiter = buildAgentDefinition(projectRoot, 'arbiter', {
    name: 'arbiter',
    agent: 'claude-code',
  });
  config.channels.main = buildChannelDefinition(projectRoot, config, 'main', {
    name: 'main',
    mode: 'tribunal',
    discordChannelId: '123456789012345678',
    workspace: 'workspace',
    agent: 'owner',
    reviewer: 'reviewer',
    arbiter: 'arbiter',
  });
  saveConfig(projectRoot, config);
  const channel = getChannel(config, 'main');

  await recordRuntimeRoleSession(projectRoot, {
    channel,
    runId: 'owner-run',
    entry: {
      role: 'owner',
      agent: config.agents.owner,
      mode: 'tribunal',
      final: true,
      runtimeBackend: 'claude-cli',
      runtimeSessionId: 'owner-session',
    },
  });
  await recordRuntimeRoleSession(projectRoot, {
    channel,
    runId: 'reviewer-run',
    entry: {
      role: 'reviewer',
      agent: config.agents.reviewer,
      mode: 'tribunal',
      final: true,
      verdict: 'approved',
      runtimeBackend: 'claude-cli',
      runtimeSessionId: 'reviewer-session',
    },
  });

  await withAdminServer(projectRoot, async ({ url }) => {
    const stateBefore = await requestJson(`${url}/api/state`);
    assert.equal(stateBefore.response.status, 200, JSON.stringify(stateBefore.payload));
    const channelBefore = stateBefore.payload.channels.find((entry) => entry.name === 'main');
    assert.deepEqual(
      channelBefore.runtime.sessions.map((entry) => entry.role).sort(),
      ['owner', 'reviewer'],
    );

    const resetOwner = await requestJson(
      `${url}/api/channels/${encodeURIComponent('main')}/runtime-sessions?role=owner`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(resetOwner.response.status, 200, JSON.stringify(resetOwner.payload));
    const channelAfterOwnerReset = resetOwner.payload.state.channels.find(
      (entry) => entry.name === 'main',
    );
    assert.deepEqual(
      channelAfterOwnerReset.runtime.sessions.map((entry) => entry.role),
      ['reviewer'],
    );

    const invalidReset = await requestJson(
      `${url}/api/channels/${encodeURIComponent('main')}/runtime-sessions?role=member`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(invalidReset.response.status, 400);
    assert.match(invalidReset.payload.error, /owner, reviewer, or arbiter/u);
  });
});

test('admin server uses the selected local LLM connection for test calls', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  const config = loadConfig(projectRoot);
  config.localLlmConnections = {
    LLM1: {
      baseUrl: 'http://127.0.0.1:11434/v1',
    },
    LLM2: {
      baseUrl: 'http://127.0.0.1:22434/v1',
      apiKey: 'local-secret',
    },
  };
  saveConfig(projectRoot, config);

  await withJsonServer((request, response) => {
    if (request.url === '/v1/chat/completions') {
      assert.equal(request.headers.host?.startsWith('127.0.0.1:'), true);
      assert.equal(request.headers.authorization, 'Bearer local-secret');
      response.writeHead(200, {
        'content-type': 'application/json',
      });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'OK',
              },
            },
          ],
          usage: {
            prompt_tokens: 17,
            completion_tokens: 8,
            total_tokens: 25,
          },
        }),
      );
      return;
    }

    response.writeHead(404, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify({ error: 'Not found' }));
  }, async (localLlmUrl) => {
    await withAdminServer(projectRoot, async ({ url }) => {
      const saveConnections = await requestJson(`${url}/api/local-llm-connections`, {
        method: 'PUT',
        body: {
          connections: [
            {
              name: 'LLM1',
              baseUrl: 'http://127.0.0.1:11434/v1',
            },
            {
              name: 'LLM2',
              baseUrl: `${localLlmUrl}/v1`,
              apiKey: 'local-secret',
            },
          ],
        },
      });
      assert.equal(saveConnections.response.status, 200, JSON.stringify(saveConnections.payload));
      assert.deepEqual(
        saveConnections.payload.state.localLlmConnections.map((entry) => ({
          name: entry.name,
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
        })),
        [
          {
            name: 'LLM1',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: undefined,
          },
          {
            name: 'LLM2',
            baseUrl: `${localLlmUrl}/v1`,
            apiKey: 'local-secret',
          },
        ],
      );

      const testCall = await requestJson(`${url}/api/agent-auth`, {
        method: 'POST',
        body: {
          agentType: 'local-llm',
          action: 'test',
          workdir: 'workspace',
          definition: {
            name: 'wizard-agent',
            agent: 'local-llm',
            model: 'qwen2.5-coder:14b',
            localLlmConnection: 'LLM2',
          },
        },
      });
      assert.equal(testCall.response.status, 200, JSON.stringify(testCall.payload));
      assert.equal(testCall.payload.result.details.success, true);
      assert.match(testCall.payload.result.output, /OK/u);
      assert.deepEqual(testCall.payload.result.details.usage, {
        inputTokens: 17,
        outputTokens: 8,
        totalTokens: 25,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      });
      assert.equal(testCall.payload.result.details.usageSummary.recordedEvents, 1);
      assert.equal(testCall.payload.result.details.usageSummary.totalTokens, 25);

      const snapshot = await requestJson(`${url}/api/ai-statuses`);
      assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.payload));
      assert.equal(snapshot.payload.statuses['local-llm'].usageSummary.recordedEvents, 1);
      assert.equal(snapshot.payload.statuses['local-llm'].usageSummary.totalTokens, 25);
      assert.equal(snapshot.payload.statuses['local-llm'].authResult.details.connections.length, 2);
      assert.equal(snapshot.payload.statuses.codex.usageSummary.supported, true);
    });
  });
});

test('admin server lists model options for provider APIs and curated Claude ACP defaults', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const previousEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };

  try {
    await withJsonServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify({
            data: [
              { id: 'gpt-5.4', created: 30 },
              { id: 'gpt-image-1', created: 31 },
              { id: 'gpt-5.3-codex', created: 40 },
            ],
          }),
        );
        return;
      }
      response.writeHead(404, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ error: 'Not found' }));
    }, async (openAiUrl) => {
      await withJsonServer((request, response) => {
            if (request.url === '/v1/models') {
              response.writeHead(200, {
                'content-type': 'application/json',
              });
              response.end(
                JSON.stringify({
                  data: [
                    { id: 'llama3.1:8b' },
                    { id: 'qwen2.5-coder:14b' },
                  ],
                }),
              );
              return;
            }

            response.writeHead(404, {
              'content-type': 'application/json',
            });
            response.end(JSON.stringify({ error: 'Not found' }));
      }, async (modelServerUrl) => {
          process.env.OPENAI_API_KEY = 'test-openai-key';
          process.env.OPENAI_BASE_URL = `${openAiUrl}/v1`;

          await withAdminServer(projectRoot, async ({ url }) => {
            const codex = await requestJson(`${url}/api/agent-models`, {
              method: 'POST',
              body: {
                agentType: 'codex',
              },
            });
            assert.equal(codex.response.status, 200, JSON.stringify(codex.payload));
            assert.equal(codex.payload.result.source, 'live');
            assert.deepEqual(
              codex.payload.result.models.map((entry) => entry.value),
              ['gpt-5.3-codex', 'gpt-5.4'],
            );
            assert.equal(codex.payload.result.defaultModel, 'gpt-5.4');
            assert.deepEqual(codex.payload.result.models[0].efforts, ['low', 'medium', 'high', 'xhigh']);

            const claude = await requestJson(`${url}/api/agent-models`, {
              method: 'POST',
              body: {
                agentType: 'claude-code',
              },
            });
            assert.equal(claude.response.status, 200, JSON.stringify(claude.payload));
            assert.equal(claude.payload.result.source, 'curated');
            assert.deepEqual(
              claude.payload.result.models.map((entry) => entry.value),
              ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
            );
            assert.equal(claude.payload.result.defaultModel, 'claude-sonnet-4-6');
            assert.deepEqual(claude.payload.result.models[0].efforts, [
              'low',
              'medium',
              'high',
              'xhigh',
              'max',
            ]);

            const gemini = await requestJson(`${url}/api/agent-models`, {
              method: 'POST',
              body: {
                agentType: 'gemini-cli',
              },
            });
            assert.equal(gemini.response.status, 200, JSON.stringify(gemini.payload));
            assert.equal(gemini.payload.result.source, 'curated');
            assert.deepEqual(
              gemini.payload.result.models.map((entry) => entry.value),
              ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-flash-preview'],
            );
            assert.deepEqual(gemini.payload.result.models[1].efforts, ['none', 'minimal', 'low', 'medium', 'high']);

            const live = await requestJson(`${url}/api/agent-models`, {
              method: 'POST',
              body: {
                agentType: 'local-llm',
                baseUrl: `${modelServerUrl}/v1`,
              },
            });
            assert.equal(live.response.status, 200, JSON.stringify(live.payload));
            assert.equal(live.payload.result.source, 'live');
            assert.deepEqual(
              live.payload.result.models.map((entry) => entry.value),
              ['llama3.1:8b', 'qwen2.5-coder:14b'],
            );
          });
      });
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('admin server falls back to curated Codex models when live lookup is unavailable', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const previousEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };

  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;

    await withAdminServer(projectRoot, async ({ url }) => {
      const codex = await requestJson(`${url}/api/agent-models`, {
        method: 'POST',
        body: {
          agentType: 'codex',
        },
      });
      assert.equal(codex.response.status, 200, JSON.stringify(codex.payload));
      assert.equal(codex.payload.result.source, 'curated');
      assert.equal(codex.payload.result.defaultModel, 'gpt-5.4');
      assert.deepEqual(
        codex.payload.result.models.map((entry) => entry.value),
        ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.4-mini'],
      );
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('admin server exposes a 90-day token usage dashboard snapshot', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const now = new Date();
  const withinWindow = new Date(now);
  withinWindow.setUTCDate(now.getUTCDate() - 20);
  const outsideWindow = new Date(now);
  outsideWindow.setUTCDate(now.getUTCDate() - 120);

  await recordRuntimeUsageEvent(projectRoot, {
    agentType: 'claude-code',
    agentName: 'owner',
    usage: {
      inputTokens: 100,
      outputTokens: 60,
      totalTokens: 160,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
    },
    recordedAt: now.toISOString(),
  });
  await recordRuntimeUsageEvent(projectRoot, {
    agentType: 'local-llm',
    agentName: 'local-1',
    usage: {
      inputTokens: 30,
      outputTokens: 15,
      totalTokens: 45,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    recordedAt: withinWindow.toISOString(),
  });
  await recordRuntimeUsageEvent(projectRoot, {
    agentType: 'gemini-cli',
    agentName: 'old-one',
    usage: {
      inputTokens: 999,
      outputTokens: 1,
      totalTokens: 1000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    recordedAt: outsideWindow.toISOString(),
  });

  await withAdminServer(projectRoot, async ({ url }) => {
    const snapshot = await requestJson(`${url}/api/state`);
    assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.payload));

    const tokenUsage = snapshot.payload.tokenUsage;
    assert.equal(tokenUsage.windowDays, 90);
    assert.equal(tokenUsage.totals.totalTokens, 205);
    assert.equal(tokenUsage.totals.inputTokens, 130);
    assert.equal(tokenUsage.totals.outputTokens, 75);
    assert.equal(tokenUsage.totals.recordedEvents, 2);
    assert.equal(tokenUsage.totals.activeDays, 2);
    assert.equal(tokenUsage.byAgentType.length, 2);
    assert.deepEqual(
      tokenUsage.byAgentType.map((entry) => ({
        agentType: entry.agentType,
        totalTokens: entry.totalTokens,
      })),
      [
        { agentType: 'claude-code', totalTokens: 160 },
        { agentType: 'local-llm', totalTokens: 45 },
      ],
    );
    assert.equal(
      tokenUsage.activeDaily.some((entry) => entry.totalTokens === 1000),
      false,
    );
  });
});
