import fs from 'node:fs';

import { getCiWatcherLogPath, listCiWatchers, loadCiWatcher } from './ci-watch-store.js';
import {
  AGENT_TYPE_CHOICES,
  CLAUDE_PERMISSION_MODE_CHOICES,
  CHANNEL_MODE_CHOICES,
  CODEX_SANDBOX_CHOICES,
  DASHBOARD_ALL_AGENTS,
} from './constants.js';
import {
  buildDiscordServiceSnapshot,
  inspectDiscordRoleTokens,
} from './discord-runtime-state.js';
import { inspectAgentRuntime } from './runners.js';
import {
  listPendingRuntimeOutboxEvents,
  listRecentRuntimeRuns,
  listRuntimeRoleSessions,
} from './runtime-db.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  buildDashboardDefinition,
  getAgent,
  getChannel,
  getDashboard,
  listAgents,
  listChannels,
  listDashboards,
  loadConfig,
  removeAgent,
  removeChannel,
  removeDashboard,
  saveConfig,
} from './store.js';
import { assert, isPlainObject } from './utils.js';

export async function buildAdminSnapshot(projectRoot) {
  const config = loadConfig(projectRoot);
  const channels = listChannels(config);
  const dashboards = listDashboards(config);
  const agents = buildAgentSummaries(projectRoot, config, channels);
  const discord = buildDiscordStatus(projectRoot, channels);
  const watchers = listCiWatchers(projectRoot).map((watcher) => ({
    ...watcher,
    hasLog: watcher.logPath
      ? fs.existsSync(getCiWatcherLogPath(projectRoot, watcher.id))
      : false,
  }));
  const runtime = await buildRuntimeStatus(projectRoot, channels);

  return {
    projectRoot,
    configVersion: config.version,
    defaults: config.defaults,
    sharedEnv: config.sharedEnv || {},
    agents,
    channels: runtime.channels,
    dashboards,
    discord,
    watchers,
    runtime: runtime.summary,
    choices: {
      agentTypes: AGENT_TYPE_CHOICES,
      channelModes: CHANNEL_MODE_CHOICES,
      codexSandboxes: CODEX_SANDBOX_CHOICES,
      claudePermissionModes: CLAUDE_PERMISSION_MODE_CHOICES,
      dashboardAllAgents: DASHBOARD_ALL_AGENTS,
    },
  };
}

function buildDiscordStatus(projectRoot, channels) {
  const tribunalChannelCount = channels.filter(isTribunalChannel).length;
  const service = buildDiscordServiceSnapshot(projectRoot);
  const tokenStatus = inspectDiscordRoleTokens(projectRoot, {
    requireReviewerAndArbiter: tribunalChannelCount > 0,
    runtimeStatus: service,
  });

  return {
    envFilePath: tokenStatus.envFilePath,
    tribunalChannelCount,
    singleChannelCount: channels.length - tribunalChannelCount,
    tokens: tokenStatus.roles,
    service,
  };
}

export async function upsertAgent(projectRoot, currentName, input) {
  const config = loadConfig(projectRoot);
  const existing = currentName ? getAgent(config, currentName) : null;
  const nextName = String(input?.name || '').trim();

  assert(nextName, 'Agent name is required.');

  if (currentName) {
    if (nextName !== currentName) {
      assert(!config.agents[nextName], `Agent "${nextName}" already exists.`);
      renameAgentReferences(config, currentName, nextName);
      delete config.agents[currentName];
    }
  } else {
    assert(!config.agents[nextName], `Agent "${nextName}" already exists.`);
  }

  config.agents[nextName] = buildAgentDefinition(
    projectRoot,
    nextName,
    input,
    config.agents[nextName] || existing || {},
  );
  saveConfig(projectRoot, config);
  return await buildAdminSnapshot(projectRoot);
}

export async function deleteAgentByName(projectRoot, name) {
  const config = loadConfig(projectRoot);
  getAgent(config, name);

  const blockingChannels = listChannels(config)
    .filter(
      (channel) =>
        channel.agent === name ||
        channel.reviewer === name ||
        channel.arbiter === name,
    )
    .map((channel) => channel.name);
  const blockingDashboards = listDashboards(config)
    .filter(
      (dashboard) =>
        !dashboard.monitors.includes(DASHBOARD_ALL_AGENTS) &&
        dashboard.monitors.includes(name),
    )
    .map((dashboard) => dashboard.name);
  const blockingAgents = listAgents(config)
    .filter((agent) => agent.fallbackAgent === name)
    .map((agent) => agent.name);

  assert(
    blockingDashboards.length === 0 &&
      blockingChannels.length === 0 &&
      blockingAgents.length === 0,
    `Agent "${name}" is referenced by ${[
      blockingDashboards.length > 0
        ? `dashboards: ${blockingDashboards.join(', ')}`
        : null,
      blockingChannels.length > 0 ? `channels: ${blockingChannels.join(', ')}` : null,
      blockingAgents.length > 0 ? `fallback agents: ${blockingAgents.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' | ')}.`,
  );

  removeAgent(config, name);
  saveConfig(projectRoot, config);
  return await buildAdminSnapshot(projectRoot);
}

export async function upsertChannel(projectRoot, currentName, input) {
  const config = loadConfig(projectRoot);
  const existing = currentName ? getChannel(config, currentName) : null;
  const nextName = String(input?.name || '').trim();

  assert(nextName, 'Channel name is required.');

  if (currentName) {
    if (nextName !== currentName) {
      assert(!config.channels[nextName], `Channel "${nextName}" already exists.`);
      delete config.channels[currentName];
    }
  } else {
    assert(!config.channels[nextName], `Channel "${nextName}" already exists.`);
  }

  config.channels[nextName] = buildChannelDefinition(
    projectRoot,
    config,
    nextName,
    input,
    config.channels[nextName] || existing || {},
  );
  saveConfig(projectRoot, config);
  return await buildAdminSnapshot(projectRoot);
}

export async function deleteChannelByName(projectRoot, name) {
  const config = loadConfig(projectRoot);
  getChannel(config, name);
  removeChannel(config, name);
  saveConfig(projectRoot, config);
  return await buildAdminSnapshot(projectRoot);
}

export async function upsertDashboard(projectRoot, currentName, input) {
  const config = loadConfig(projectRoot);
  const existing = currentName ? getDashboard(config, currentName) : null;
  const nextName = String(input?.name || '').trim();

  assert(nextName, 'Dashboard name is required.');

  if (currentName) {
    if (nextName !== currentName) {
      assert(!config.dashboards[nextName], `Dashboard "${nextName}" already exists.`);
      delete config.dashboards[currentName];
    }
  } else {
    assert(!config.dashboards[nextName], `Dashboard "${nextName}" already exists.`);
  }

  config.dashboards[nextName] = buildDashboardDefinition(
    projectRoot,
    nextName,
    input,
    config,
    config.dashboards[nextName] || existing || {},
  );
  saveConfig(projectRoot, config);
  return await buildAdminSnapshot(projectRoot);
}

export async function deleteDashboardByName(projectRoot, name) {
  const config = loadConfig(projectRoot);
  getDashboard(config, name);
  removeDashboard(config, name);
  saveConfig(projectRoot, config);
  return await buildAdminSnapshot(projectRoot);
}

export async function replaceSharedEnv(projectRoot, sharedEnv) {
  validateSharedEnvInput(sharedEnv);
  const config = loadConfig(projectRoot);
  config.sharedEnv = sortEnvEntries(sharedEnv);
  saveConfig(projectRoot, config);
  return await buildAdminSnapshot(projectRoot);
}

export function readWatcherLog(projectRoot, watcherId) {
  const watcher = loadCiWatcher(projectRoot, watcherId);
  if (!watcher.logPath) {
    return '';
  }
  const logPath = getCiWatcherLogPath(projectRoot, watcherId);
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

function buildAgentSummaries(projectRoot, config, channels) {
  const channelsByAgent = buildChannelsByAgent(channels);
  return listAgents(config).map((agent) => {
    const mappedChannels = channelsByAgent[agent.name] || [];
    return {
      ...agent,
      runtime: inspectAgentRuntime(projectRoot, agent),
      mappedChannels: mappedChannels.map((channel) => ({
        name: channel.name,
        role: resolveAgentRole(channel, agent.name),
        workspace: channel.workspace,
      })),
      mappedChannelNames: unique(mappedChannels.map((channel) => channel.name)),
      workspaces: unique(mappedChannels.map((channel) => channel.workspace).filter(Boolean)),
    };
  });
}

function buildChannelsByAgent(channels) {
  const output = {};
  for (const channel of channels) {
    for (const agentName of [channel.agent, channel.reviewer, channel.arbiter].filter(Boolean)) {
      output[agentName] = output[agentName] || [];
      output[agentName].push(channel);
    }
  }
  return output;
}

function resolveAgentRole(channel, agentName) {
  if (channel.agent === agentName) {
    return 'owner';
  }
  if (channel.reviewer === agentName) {
    return 'reviewer';
  }
  if (channel.arbiter === agentName) {
    return 'arbiter';
  }
  return 'member';
}

function isTribunalChannel(channel) {
  if (!channel) {
    return false;
  }
  return channel.mode === 'tribunal' || Boolean(channel.reviewer && channel.arbiter);
}

async function buildRuntimeStatus(projectRoot, channels) {
  const [recentRuns, pendingOutboxEvents, roleSessions] = await Promise.all([
    listRecentRuntimeRuns(projectRoot, { limit: 100 }),
    listPendingRuntimeOutboxEvents(projectRoot, { limit: 500 }),
    listRuntimeRoleSessions(projectRoot, { limit: 500 }),
  ]);

  const lastRunByChannel = new Map();
  for (const run of recentRuns) {
    if (!run.channelName || lastRunByChannel.has(run.channelName)) {
      continue;
    }
    lastRunByChannel.set(run.channelName, {
      runId: run.runId,
      status: run.status,
      activeRole: run.activeRole,
      currentRound: run.currentRound,
      maxRounds: run.maxRounds,
      reviewerVerdict: run.reviewerVerdict,
      finalDisposition: run.finalDisposition,
      resultRole: run.resultRole,
      resultAgent: run.resultAgent,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      error: run.error,
    });
  }

  const outboxCountByChannel = new Map();
  for (const event of pendingOutboxEvents) {
    const key = event.channelName || '';
    outboxCountByChannel.set(key, (outboxCountByChannel.get(key) || 0) + 1);
  }

  const sessionsByChannel = new Map();
  for (const session of roleSessions) {
    const key = session.channelName || '';
    const list = sessionsByChannel.get(key) || [];
    list.push({
      role: session.role,
      agentName: session.agentName,
      runCount: session.runCount,
      sessionPolicy: session.sessionPolicy,
      lastStatus: session.lastStatus,
      lastVerdict: session.lastVerdict,
    });
    sessionsByChannel.set(key, list);
  }

  return {
    channels: channels.map((channel) => ({
      ...channel,
      runtime: {
        lastRun: lastRunByChannel.get(channel.name) || null,
        pendingOutboxCount: outboxCountByChannel.get(channel.name) || 0,
        sessions: sessionsByChannel.get(channel.name) || [],
      },
    })),
    summary: {
      pendingOutboxCount: pendingOutboxEvents.length,
      recentRuns: recentRuns.slice(0, 20),
    },
  };
}

function renameAgentReferences(config, currentName, nextName) {
  for (const dashboard of Object.values(config.dashboards)) {
    if (dashboard.monitors?.includes?.(currentName)) {
      dashboard.monitors = dashboard.monitors.map((entry) =>
        entry === currentName ? nextName : entry,
      );
    }
  }

  for (const channel of Object.values(config.channels)) {
    if (channel.agent === currentName) {
      channel.agent = nextName;
    }
    if (channel.reviewer === currentName) {
      channel.reviewer = nextName;
    }
    if (channel.arbiter === currentName) {
      channel.arbiter = nextName;
    }
  }

  for (const agent of Object.values(config.agents)) {
    if (agent.fallbackAgent === currentName) {
      agent.fallbackAgent = nextName;
    }
  }
}

function validateSharedEnvInput(sharedEnv) {
  assert(isPlainObject(sharedEnv), 'sharedEnv must be an object.');
  for (const [key, value] of Object.entries(sharedEnv)) {
    assert(typeof key === 'string' && key.trim().length > 0, 'Env key cannot be empty.');
    assert(typeof value === 'string', `Env value must be a string for "${key}".`);
  }
}

function sortEnvEntries(sharedEnv) {
  return Object.fromEntries(
    Object.entries(sharedEnv).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function unique(values) {
  return [...new Set(values)];
}
