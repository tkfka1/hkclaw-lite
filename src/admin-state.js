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
  inspectDiscordBotConfigs,
} from './discord-runtime-state.js';
import { inspectAgentRuntime } from './runners.js';
import {
  listPendingRuntimeOutboxEvents,
  listRecentRuntimeRuns,
  listRuntimeRoleSessions,
  listRuntimeUsageBreakdown,
  listRuntimeUsageHistory,
  clearRuntimeRoleSessions,
} from './runtime-db.js';
import {
  buildAgentDefinition,
  buildBotDefinition,
  buildChannelDefinition,
  buildDashboardDefinition,
  buildLocalLlmConnectionDefinition,
  getDefaultChannelWorkspace,
  getAgent,
  getBot,
  getChannel,
  getDashboard,
  listAgents,
  listBots,
  listChannels,
  listDashboards,
  listLocalLlmConnections,
  loadConfig,
  removeAgent,
  removeBot,
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
  const bots = buildBotSummaries(config, channels);
  const discord = buildDiscordStatus(projectRoot, config, channels);
  const tokenUsage = await buildTokenUsageSnapshot(projectRoot);
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
    defaults: {
      ...config.defaults,
      channelWorkspace: getDefaultChannelWorkspace(),
    },
    sharedEnv: config.sharedEnv || {},
    localLlmConnections: listLocalLlmConnections(config),
    agents,
    bots,
    channels: runtime.channels,
    dashboards,
    discord,
    tokenUsage,
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

async function buildTokenUsageSnapshot(projectRoot, { windowDays = 90 } = {}) {
  const normalizedWindowDays =
    Number.isInteger(windowDays) && windowDays > 0 ? windowDays : 90;
  const rows = await listRuntimeUsageHistory(projectRoot, {
    days: normalizedWindowDays,
  });
  const [byAgentName, byModel] = await Promise.all([
    listRuntimeUsageBreakdown(projectRoot, {
      days: normalizedWindowDays,
      field: 'agentName',
    }),
    listRuntimeUsageBreakdown(projectRoot, {
      days: normalizedWindowDays,
      field: 'model',
    }),
  ]);

  const dailyMap = new Map();
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  for (let offset = normalizedWindowDays - 1; offset >= 0; offset -= 1) {
    const current = new Date(now);
    current.setUTCDate(now.getUTCDate() - offset);
    const date = current.toISOString().slice(0, 10);
    dailyMap.set(date, createUsageAggregate(date));
  }

  const byAgentTypeMap = new Map();
  for (const row of rows) {
    const daily = dailyMap.get(row.date) || createUsageAggregate(row.date);
    mergeUsageAggregate(daily, row);
    dailyMap.set(row.date, daily);

    const currentAgent =
      byAgentTypeMap.get(row.agentType) || createUsageAggregate(row.agentType);
    mergeUsageAggregate(currentAgent, row);
    byAgentTypeMap.set(row.agentType, currentAgent);
  }

  const daily = Array.from(dailyMap.values());
  const activeDays = daily.filter((entry) => entry.recordedEvents > 0);
  const monthlyMap = new Map();
  for (const entry of activeDays) {
    const monthKey = String(entry.date || '').slice(0, 7);
    const monthly = monthlyMap.get(monthKey) || createUsageAggregate(monthKey);
    mergeUsageAggregate(monthly, entry);
    monthlyMap.set(monthKey, monthly);
  }

  const totals = createUsageAggregate('total');
  for (const entry of activeDays) {
    mergeUsageAggregate(totals, entry);
  }

  return {
    windowDays: normalizedWindowDays,
    since: daily[0]?.date || null,
    until: daily.at(-1)?.date || null,
    totals: {
      ...totals,
      activeDays: activeDays.length,
    },
    byAgentType: Array.from(byAgentTypeMap.entries())
      .map(([agentType, aggregate]) => ({
        agentType,
        ...aggregate,
      }))
      .sort((left, right) => right.totalTokens - left.totalTokens),
    byAgentName: byAgentName.sort((left, right) => right.totalTokens - left.totalTokens),
    byModel: byModel.sort((left, right) => right.totalTokens - left.totalTokens),
    daily,
    activeDaily: activeDays.slice().reverse(),
    monthly: Array.from(monthlyMap.values()).sort((left, right) =>
      String(left.date).localeCompare(String(right.date)),
    ),
  };
}

function createUsageAggregate(date) {
  return {
    date,
    recordedEvents: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    lastRecordedAt: null,
  };
}

function mergeUsageAggregate(target, source) {
  target.recordedEvents += Number(source?.recordedEvents || 0);
  target.inputTokens += Number(source?.inputTokens || 0);
  target.outputTokens += Number(source?.outputTokens || 0);
  target.totalTokens += Number(source?.totalTokens || 0);
  target.cacheCreationInputTokens += Number(source?.cacheCreationInputTokens || 0);
  target.cacheReadInputTokens += Number(source?.cacheReadInputTokens || 0);
  if (source?.lastRecordedAt && (!target.lastRecordedAt || source.lastRecordedAt > target.lastRecordedAt)) {
    target.lastRecordedAt = source.lastRecordedAt;
  }
}

function buildDiscordStatus(projectRoot, config, channels) {
  const tribunalChannelCount = channels.filter(isTribunalChannel).length;
  const service = buildDiscordServiceSnapshot(projectRoot);
  const tokenStatus = inspectDiscordBotConfigs(config, channels, service);

  return {
    envFilePath: service.envFilePath,
    tribunalChannelCount,
    singleChannelCount: channels.length - tribunalChannelCount,
    bots: tokenStatus.bots,
    service,
    agentServices: service.agentServices || {},
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
  const blockingBots = listBots(config)
    .filter((bot) => bot.agent === name)
    .map((bot) => bot.name);

  assert(
    blockingDashboards.length === 0 &&
      blockingChannels.length === 0 &&
      blockingAgents.length === 0 &&
      blockingBots.length === 0,
    `Agent "${name}" is referenced by ${[
      blockingDashboards.length > 0
        ? `dashboards: ${blockingDashboards.join(', ')}`
        : null,
      blockingChannels.length > 0 ? `channels: ${blockingChannels.join(', ')}` : null,
      blockingAgents.length > 0 ? `fallback agents: ${blockingAgents.join(', ')}` : null,
      blockingBots.length > 0 ? `bots: ${blockingBots.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' | ')}.`,
  );

  removeAgent(config, name);
  saveConfig(projectRoot, config);
  return await buildAdminSnapshot(projectRoot);
}

export async function upsertBot(projectRoot, currentName, input) {
  const config = loadConfig(projectRoot);
  const existing = currentName ? getBot(config, currentName) : null;
  const nextName = String(input?.name || '').trim();

  assert(nextName, 'Bot name is required.');

  if (currentName) {
    if (nextName !== currentName) {
      assert(!config.bots[nextName], `Bot "${nextName}" already exists.`);
      renameBotReferences(config, currentName, nextName);
      delete config.bots[currentName];
    }
  } else {
    assert(!config.bots[nextName], `Bot "${nextName}" already exists.`);
  }

  const previousAgentName = existing?.agent || null;
  config.bots[nextName] = buildBotDefinition(
    config,
    nextName,
    input,
    config.bots[nextName] || existing || {},
  );
  if (previousAgentName !== config.bots[nextName].agent) {
    syncChannelAgentsForBot(config, nextName);
  }
  saveConfig(projectRoot, config);
  return await buildAdminSnapshot(projectRoot);
}

export async function deleteBotByName(projectRoot, name) {
  const config = loadConfig(projectRoot);
  getBot(config, name);

  const blockingChannels = listChannels(config)
    .filter(
      (channel) =>
        channel.bot === name ||
        channel.reviewerBot === name ||
        channel.arbiterBot === name,
    )
    .map((channel) => channel.name);

  assert(
    blockingChannels.length === 0,
    `Bot "${name}" is referenced by channels: ${blockingChannels.join(', ')}.`,
  );

  removeBot(config, name);
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
  await clearRuntimeRoleSessions(projectRoot, { channelName: name });
  return await buildAdminSnapshot(projectRoot);
}

export async function resetChannelRuntimeSessionsByName(projectRoot, name) {
  const config = loadConfig(projectRoot);
  getChannel(config, name);
  await clearRuntimeRoleSessions(projectRoot, {
    channelName: name,
    runtimeBackend: 'claude-cli',
  });
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

export async function replaceLocalLlmConnections(projectRoot, connections) {
  assert(Array.isArray(connections), 'connections must be an array.');
  const config = loadConfig(projectRoot);
  const seenNames = new Set();
  const nextConnections = Object.fromEntries(
    connections.map((entry) => {
      const name = String(entry?.name || '').trim();
      assert(name, 'Local LLM connection name is required.');
      assert(!seenNames.has(name), `Local LLM connection "${name}" already exists.`);
      seenNames.add(name);
      return [
        name,
        buildLocalLlmConnectionDefinition(name, entry, config.localLlmConnections?.[name] || {}),
      ];
    }),
  );
  assert(Object.keys(nextConnections).length > 0, 'At least one local LLM connection is required.');
  config.localLlmConnections = nextConnections;
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
  const discordService = buildDiscordServiceSnapshot(projectRoot);
  const discordRuntimeBots = discordService.bots || {};
  const agentServices = discordService.agentServices || {};
  return listAgents(config).map((agent) => {
    const mappedChannels = channelsByAgent[agent.name] || [];
    const discordRuntime = discordRuntimeBots[agent.name] || {};
    const service = agentServices[agent.name] || null;
    return {
      ...agent,
      runtime: inspectAgentRuntime(projectRoot, agent),
      discordTokenConfigured: Boolean(agent.discordToken),
      discordConnected: Boolean(discordRuntime.connected),
      discordTag: discordRuntime.tag || '',
      discordService: service,
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

function buildBotSummaries(config, channels) {
  const channelsByBot = buildChannelsByBot(channels);
  return listBots(config).map((bot) => {
    const mappedChannels = channelsByBot[bot.name] || [];
    return {
      ...bot,
      discordTokenConfigured: Boolean(bot.discordToken),
      mappedChannels: mappedChannels.map((channel) => ({
        name: channel.name,
        role: resolveBotRole(channel, bot.name),
        workspace: channel.workspace,
      })),
      mappedChannelNames: unique(mappedChannels.map((channel) => channel.name)),
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

function buildChannelsByBot(channels) {
  const output = {};
  for (const channel of channels) {
    for (const botName of [channel.bot, channel.reviewerBot, channel.arbiterBot].filter(Boolean)) {
      output[botName] = output[botName] || [];
      output[botName].push(channel);
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

function resolveBotRole(channel, botName) {
  if (channel.bot === botName) {
    return 'owner';
  }
  if (channel.reviewerBot === botName) {
    return 'reviewer';
  }
  if (channel.arbiterBot === botName) {
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
      runtimeBackend: session.runtimeBackend,
      runtimeSessionId: session.runtimeSessionId,
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

  for (const bot of Object.values(config.bots || {})) {
    if (bot.agent === currentName) {
      bot.agent = nextName;
    }
  }
}

function renameBotReferences(config, currentName, nextName) {
  for (const channel of Object.values(config.channels)) {
    if (channel.bot === currentName) {
      channel.bot = nextName;
    }
    if (channel.reviewerBot === currentName) {
      channel.reviewerBot = nextName;
    }
    if (channel.arbiterBot === currentName) {
      channel.arbiterBot = nextName;
    }
  }
}

function syncChannelAgentsForBot(config, botName) {
  const bot = config.bots?.[botName];
  if (!bot) {
    return;
  }
  for (const channel of Object.values(config.channels)) {
    if (channel.bot === botName) {
      channel.agent = bot.agent;
    }
    if (channel.reviewerBot === botName) {
      channel.reviewer = bot.agent;
    }
    if (channel.arbiterBot === botName) {
      channel.arbiter = bot.agent;
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
