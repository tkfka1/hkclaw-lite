import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startAdminServer } from '../src/admin.js';
import { executeChannelTurn } from '../src/channel-runtime.js';
import { getCiWatcherLogPath, saveCiWatcher } from '../src/ci-watch-store.js';
import { writeDiscordServiceStatus } from '../src/discord-runtime-state.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  buildDashboardDefinition,
  createDefaultConfig,
  getChannel,
  initProject,
  loadConfig,
  saveConfig,
} from '../src/store.js';

const repoRoot = process.cwd();
const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'echo-assistant.mjs');

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
  process.stdout.write('logged in\\n');
  process.exit(0);
}

if (args[0] === 'login' && args[1] === '--device-auth') {
  process.stdout.write('Welcome to Codex [v0.120.0]\\n');
  process.stdout.write('Follow these steps to sign in with ChatGPT using device code authorization:\\n\\n');
  process.stdout.write('1. Open this link in your browser and sign in to your account\\n');
  process.stdout.write('   https://example.test/codex/device\\u001b[0m\\n\\n');
  process.stdout.write('2. Enter this one-time code (expires in 15 minutes)\\n');
  process.stdout.write('   CODE-12345\\n');
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
    process.stdout.write('OK\\n');
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
      completionResolve?.({
        account: {
          email: 'dev@example.test',
          organization: state === 'console-flow' ? 'Console Org' : 'Claude Org',
          code,
          state,
        },
      });
    },
    async claudeOAuthWaitForCompletion() {
      return await completionPromise;
    },
    async accountInfo() {
      return {
        email: 'dev@example.test',
        organization: 'Console Org',
      };
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

process.stderr.write(\`unexpected args: \${args.join(' ')}\\n\`);
process.exit(1);
`,
    { mode: 0o755 },
  );
  return path.join(packageDir, 'package.json');
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
  process.stdout.write(JSON.stringify({ text: 'OK' }));
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

test('admin server exposes project snapshot and watcher logs', async () => {
  const projectRoot = createProject();
  const workspacePath = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  initProject(projectRoot);

  const config = createDefaultConfig();
  config.sharedEnv = {
    GITHUB_TOKEN: 'admin-gh',
  };
  config.agents.worker = buildAgentDefinition(projectRoot, 'worker', {
    name: 'worker',
    agent: 'command',
    command: `node ${fixturePath}`,
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
  fs.writeFileSync(path.join(projectRoot, '.env'), 'OWNER_BOT_TOKEN=owner-token\n');
  writeDiscordServiceStatus(projectRoot, {
    version: 1,
    projectRoot,
    pid: process.pid,
    running: true,
    startedAt: '2026-04-07T00:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
    roles: {
      owner: {
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
    assert.match(html, /hkclaw-lite/i);
    assert.match(html, /\/favicon\.svg/u);

    const faviconResponse = await fetch(`${url}/favicon.ico`);
    const favicon = await faviconResponse.text();
    assert.equal(faviconResponse.status, 200);
    assert.match(faviconResponse.headers.get('content-type') || '', /image\/svg\+xml/u);
    assert.match(favicon, /<svg/u);

    const faviconHeadResponse = await fetch(`${url}/favicon.ico`, {
      method: 'HEAD',
    });
    assert.equal(faviconHeadResponse.status, 200);
    assert.match(faviconHeadResponse.headers.get('content-type') || '', /image\/svg\+xml/u);

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
    assert.equal(payload.discord.service.state, 'running');
    assert.equal(payload.discord.tokens.owner.configured, true);
    assert.equal(payload.discord.tokens.owner.required, true);
    assert.equal(payload.discord.tokens.reviewer.required, false);
    assert.equal(payload.discord.service.roles.owner.tag, 'owner#0001');
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

    const envResponse = await requestJson(`${url}/api/shared-env`, {
      method: 'PUT',
      body: {
        sharedEnv: {
          GITLAB_TOKEN: 'admin-gl',
        },
      },
    });
    assert.equal(envResponse.response.status, 200, JSON.stringify(envResponse.payload));

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

    const deleteChannel = await requestJson(
      `${url}/api/channels/${encodeURIComponent('discord-main')}`,
      {
        method: 'DELETE',
      },
    );
    assert.equal(deleteChannel.response.status, 200, JSON.stringify(deleteChannel.payload));

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
  assert.deepEqual(config.sharedEnv, { GITLAB_TOKEN: 'admin-gl' });
  assert.equal(config.channels['discord-main'], undefined);
  assert.equal(config.agents.worker, undefined);
  assert.equal(config.dashboards.ops, undefined);
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
      assert.match(cookie, /Max-Age=604800/u);

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
      });
    },
  );
});

test('admin server reports codex, Claude ACP, Gemini, and local LLM status details', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);
  const config = loadConfig(projectRoot);
  config.sharedEnv = {
    GEMINI_API_KEY: 'test-gemini-key',
    LOCAL_LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
    LOCAL_LLM_API_KEY: 'test-local-key',
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
      await withAdminServer(projectRoot, async ({ url }) => {
        const snapshot = await requestJson(`${url}/api/ai-statuses`);
        assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.payload));
        assert.equal(snapshot.payload.statuses.codex.authResult.details.loggedIn, true);
        assert.equal(snapshot.payload.statuses['claude-code'].authResult.details.ready, true);
        assert.equal(snapshot.payload.statuses['claude-code'].authResult.details.loggedIn, true);
        assert.equal(snapshot.payload.statuses['claude-code'].authResult.details.authMethod, 'claudeai');
        assert.equal('credentialKey' in snapshot.payload.statuses['claude-code'].authResult.details, false);
        assert.equal(snapshot.payload.statuses['gemini-cli'].authResult.details.ready, true);
        assert.equal(snapshot.payload.statuses['gemini-cli'].authResult.details.credentialKey, 'GEMINI_API_KEY');
        assert.equal(snapshot.payload.statuses['local-llm'].authResult.details.baseUrl, 'http://127.0.0.1:11434/v1');
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
        expiry_date: Date.now() + 3_600_000,
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
            authorizationCode: 'test-code',
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

test('admin server runs claude test calls through the bundled agent sdk', async () => {
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
      });
    },
  );
});

test('admin server uses shared env credentials for local LLM test calls', async () => {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  initProject(projectRoot);

  const config = loadConfig(projectRoot);
  config.sharedEnv = {
    LOCAL_LLM_API_KEY: 'local-secret',
  };
  saveConfig(projectRoot, config);

  await withJsonServer((request, response) => {
    if (request.url === '/v1/chat/completions') {
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
            baseUrl: `${localLlmUrl}/v1`,
          },
        },
      });
      assert.equal(testCall.response.status, 200, JSON.stringify(testCall.payload));
      assert.equal(testCall.payload.result.details.success, true);
      assert.match(testCall.payload.result.output, /OK/u);
    });
  });
});

test('admin server lists model options for provider APIs and curated Claude ACP defaults', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const previousEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
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
          if (request.url === '/models') {
            response.writeHead(200, {
              'content-type': 'application/json',
            });
            response.end(
              JSON.stringify({
                data: [
                  { id: 'gemini-2.5-flash', created: 10 },
                  { id: 'gemini-2.5-flash-image', created: 20 },
                  { id: 'gemini-3-flash-preview', created: 30 },
                ],
              }),
            );
            return;
          }
            response.writeHead(404, {
              'content-type': 'application/json',
            });
            response.end(JSON.stringify({ error: 'Not found' }));
      }, async (geminiUrl) => {
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
          process.env.GEMINI_API_KEY = 'test-gemini-key';
          process.env.GEMINI_BASE_URL = geminiUrl;

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
              ['claude-opus-4-1-20250805', 'claude-sonnet-4-20250514'],
            );
            assert.deepEqual(claude.payload.result.models[0].efforts, ['low', 'medium', 'high', 'max']);

            const gemini = await requestJson(`${url}/api/agent-models`, {
              method: 'POST',
              body: {
                agentType: 'gemini-cli',
              },
            });
            assert.equal(gemini.response.status, 200, JSON.stringify(gemini.payload));
            assert.equal(gemini.payload.result.source, 'live');
            assert.deepEqual(
              gemini.payload.result.models.map((entry) => entry.value),
              ['gemini-3-flash-preview', 'gemini-2.5-flash'],
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
