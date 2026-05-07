import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeNextRunAt,
  runDueSchedulesOnce,
  upsertSchedule,
} from '../src/scheduler.js';
import {
  claimRuntimeSchedule,
  getRuntimeSchedule,
  listRuntimeScheduleRuns,
} from '../src/runtime-db.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  createDefaultConfig,
  initProject,
  saveConfig,
} from '../src/store.js';

const repoRoot = process.cwd();
const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'echo-assistant.mjs');

function createProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-scheduler-test-'));
}

function createScheduledProject() {
  const projectRoot = createProject();
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
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
  return projectRoot;
}

test('interval schedules claim once, execute through channel runtime, and move nextRunAt forward', async () => {
  const projectRoot = createScheduledProject();
  const dueAt = new Date(Date.now() - 60_000).toISOString();

  const leaseSchedule = await upsertSchedule(projectRoot, null, {
    name: 'lease-job',
    channelName: 'main',
    every: '10m',
    prompt: 'lease only',
    nextRunAt: dueAt,
  });
  const leaseA = await claimRuntimeSchedule(projectRoot, leaseSchedule.scheduleId, {
    leaseOwner: 'owner-a',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    now: new Date().toISOString(),
    dueOnly: true,
  });
  assert.equal(leaseA.name, 'lease-job');

  const leaseB = await claimRuntimeSchedule(projectRoot, leaseSchedule.scheduleId, {
    leaseOwner: 'owner-b',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    now: new Date().toISOString(),
    dueOnly: true,
  });
  assert.equal(leaseB, null);

  const schedule = await upsertSchedule(projectRoot, null, {
    name: 'heartbeat',
    channelName: 'main',
    every: '10m',
    prompt: 'scheduled ping',
    nextRunAt: dueAt,
  });

  assert.equal(schedule.enabled, true);
  assert.equal(schedule.intervalMs, 10 * 60 * 1000);
  assert.equal(schedule.nextRunAt, dueAt);

  const results = await runDueSchedulesOnce(projectRoot, {
    now: new Date(),
    leaseOwner: 'test-worker',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].scheduleName, 'heartbeat');
  assert.equal(results[0].status, 'completed');
  assert.match(results[0].result.content, /SCHEDULED PING/u);

  const updated = await getRuntimeSchedule(projectRoot, 'heartbeat');
  assert.equal(updated.lastStatus, 'completed');
  assert.ok(new Date(updated.nextRunAt).getTime() > Date.now());

  const runs = await listRuntimeScheduleRuns(projectRoot, {
    scheduleName: 'heartbeat',
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].runtimeRunId, results[0].runtimeRunId);
});

test('disabled due schedules are skipped by the automatic worker', async () => {
  const projectRoot = createScheduledProject();
  await upsertSchedule(projectRoot, null, {
    name: 'disabled-job',
    enabled: false,
    channelName: 'main',
    every: '1m',
    prompt: 'do not run',
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const results = await runDueSchedulesOnce(projectRoot, {
    now: new Date(),
    leaseOwner: 'test-worker',
  });
  assert.deepEqual(results, []);

  const schedule = await getRuntimeSchedule(projectRoot, 'disabled-job');
  assert.equal(schedule.lastStatus, null);
});

test('daily schedules compute timezone-aware next run times', () => {
  assert.equal(
    computeNextRunAt(
      {
        scheduleType: 'daily',
        timeOfDay: '09:00',
        timezone: 'Asia/Seoul',
      },
      {
        after: new Date('2026-05-07T00:01:00.000Z'),
      },
    ),
    '2026-05-08T00:00:00.000Z',
  );
});
