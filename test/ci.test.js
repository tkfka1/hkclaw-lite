import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { loadCiWatcher } from '../src/ci-watch-store.js';
import { initProject } from '../src/store.js';

async function runCli(args, options = {}) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;

  if (options.env) {
    Object.assign(process.env, options.env);
  }

  console.log = (...values) => {
    stdout.push(values.join(' '));
  };
  console.error = (...values) => {
    stderr.push(values.join(' '));
  };
  process.exitCode = 0;

  try {
    await main(args);
    return {
      status: process.exitCode || 0,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  }
}

function createProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-ci-test-'));
}

async function withCwd(nextCwd, callback) {
  const originalCwd = process.cwd();
  process.chdir(nextCwd);
  try {
    return await callback();
  } finally {
    process.chdir(originalCwd);
  }
}

async function waitFor(check, timeoutMs = 4000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function withJsonServer(handler, callback) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: error.message }));
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await callback(baseUrl);
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

test('ci check github prints completed run details', async () => {
  await withJsonServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');

    if (url.pathname === '/repos/acme/demo/actions/runs/42') {
      response.end(
        JSON.stringify({
          status: 'completed',
          conclusion: 'failure',
          name: 'CI',
          head_branch: 'main',
          html_url: 'https://github.example/acme/demo/actions/runs/42',
        }),
      );
      return;
    }

    if (url.pathname === '/repos/acme/demo/actions/runs/42/jobs') {
      response.end(
        JSON.stringify({
          jobs: [
            { name: 'build', conclusion: 'success' },
            { name: 'test', conclusion: 'failure' },
          ],
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  }, async (baseUrl) => {
    const result = await runCli([
      'ci',
      'check',
      'github',
      '--repo',
      'acme/demo',
      '--run-id',
      '42',
      '--base-url',
      baseUrl,
      '--target',
      'PR #7',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CI 완료: PR #7/u);
    assert.match(result.stdout, /판정: 실패/u);
    assert.match(result.stdout, /실패 job: test/u);
  });
});

test('container publish workflow builds amd64 and arm64 images', () => {
  const workflow = fs.readFileSync(path.resolve('.github/workflows/container-publish.yml'), 'utf8');
  const dockerfile = fs.readFileSync(path.resolve('Dockerfile'), 'utf8');
  const readme = fs.readFileSync(path.resolve('README.md'), 'utf8');

  assert.match(workflow, /docker\/setup-qemu-action@/u);
  assert.match(workflow, /docker\/setup-buildx-action@/u);
  assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/u);
  assert.match(workflow, /id:\s*build/u);
  assert.match(workflow, /GITOPS_REPOSITORY:\s*git@gitlab\.com:hkyo\/infra\/helm\/infra-values\.git/u);
  assert.match(workflow, /GITOPS_VALUES_FILE:\s*hkclaw-lite\/values-idc\.yaml/u);
  assert.match(workflow, /IMAGE_DIGEST:\s*\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}/u);
  assert.match(workflow, /git push origin HEAD:main/u);
  assert.match(dockerfile, /ARG TARGETARCH/u);
  assert.match(dockerfile, /case "\$\{arch\}" in amd64\|arm64\)/u);
  assert.match(readme, /GITOPS_DEPLOY_KEY/u);
  assert.match(readme, /ArgoCD가 GitOps desired state로 배포/u);
});

test('ci watch gitlab polls until pipeline completes', async () => {
  let pipelineChecks = 0;

  await withJsonServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');

    if (url.pathname === '/api/v4/projects/group%2Fproject/pipelines/55') {
      pipelineChecks += 1;
      response.end(
        JSON.stringify(
          pipelineChecks === 1
            ? {
                status: 'running',
              }
            : {
                status: 'success',
                name: 'release',
                ref: 'main',
                web_url: 'https://gitlab.example/group/project/-/pipelines/55',
              },
        ),
      );
      return;
    }

    if (url.pathname === '/api/v4/projects/group%2Fproject/pipelines/55/jobs') {
      response.end(
        JSON.stringify([
          { name: 'build', status: 'success' },
          { name: 'deploy', status: 'success' },
        ]),
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  }, async (baseUrl) => {
    const result = await runCli([
      'ci',
      'watch',
      'gitlab',
      '--project',
      'group/project',
      '--pipeline-id',
      '55',
      '--base-url',
      baseUrl,
      '--target',
      'release pipeline',
      '--interval-ms',
      '1',
      '--timeout-ms',
      '1000',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[attempt 1\] GitLab pipeline 55 is running/u);
    assert.match(result.stdout, /\[attempt 2\] 성공: group\/project pipeline 55/u);
    assert.match(result.stdout, /CI 완료: release pipeline/u);
    assert.equal(pipelineChecks, 2);
  });
});

test('ci check uses the explicit token flag', async () => {
  const cwd = createProject();
  initProject(cwd);

  await withJsonServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');

    if (url.pathname === '/api/v4/projects/group%2Fproject/pipelines/66') {
      assert.equal(request.headers['private-token'], 'explicit-gitlab-token');
      response.end(
        JSON.stringify({
          status: 'success',
          name: 'release',
          ref: 'main',
        }),
      );
      return;
    }

    if (url.pathname === '/api/v4/projects/group%2Fproject/pipelines/66/jobs') {
      assert.equal(request.headers['private-token'], 'explicit-gitlab-token');
      response.end(JSON.stringify([]));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  }, async (baseUrl) => {
    const result = await runCli([
      '--root',
      cwd,
      'ci',
      'check',
      'gitlab',
      '--project',
      'group/project',
      '--pipeline-id',
      '66',
      '--token',
      'explicit-gitlab-token',
      '--base-url',
      baseUrl,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /판정: 성공/u);
  });
});

test('ci list requires existing watcher state root', async () => {
  const cwd = createProject();

  await withCwd(cwd, async () => {
    const result = await runCli(['ci', 'list']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No CI watcher state found/u);
  });

  assert.equal(fs.existsSync(path.join(cwd, '.hkclaw-lite')), false);
});

test('background ci watcher completes and persists result', async () => {
  const cwd = createProject();
  initProject(cwd);

  let pipelineChecks = 0;

  await withJsonServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');

    if (url.pathname === '/api/v4/projects/group%2Fproject/pipelines/77') {
      pipelineChecks += 1;
      response.end(
        JSON.stringify(
          pipelineChecks === 1
            ? { status: 'running' }
            : {
                status: 'success',
                name: 'release',
                ref: 'main',
                web_url: 'https://gitlab.example/group/project/-/pipelines/77',
              },
        ),
      );
      return;
    }

    if (url.pathname === '/api/v4/projects/group%2Fproject/pipelines/77/jobs') {
      response.end(JSON.stringify([{ name: 'build', status: 'success' }]));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  }, async (baseUrl) => {
    const start = await runCli([
      '--root',
      cwd,
      'ci',
      'watch',
      'gitlab',
      '--project',
      'group/project',
      '--pipeline-id',
      '77',
      '--base-url',
      baseUrl,
      '--interval-ms',
      '1',
      '--timeout-ms',
      '2000',
      '--background',
    ]);

    assert.equal(start.status, 0, start.stderr);
    const watcherId = start.stdout.match(/Started CI watcher "([^"]+)"/u)?.[1];
    assert.ok(watcherId, start.stdout);

    const watcher = await waitFor(() => {
      const current = loadCiWatcher(cwd, watcherId);
      return current.status === 'completed' ? current : null;
    });

    assert.match(watcher.resultSummary, /성공/u);
    assert.match(watcher.completionMessage, /CI 완료:/u);
  });
});

test('background ci watcher keeps explicit token out of persisted watcher state', async () => {
  const cwd = createProject();
  initProject(cwd);

  let pipelineChecks = 0;

  await withJsonServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');

    if (url.pathname === '/api/v4/projects/group%2Fproject/pipelines/78') {
      pipelineChecks += 1;
      assert.equal(request.headers['private-token'], 'explicit-gitlab-token');
      response.end(
        JSON.stringify(
          pipelineChecks === 1
            ? { status: 'running' }
            : { status: 'success' },
        ),
      );
      return;
    }

    if (url.pathname === '/api/v4/projects/group%2Fproject/pipelines/78/jobs') {
      assert.equal(request.headers['private-token'], 'explicit-gitlab-token');
      response.end(JSON.stringify([]));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  }, async (baseUrl) => {
    const start = await runCli([
      '--root',
      cwd,
      'ci',
      'watch',
      'gitlab',
      '--project',
      'group/project',
      '--pipeline-id',
      '78',
      '--base-url',
      baseUrl,
      '--token',
      'explicit-gitlab-token',
      '--interval-ms',
      '1',
      '--timeout-ms',
      '2000',
      '--background',
    ]);

    assert.equal(start.status, 0, start.stderr);
    const watcherId = start.stdout.match(/Started CI watcher "([^"]+)"/u)?.[1];
    assert.ok(watcherId, start.stdout);

    const watcher = await waitFor(() => {
      const current = loadCiWatcher(cwd, watcherId);
      return current.status === 'completed' ? current : null;
    });

    assert.equal(watcher.request.token, undefined);
  });
});

test('background ci watcher can be listed, shown, and stopped', async () => {
  const cwd = createProject();
  initProject(cwd);

  await withJsonServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');

    if (url.pathname === '/api/v4/projects/group%2Fproject/pipelines/88') {
      response.end(JSON.stringify({ status: 'running' }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  }, async (baseUrl) => {
    const start = await runCli([
      '--root',
      cwd,
      'ci',
      'watch',
      'gitlab',
      '--project',
      'group/project',
      '--pipeline-id',
      '88',
      '--base-url',
      baseUrl,
      '--interval-ms',
      '50',
      '--timeout-ms',
      '5000',
      '--background',
    ]);

    assert.equal(start.status, 0, start.stderr);
    const watcherId = start.stdout.match(/Started CI watcher "([^"]+)"/u)?.[1];
    assert.ok(watcherId, start.stdout);

    await waitFor(() => {
      const current = loadCiWatcher(cwd, watcherId);
      return current.status === 'running' && current.attempts >= 1 ? current : null;
    });

    const list = await runCli(['--root', cwd, 'ci', 'list']);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, new RegExp(watcherId, 'u'));
    assert.match(list.stdout, /status=running/u);

    const showBeforeStop = await runCli(['--root', cwd, 'ci', 'show', watcherId]);
    assert.equal(showBeforeStop.status, 0, showBeforeStop.stderr);
    assert.match(showBeforeStop.stdout, new RegExp(`watcher=${watcherId}`, 'u'));

    const stop = await runCli(['--root', cwd, 'ci', 'stop', watcherId]);
    assert.equal(stop.status, 0, stop.stderr);

    const stopped = await waitFor(() => {
      const current = loadCiWatcher(cwd, watcherId);
      return current.status === 'stopped' ? current : null;
    });

    assert.ok(stopped.stoppedAt);

    const showAfterStop = await runCli(['--root', cwd, 'ci', 'show', watcherId]);
    assert.equal(showAfterStop.status, 0, showAfterStop.stderr);
    assert.match(showAfterStop.stdout, /status=stopped/u);
  });
});
