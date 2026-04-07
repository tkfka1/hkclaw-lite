import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startAdminServer } from '../src/admin.js';
import { getCiWatcherLogPath, saveCiWatcher } from '../src/ci-watch-store.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  buildDashboardDefinition,
  createDefaultConfig,
  initProject,
  loadConfig,
  saveConfig,
} from '../src/store.js';

const repoRoot = process.cwd();
const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'echo-assistant.mjs');

function createProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-admin-test-'));
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
      workdir: 'workspace',
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

    const { response, payload } = await requestJson(`${url}/api/state`);
    assert.equal(response.status, 200);
    assert.equal(payload.projectRoot, projectRoot);
    assert.equal(payload.agents.length, 1);
    assert.equal(payload.channels.length, 1);
    assert.equal(payload.dashboards.length, 1);
    assert.equal(payload.watchers.length, 1);
    assert.equal(payload.agents[0].runtime.ready, true);
    assert.deepEqual(payload.agents[0].mappedChannelNames, ['main']);

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
          workdir: 'workspace',
          agent: 'worker',
        },
      },
    });
    assert.equal(
      channelResponse.response.status,
      200,
      JSON.stringify(channelResponse.payload),
    );

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
      const cookie = login.response.headers.get('set-cookie');
      assert.match(cookie, /hkclaw_lite_admin_session=/u);

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
      assert.equal(fs.readFileSync(passwordFile, 'utf8').trim(), 'new-secret-123');

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
});
