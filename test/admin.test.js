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

function createFakeCodexBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-admin-bin-'));
  const codexPath = path.join(binDir, 'codex');
  fs.writeFileSync(
    codexPath,
    `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "login" && "\${2:-}" == "status" ]]; then
  echo "logged in"
  exit 0
fi
if [[ "\${1:-}" == "login" && "\${2:-}" == "--device-auth" ]]; then
  printf 'Open https://example.test/codex/device\\033[0m and enter CODE-12345\\n'
  exit 0
fi
if [[ "\${1:-}" == "logout" ]]; then
  echo "logged out"
  exit 0
fi
if [[ "\${1:-}" == "exec" ]]; then
  output_file=""
  while [[ $# -gt 0 ]]; do
    if [[ "\${1:-}" == "-o" ]]; then
      output_file="\${2:-}"
      shift 2
      continue
    fi
    shift
  done
  cat >/dev/null
  if [[ -n "$output_file" ]]; then
    printf 'OK\\n' > "$output_file"
  fi
  printf 'OK\\n'
  exit 0
fi
echo "unexpected args: $*" >&2
exit 1
`,
    { mode: 0o755 },
  );
  return binDir;
}

function createFakeClaudeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-admin-claude-bin-'));
  const claudePath = path.join(binDir, 'claude');
  fs.writeFileSync(
    claudePath,
    `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "auth" && "\${2:-}" == "status" ]]; then
  printf '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\\n'
  exit 1
fi
if [[ "\${1:-}" == "auth" && "\${2:-}" == "login" && $# -eq 2 ]]; then
  echo "Opening browser to sign in…"
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true"
  exit 0
fi
if [[ "\${1:-}" == "auth" && "\${2:-}" == "logout" ]]; then
  echo "logged out"
  exit 0
fi
echo "unexpected args: $*" >&2
exit 1
`,
    { mode: 0o755 },
  );
  return binDir;
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

  const fakeBinDir = createFakeCodexBin();
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath || ''}`;

  try {
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
  } finally {
    process.env.PATH = previousPath;
  }
});

test('admin server restores AI auth statuses from local CLI state', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const fakeCodexBin = createFakeCodexBin();
  const fakeClaudeBin = createFakeClaudeBin();
  const previousPath = process.env.PATH;
  process.env.PATH = [fakeCodexBin, fakeClaudeBin, previousPath || ''].join(path.delimiter);

  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const snapshot = await requestJson(`${url}/api/ai-statuses`);
      assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.payload));
      assert.equal(snapshot.payload.statuses.codex.authResult.details.loggedIn, true);
      assert.equal(snapshot.payload.statuses['claude-code'].authResult.details.loggedIn, false);
    });
  } finally {
    process.env.PATH = previousPath;
  }
});

test('admin server uses default claude login flow', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const fakeBinDir = createFakeClaudeBin();
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath || ''}`;

  try {
    await withAdminServer(projectRoot, async ({ url }) => {
      const status = await requestJson(`${url}/api/agent-auth`, {
        method: 'POST',
        body: {
          agentType: 'claude-code',
          action: 'status',
        },
      });
      assert.equal(status.response.status, 200, JSON.stringify(status.payload));
      assert.equal(status.payload.result.details.loggedIn, false);

      const login = await requestJson(`${url}/api/agent-auth`, {
        method: 'POST',
        body: {
          agentType: 'claude-code',
          action: 'login',
        },
      });
      assert.equal(login.response.status, 200, JSON.stringify(login.payload));
      assert.match(login.payload.result.details.url, /claude\.com\/cai\/oauth/u);
      assert.doesNotMatch(login.payload.result.command, /--console/u);
    });
  } finally {
    process.env.PATH = previousPath;
  }
});

test('admin server lists live model options for provider APIs', async () => {
  const projectRoot = createProject();
  initProject(projectRoot);

  const previousEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
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
        if (request.url === '/v1/models') {
          response.writeHead(200, {
            'content-type': 'application/json',
          });
          response.end(
            JSON.stringify({
              data: [
                {
                  id: 'claude-sonnet-4-20250514',
                  display_name: 'Claude Sonnet 4',
                  created_at: '2026-04-01T00:00:00Z',
                },
                {
                  id: 'claude-opus-4-1-20250805',
                  display_name: 'Claude Opus 4.1',
                  created_at: '2026-04-02T00:00:00Z',
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
      }, async (anthropicUrl) => {
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
            process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
            process.env.ANTHROPIC_BASE_URL = anthropicUrl;
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
              assert.equal(claude.payload.result.source, 'live');
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
