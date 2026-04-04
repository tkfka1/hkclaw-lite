import fs from 'node:fs';
import path from 'node:path';

import {
  CONFIG_FILENAME,
  CURRENT_CONFIG_VERSION,
  DASHBOARD_ALL_AGENTS,
  DEFAULT_DASHBOARD_REFRESH_MS,
  DEFAULT_HISTORY_WINDOW,
  SUPPORTED_AGENTS,
  TOOL_DIRNAME,
} from './constants.js';
import {
  assert,
  ensureDir,
  isPlainObject,
  parseCommaSeparatedList,
  parseInteger,
  parseOptionalInteger,
  readJson,
  writeJson,
} from './utils.js';

export function getProjectLayout(projectRoot) {
  const toolRoot = path.join(projectRoot, TOOL_DIRNAME);
  return {
    projectRoot,
    toolRoot,
    configPath: path.join(toolRoot, CONFIG_FILENAME),
    sessionsRoot: path.join(toolRoot, 'sessions'),
  };
}

export function findProjectRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    const configPath = getProjectLayout(current).configPath;
    if (fs.existsSync(configPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveProjectRoot(startDir, explicitRoot) {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  const discovered = findProjectRoot(startDir);
  assert(
    discovered,
    'No hkclaw-lite project found. Run "hkclaw-lite init" first or pass --root.',
  );
  return discovered;
}

export function initProject(projectRoot, { force = false } = {}) {
  const layout = getProjectLayout(projectRoot);
  if (fs.existsSync(layout.configPath) && !force) {
    throw new Error(
      `Project is already initialized at ${layout.configPath}. Use --force to overwrite.`,
    );
  }
  ensureDir(layout.toolRoot);
  ensureDir(layout.sessionsRoot);
  writeJson(layout.configPath, createDefaultConfig());
  return layout;
}

export function createDefaultConfig() {
  return {
    version: CURRENT_CONFIG_VERSION,
    defaults: {
      historyWindow: DEFAULT_HISTORY_WINDOW,
      dashboardRefreshMs: DEFAULT_DASHBOARD_REFRESH_MS,
    },
    agents: {},
    channels: {},
    dashboards: {},
  };
}

export function loadConfig(projectRoot) {
  const layout = getProjectLayout(projectRoot);
  const rawConfig = readJson(layout.configPath);
  const config = normalizeConfig(rawConfig);

  assert(
    isPlainObject(config),
    `Invalid config file at ${layout.configPath}. Expected a JSON object.`,
  );
  assert(
    config.version === CURRENT_CONFIG_VERSION,
    `Unsupported config version "${config.version}".`,
  );
  assert(isPlainObject(config.defaults), 'Config defaults must be an object.');
  assert(isPlainObject(config.agents), 'Config agents must be an object.');
  assert(isPlainObject(config.channels), 'Config channels must be an object.');
  assert(isPlainObject(config.dashboards), 'Config dashboards must be an object.');

  return config;
}

function normalizeConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    return rawConfig;
  }

  if (rawConfig.version === CURRENT_CONFIG_VERSION) {
    return {
      ...rawConfig,
      defaults: {
        historyWindow:
          rawConfig.defaults?.historyWindow ?? DEFAULT_HISTORY_WINDOW,
        dashboardRefreshMs:
          rawConfig.defaults?.dashboardRefreshMs ?? DEFAULT_DASHBOARD_REFRESH_MS,
      },
      agents: rawConfig.agents ?? {},
      channels: rawConfig.channels ?? {},
      dashboards: rawConfig.dashboards ?? {},
    };
  }

  if (rawConfig.version === 2 && isPlainObject(rawConfig.agents)) {
    return {
      version: CURRENT_CONFIG_VERSION,
      defaults: {
        historyWindow:
          rawConfig.defaults?.historyWindow ?? DEFAULT_HISTORY_WINDOW,
        dashboardRefreshMs:
          rawConfig.defaults?.dashboardRefreshMs ?? DEFAULT_DASHBOARD_REFRESH_MS,
      },
      agents: rawConfig.agents ?? {},
      channels: {},
      dashboards: rawConfig.dashboards ?? {},
    };
  }

  if (rawConfig.version === 1 && isPlainObject(rawConfig.services)) {
    return {
      version: CURRENT_CONFIG_VERSION,
      defaults: {
        historyWindow:
          rawConfig.defaults?.historyWindow ?? DEFAULT_HISTORY_WINDOW,
        dashboardRefreshMs: DEFAULT_DASHBOARD_REFRESH_MS,
      },
      agents: rawConfig.services,
      channels: {},
      dashboards: {},
    };
  }

  return rawConfig;
}

export function saveConfig(projectRoot, config) {
  const layout = getProjectLayout(projectRoot);
  writeJson(layout.configPath, config);
}

export function listAgents(config) {
  return Object.entries(config.agents)
    .map(([name, agent]) => ({ name, ...agent }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getAgent(config, name) {
  const agent = config.agents[name];
  assert(agent, `Unknown agent "${name}".`);
  return { name, ...agent };
}

export function removeAgent(config, name) {
  assert(config.agents[name], `Unknown agent "${name}".`);
  delete config.agents[name];
}

export function listDashboards(config) {
  return Object.entries(config.dashboards)
    .map(([name, dashboard]) => ({ name, ...dashboard }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getDashboard(config, name) {
  const dashboard = config.dashboards[name];
  assert(dashboard, `Unknown dashboard "${name}".`);
  return { name, ...dashboard };
}

export function removeDashboard(config, name) {
  assert(config.dashboards[name], `Unknown dashboard "${name}".`);
  delete config.dashboards[name];
}

export function listChannels(config) {
  return Object.entries(config.channels)
    .map(([name, channel]) => ({ name, ...channel }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getChannel(config, name) {
  const channel = config.channels[name];
  assert(channel, `Unknown channel "${name}".`);
  return { name, ...channel };
}

export function removeChannel(config, name) {
  assert(config.channels[name], `Unknown channel "${name}".`);
  delete config.channels[name];
}

export function buildAgentDefinition(projectRoot, name, input, existing = {}) {
  assert(name, 'Agent name is required.');
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Agent name may only contain letters, numbers, dot, underscore, and dash.',
  );

  const merged = {
    ...stripManagedFields(existing),
    agent: getRequiredString(input.agent ?? existing.agent, 'agent'),
    workdir: input.workdir ?? existing.workdir ?? '.',
    model: normalizeOptionalString(input.model ?? existing.model),
    effort: normalizeOptionalString(input.effort ?? existing.effort),
    systemPrompt: normalizeOptionalString(
      input.systemPrompt ?? input.system ?? existing.systemPrompt,
    ),
    systemPromptFile: normalizeOptionalString(
      input.systemPromptFile ?? input['system-file'] ?? existing.systemPromptFile,
    ),
    historyWindow:
      input.historyWindow ?? input['history-window'] ?? existing.historyWindow,
    timeoutMs: input.timeoutMs ?? input['timeout-ms'] ?? existing.timeoutMs,
    sandbox: normalizeOptionalString(input.sandbox ?? existing.sandbox),
    permissionMode: normalizeOptionalString(
      input.permissionMode ?? input['permission-mode'] ?? existing.permissionMode,
    ),
    dangerous: resolveBooleanValue(input.dangerous, existing.dangerous ?? false),
    baseUrl: normalizeOptionalString(input.baseUrl ?? input['base-url'] ?? existing.baseUrl),
    command: normalizeOptionalString(input.command ?? existing.command),
    env: input.env ?? existing.env ?? {},
  };

  if (merged.historyWindow !== undefined) {
    merged.historyWindow = parseInteger(merged.historyWindow, 'historyWindow');
  }
  if (merged.timeoutMs !== undefined) {
    merged.timeoutMs = parseOptionalInteger(merged.timeoutMs, 'timeoutMs');
  }
  if (merged.agent !== 'codex') {
    merged.sandbox = undefined;
  }
  if (merged.agent === 'codex' && merged.sandbox !== 'danger-full-access') {
    merged.dangerous = undefined;
  }
  if (merged.agent !== 'claude-code') {
    merged.permissionMode = undefined;
  }
  if (!['codex', 'claude-code'].includes(merged.agent)) {
    merged.dangerous = undefined;
  }
  if (merged.agent !== 'local-llm') {
    merged.baseUrl = undefined;
  }
  if (merged.agent !== 'command') {
    merged.command = undefined;
  }

  validateAgentDefinition(projectRoot, merged);
  return sortObjectKeys(merged);
}

export function buildChannelDefinition(config, name, input, existing = {}) {
  assert(name, 'Channel name is required.');
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Channel name may only contain letters, numbers, dot, underscore, and dash.',
  );

  const merged = {
    ...stripManagedFields(existing),
    discordChannelId: getRequiredString(
      input.discordChannelId ?? input['discord-channel-id'] ?? existing.discordChannelId,
      'discordChannelId',
    ),
    guildId: normalizeOptionalString(input.guildId ?? input['guild-id'] ?? existing.guildId),
    agent: getRequiredString(input.agent ?? existing.agent, 'agent'),
    description: normalizeOptionalString(input.description ?? existing.description),
  };

  validateChannelDefinition(config, merged);
  return sortObjectKeys(merged);
}

export function buildDashboardDefinition(
  projectRoot,
  name,
  input,
  config,
  existing = {},
) {
  assert(name, 'Dashboard name is required.');
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Dashboard name may only contain letters, numbers, dot, underscore, and dash.',
  );

  const merged = {
    ...stripManagedFields(existing),
    monitors: normalizeDashboardMonitors(input.monitors ?? existing.monitors ?? [DASHBOARD_ALL_AGENTS]),
    refreshMs:
      input.refreshMs ??
      input['refresh-ms'] ??
      existing.refreshMs ??
      config.defaults.dashboardRefreshMs ??
      DEFAULT_DASHBOARD_REFRESH_MS,
    showSessions: resolveBooleanValue(
      input.showSessions ?? input['show-sessions'],
      existing.showSessions ?? true,
    ),
    showDetails: resolveBooleanValue(
      input.showDetails ?? input['show-details'],
      existing.showDetails ?? true,
    ),
  };

  merged.refreshMs = parseInteger(merged.refreshMs, 'refreshMs');
  validateDashboardDefinition(config, merged);
  return sortObjectKeys(merged);
}

function validateAgentDefinition(projectRoot, agent) {
  assert(
    SUPPORTED_AGENTS.includes(agent.agent),
    `Unsupported agent "${agent.agent}". Supported: ${SUPPORTED_AGENTS.join(', ')}.`,
  );

  assert(
    typeof agent.workdir === 'string' && agent.workdir.trim().length > 0,
    'workdir is required.',
  );
  const resolvedWorkdir = resolveProjectPath(projectRoot, agent.workdir);
  assert(fs.existsSync(resolvedWorkdir), `Workdir does not exist: ${resolvedWorkdir}`);

  if (agent.systemPromptFile) {
    const resolvedPromptFile = resolveProjectPath(projectRoot, agent.systemPromptFile);
    assert(
      fs.existsSync(resolvedPromptFile),
      `System prompt file does not exist: ${resolvedPromptFile}`,
    );
  }

  if (agent.historyWindow !== undefined) {
    assert(
      Number.isInteger(agent.historyWindow) && agent.historyWindow > 0,
      'historyWindow must be a positive integer.',
    );
  }

  if (agent.timeoutMs !== undefined) {
    assert(
      Number.isInteger(agent.timeoutMs) && agent.timeoutMs > 0,
      'timeoutMs must be a positive integer.',
    );
  }

  if (agent.agent === 'local-llm') {
    assert(
      typeof agent.model === 'string' && agent.model.trim().length > 0,
      'local-llm agents require a model.',
    );
  }

  if (agent.agent === 'command') {
    assert(
      typeof agent.command === 'string' && agent.command.trim().length > 0,
      'command agents require a command.',
    );
  }
}

function validateChannelDefinition(config, channel) {
  assert(
    typeof channel.discordChannelId === 'string' &&
      channel.discordChannelId.trim().length > 0,
    'discordChannelId is required.',
  );
  assert(config.agents[channel.agent], `Channel references unknown agent "${channel.agent}".`);
}

function validateDashboardDefinition(config, dashboard) {
  assert(
    Number.isInteger(dashboard.refreshMs) && dashboard.refreshMs > 0,
    'Dashboard refreshMs must be a positive integer.',
  );
  assert(
    Array.isArray(dashboard.monitors) && dashboard.monitors.length > 0,
    'Dashboard must monitor at least one agent or "*".',
  );

  if (dashboard.monitors.includes(DASHBOARD_ALL_AGENTS)) {
    assert(
      dashboard.monitors.length === 1,
      'Dashboard monitors cannot mix "*" with explicit agent names.',
    );
    return;
  }

  for (const agentName of dashboard.monitors) {
    assert(config.agents[agentName], `Dashboard references unknown agent "${agentName}".`);
  }
}

function getRequiredString(value, fieldName) {
  assert(
    typeof value === 'string' && value.trim().length > 0,
    `${fieldName} is required.`,
  );
  return value.trim();
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveBooleanValue(value, fallbackValue) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'y', 'yes'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'n', 'no'].includes(normalized)) {
    return false;
  }
  return fallbackValue;
}

function normalizeDashboardMonitors(value) {
  const monitors = Array.isArray(value)
    ? value.flatMap((entry) => normalizeDashboardMonitors(entry))
    : parseCommaSeparatedList(value);

  if (monitors.length === 0) {
    return [DASHBOARD_ALL_AGENTS];
  }

  const unique = [...new Set(monitors)];
  if (unique.includes('all')) {
    return [DASHBOARD_ALL_AGENTS];
  }
  if (unique.includes(DASHBOARD_ALL_AGENTS)) {
    return [DASHBOARD_ALL_AGENTS];
  }
  return unique;
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortObjectKeys(entryValue)]),
  );
}

function stripManagedFields(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const next = { ...value };
  delete next.name;
  return next;
}

export function resolveProjectPath(projectRoot, maybeRelativePath) {
  return path.resolve(projectRoot, maybeRelativePath);
}
