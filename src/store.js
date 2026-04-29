import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHANNEL_MODE_CHOICES,
  CONNECTOR_PLATFORM_CHOICES,
  CONTAINER_CHANNEL_WORKSPACE,
  CONFIG_FILENAME,
  CURRENT_CONFIG_VERSION,
  DASHBOARD_ALL_AGENTS,
  DEFAULT_DASHBOARD_REFRESH_MS,
  DEFAULT_CHANNEL_WORKSPACE,
  DEFAULT_LOCAL_LLM_BASE_URL,
  MESSAGING_PLATFORM_CHOICES,
  SUPPORTED_AGENTS,
  TOOL_DIRNAME,
} from './constants.js';
import { resolveAgentEffortChoices } from './model-catalog.js';
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
    watchersRoot: path.join(toolRoot, 'watchers'),
  };
}

export function getDefaultChannelWorkspace() {
  const homeWorkspace = path.join(os.homedir(), 'workspace');
  if (fs.existsSync(homeWorkspace)) {
    return homeWorkspace;
  }
  return fs.existsSync(CONTAINER_CHANNEL_WORKSPACE)
    ? CONTAINER_CHANNEL_WORKSPACE
    : DEFAULT_CHANNEL_WORKSPACE;
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

export function resolveOrInitProjectRoot(startDir, explicitRoot) {
  const projectRoot = explicitRoot
    ? path.resolve(explicitRoot)
    : findProjectRoot(startDir) || path.resolve(startDir);
  ensureProjectInitialized(projectRoot);
  return projectRoot;
}

export function ensureProjectInitialized(projectRoot) {
  const layout = getProjectLayout(projectRoot);
  if (!fs.existsSync(layout.configPath)) {
    initProject(projectRoot);
  }
  return layout;
}

export function initProject(projectRoot, { force = false } = {}) {
  const layout = getProjectLayout(projectRoot);
  if (fs.existsSync(layout.configPath) && !force) {
    throw new Error(
      `Project is already initialized at ${layout.configPath}. Use --force to overwrite.`,
    );
  }
  ensureDir(layout.toolRoot);
  ensureDir(layout.watchersRoot);
  writeJson(layout.configPath, createDefaultConfig());
  return layout;
}

export function createDefaultConfig() {
  return {
    version: CURRENT_CONFIG_VERSION,
    defaults: {
      dashboardRefreshMs: DEFAULT_DASHBOARD_REFRESH_MS,
    },
    localLlmConnections: createDefaultLocalLlmConnections(),
    connectors: {},
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
  assert(isPlainObject(config.localLlmConnections), 'Config localLlmConnections must be an object.');
  assert(isPlainObject(config.connectors), 'Config connectors must be an object.');
  assert(isPlainObject(config.agents), 'Config agents must be an object.');
  assert(isPlainObject(config.channels), 'Config channels must be an object.');
  assert(isPlainObject(config.dashboards), 'Config dashboards must be an object.');
  validateConfigReferences(projectRoot, config);

  return config;
}

function normalizeConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    return rawConfig;
  }

  if (rawConfig.version === CURRENT_CONFIG_VERSION) {
    const rawAgents = rawConfig.agents ?? {};
    return {
      version: CURRENT_CONFIG_VERSION,
      defaults: {
        dashboardRefreshMs:
          rawConfig.defaults?.dashboardRefreshMs ?? DEFAULT_DASHBOARD_REFRESH_MS,
      },
      localLlmConnections: normalizeLocalLlmConnectionRecords(rawConfig.localLlmConnections),
      connectors: normalizeMessagingConnectorRecords(rawConfig.connectors, rawAgents),
      agents: mergeLegacyBotTokensIntoAgents(
        normalizeLegacyAgentRecords(rawAgents),
        normalizeLegacyBotRecords(rawConfig.bots ?? {}),
      ),
      channels: normalizeLegacyChannelRecords(
        rawConfig.channels ?? {},
        rawAgents,
        rawConfig.bots ?? {},
      ),
      dashboards: normalizeLegacyDashboardRecords(rawConfig.dashboards ?? {}),
    };
  }

  if (rawConfig.version === 2 && isPlainObject(rawConfig.agents)) {
    const rawAgents = rawConfig.agents ?? {};
    return {
      version: CURRENT_CONFIG_VERSION,
      defaults: {
        dashboardRefreshMs:
          rawConfig.defaults?.dashboardRefreshMs ?? DEFAULT_DASHBOARD_REFRESH_MS,
      },
      localLlmConnections: normalizeLocalLlmConnectionRecords(rawConfig.localLlmConnections),
      connectors: normalizeMessagingConnectorRecords(rawConfig.connectors, rawAgents),
      agents: mergeLegacyBotTokensIntoAgents(
        normalizeLegacyAgentRecords(rawAgents),
        normalizeLegacyBotRecords(rawConfig.bots ?? {}),
      ),
      channels: normalizeLegacyChannelRecords(
        rawConfig.channels ?? {},
        rawAgents,
        rawConfig.bots ?? {},
      ),
      dashboards: normalizeLegacyDashboardRecords(rawConfig.dashboards ?? {}),
    };
  }

  if (rawConfig.version === 1 && isPlainObject(rawConfig.services)) {
    const rawAgents = rawConfig.services;
    return {
      version: CURRENT_CONFIG_VERSION,
      defaults: {
        dashboardRefreshMs: DEFAULT_DASHBOARD_REFRESH_MS,
      },
      localLlmConnections: normalizeLocalLlmConnectionRecords(rawConfig.localLlmConnections),
      connectors: normalizeMessagingConnectorRecords(rawConfig.connectors, rawAgents),
      agents: normalizeLegacyAgentRecords(rawAgents),
      channels: {},
      dashboards: {},
    };
  }

  return rawConfig;
}

export function validateConfigReferences(projectRoot, config) {
  validateLocalLlmConnections(config.localLlmConnections);

  for (const [name, connector] of Object.entries(config.connectors || {})) {
    validateConnectorDefinition(name, connector);
  }

  for (const [name, agent] of Object.entries(config.agents)) {
    validateAgentDefinition(projectRoot, { name, ...agent });
    if (agent.agent === 'local-llm' && agent.localLlmConnection) {
      assert(
        config.localLlmConnections[agent.localLlmConnection],
        `Agent "${name}" references unknown local LLM connection "${agent.localLlmConnection}".`,
      );
    }
    if (agent.fallbackAgent) {
      assert(
        config.agents[agent.fallbackAgent],
        `Agent "${name}" references unknown fallback agent "${agent.fallbackAgent}".`,
      );
    }
  }

  for (const channel of Object.values(config.channels)) {
    validateChannelDefinition(projectRoot, config, channel);
  }

  for (const dashboard of Object.values(config.dashboards)) {
    validateDashboardDefinition(config, dashboard);
  }
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

export function listLocalLlmConnections(config) {
  return Object.entries(config.localLlmConnections || {})
    .map(([name, connection]) => ({ name, ...connection }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function listConnectors(config) {
  return Object.entries(config.connectors || {})
    .map(([name, connector]) => ({ name, ...connector }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getConnector(config, name) {
  const connector = config.connectors?.[name];
  assert(connector, `Unknown connector "${name}".`);
  return { name, ...connector };
}

export function removeConnector(config, name) {
  assert(config.connectors?.[name], `Unknown connector "${name}".`);
  delete config.connectors[name];
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
    platform: resolveMessagingPlatform(
      input.platform ?? input['platform'] ?? existing.platform,
      existing,
    ),
    fallbackAgent: normalizeOptionalString(
      input.fallbackAgent ?? input['fallback-agent'] ?? existing.fallbackAgent,
    ),
    managementPolicy: normalizeManagementPolicy(
      input.managementPolicy ?? input['management-policy'] ?? existing.managementPolicy,
    ),
    model: normalizeOptionalString(input.model ?? existing.model),
    effort: normalizeOptionalString(input.effort ?? existing.effort),
    systemPrompt: normalizeOptionalString(
      input.systemPrompt ?? input.system ?? existing.systemPrompt,
    ),
    systemPromptFile: normalizeOptionalString(
      input.systemPromptFile ?? input['system-file'] ?? existing.systemPromptFile,
    ),
    timeoutMs: input.timeoutMs ?? input['timeout-ms'] ?? existing.timeoutMs,
    sandbox: normalizeOptionalString(input.sandbox ?? existing.sandbox),
    permissionMode: normalizeOptionalString(
      input.permissionMode ?? input['permission-mode'] ?? existing.permissionMode,
    ),
    dangerous: resolveBooleanValue(input.dangerous, existing.dangerous ?? false),
    discordToken: normalizeOptionalString(
      input.discordToken ?? input['discord-token'] ?? existing.discordToken,
    ),
    telegramBotToken: normalizeOptionalString(
      input.telegramBotToken ??
        input['telegram-bot-token'] ??
        existing.telegramBotToken,
    ),
    kakaoRelayUrl: normalizeOptionalString(
      input.kakaoRelayUrl ??
        input['kakao-relay-url'] ??
        input.relayUrl ??
        input['relay-url'] ??
        existing.kakaoRelayUrl,
    ),
    kakaoRelayToken: normalizeOptionalString(
      input.kakaoRelayToken ??
        input['kakao-relay-token'] ??
        input.relayToken ??
        input['relay-token'] ??
        existing.kakaoRelayToken,
    ),
    kakaoSessionToken: normalizeOptionalString(
      input.kakaoSessionToken ??
        input['kakao-session-token'] ??
        input.sessionToken ??
        input['session-token'] ??
        existing.kakaoSessionToken,
    ),
    localLlmConnection: normalizeOptionalString(
      input.localLlmConnection ??
        input['local-llm-connection'] ??
        input.connection ??
        existing.localLlmConnection,
    ),
    baseUrl: normalizeOptionalString(input.baseUrl ?? input['base-url'] ?? existing.baseUrl),
    command: normalizeOptionalString(input.command ?? existing.command),
    skills: normalizePathEntries(
      input.skills ?? input['skill-file'] ?? existing.skills,
    ),
    contextFiles: normalizePathEntries(
      input.contextFiles ?? input['context-file'] ?? existing.contextFiles,
    ),
  };

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
  if (merged.agent === 'claude-code') {
    if (!merged.permissionMode && merged.dangerous) {
      merged.permissionMode = 'bypassPermissions';
    }
    merged.dangerous = undefined;
  }
  if (!['codex', 'claude-code'].includes(merged.agent)) {
    merged.dangerous = undefined;
  }
  if (merged.agent !== 'local-llm') {
    merged.localLlmConnection = undefined;
    merged.baseUrl = undefined;
  }
  if (merged.agent !== 'command') {
    merged.command = undefined;
  }
  if (merged.platform === 'telegram') {
    merged.discordToken = undefined;
    merged.kakaoRelayUrl = undefined;
    merged.kakaoRelayToken = undefined;
    merged.kakaoSessionToken = undefined;
  } else if (merged.platform === 'kakao') {
    merged.discordToken = undefined;
    merged.telegramBotToken = undefined;
  } else {
    merged.telegramBotToken = undefined;
    merged.kakaoRelayUrl = undefined;
    merged.kakaoRelayToken = undefined;
    merged.kakaoSessionToken = undefined;
  }

  validateAgentDefinition(projectRoot, merged);
  return sortObjectKeys(merged);
}

export function buildChannelDefinition(projectRoot, config, name, input, existing = {}) {
  assert(name, 'Channel name is required.');
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Channel name may only contain letters, numbers, dot, underscore, and dash.',
  );

  const merged = {
    ...stripManagedFields(existing),
    platform: resolveMessagingPlatform(
      input.platform ?? input['platform'] ?? existing.platform,
      existing,
    ),
    connector: normalizeOptionalString(
      input.connector ??
        input.connectorName ??
        input['connector-name'] ??
        existing.connector,
    ),
    mode: normalizeOptionalString(
      input.mode ??
        input['mode'] ??
        input.channelMode ??
        input['channel-mode'] ??
        existing.mode ??
        (input.reviewer || input.arbiter || existing.reviewer || existing.arbiter
          ? 'tribunal'
          : 'single'),
    ),
    discordChannelId: normalizeOptionalString(
      input.discordChannelId ?? input['discord-channel-id'] ?? existing.discordChannelId,
    ),
    guildId: normalizeOptionalString(input.guildId ?? input['guild-id'] ?? existing.guildId),
    telegramChatId: normalizeOptionalString(
      input.telegramChatId ??
        input['telegram-chat-id'] ??
        input.chatId ??
        input['chat-id'] ??
        existing.telegramChatId,
    ),
    telegramThreadId: normalizeOptionalString(
      input.telegramThreadId ??
        input['telegram-thread-id'] ??
        input.threadId ??
        input['thread-id'] ??
        existing.telegramThreadId,
    ),
    kakaoChannelId: normalizeOptionalString(
      input.kakaoChannelId ??
        input['kakao-channel-id'] ??
        input.channelId ??
        input['channel-id'] ??
        existing.kakaoChannelId,
    ),
    kakaoUserId: normalizeOptionalString(
      input.kakaoUserId ??
        input['kakao-user-id'] ??
        input.userId ??
        input['user-id'] ??
        existing.kakaoUserId,
    ),
    workspace: normalizeOptionalString(
      input.workspace ??
        input['workspace'] ??
        input.workdir ??
        input['workdir'] ??
        existing.workspace ??
        existing.workdir ??
        getDefaultChannelWorkspace(),
    ),
    ownerWorkspace: normalizeOptionalString(
      input.ownerWorkspace ??
        input['owner-workspace'] ??
        existing.ownerWorkspace,
    ),
    reviewerWorkspace: normalizeOptionalString(
      input.reviewerWorkspace ??
        input['reviewer-workspace'] ??
        existing.reviewerWorkspace,
    ),
    arbiterWorkspace: normalizeOptionalString(
      input.arbiterWorkspace ??
        input['arbiter-workspace'] ??
        existing.arbiterWorkspace,
    ),
    agent: getRequiredString(input.agent ?? existing.agent, 'agent'),
    reviewer: resolveOptionalChannelAgentName(
      input.reviewer ?? existing.reviewer,
    ),
    arbiter: resolveOptionalChannelAgentName(
      input.arbiter ?? existing.arbiter,
    ),
    reviewRounds:
      input.reviewRounds ?? input['review-rounds'] ?? existing.reviewRounds,
    description: normalizeOptionalString(input.description ?? existing.description),
  };

  if (merged.mode !== 'tribunal') {
    merged.reviewer = undefined;
    merged.arbiter = undefined;
    merged.reviewRounds = undefined;
    merged.reviewerWorkspace = undefined;
    merged.arbiterWorkspace = undefined;
  }
  if (merged.reviewRounds !== undefined) {
    merged.reviewRounds = parseOptionalInteger(merged.reviewRounds, 'reviewRounds');
  }
  if (merged.platform === 'telegram') {
    merged.connector = undefined;
    merged.discordChannelId = undefined;
    merged.guildId = undefined;
    merged.kakaoChannelId = undefined;
    merged.kakaoUserId = undefined;
  } else if (merged.platform === 'kakao') {
    merged.discordChannelId = undefined;
    merged.guildId = undefined;
    merged.telegramChatId = undefined;
    merged.telegramThreadId = undefined;
    merged.kakaoChannelId = merged.kakaoChannelId || '*';
  } else {
    merged.connector = undefined;
    merged.telegramChatId = undefined;
    merged.telegramThreadId = undefined;
    merged.kakaoChannelId = undefined;
    merged.kakaoUserId = undefined;
  }
  validateChannelDefinition(projectRoot, config, merged);
  validateKakaoChannelRouteUniqueness(config, { name, ...merged });
  return sortObjectKeys(merged);
}

export function buildConnectorDefinition(name, input = {}, existing = {}) {
  assert(name, 'Connector name is required.');
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Connector name may only contain letters, numbers, dot, underscore, and dash.',
  );

  const explicitType = normalizeOptionalString(
    input.type ?? input.platform ?? input['platform'] ?? existing.type,
  );
  assert(
    !explicitType || CONNECTOR_PLATFORM_CHOICES.some((entry) => entry.value === explicitType),
    `Connectors are KakaoTalk-only; configure ${explicitType || 'non-Kakao'} credentials on the agent instead.`,
  );

  const discordToken = normalizeOptionalString(
    input.discordToken ?? input['discord-token'] ?? existing.discordToken,
  );
  const telegramBotToken = normalizeOptionalString(
    input.telegramBotToken ?? input['telegram-bot-token'] ?? existing.telegramBotToken,
  );
  assert(
    !discordToken && !telegramBotToken,
    'Connectors are KakaoTalk-only; configure Discord or Telegram tokens on the agent instead.',
  );

  const merged = {
    ...stripManagedFields(existing),
    type: 'kakao',
    description: normalizeOptionalString(input.description ?? existing.description),
    kakaoRelayUrl: normalizeOptionalString(
      input.kakaoRelayUrl ??
        input['kakao-relay-url'] ??
        input.relayUrl ??
        input['relay-url'] ??
        existing.kakaoRelayUrl,
    ),
    kakaoRelayToken: normalizeOptionalString(
      input.kakaoRelayToken ??
        input['kakao-relay-token'] ??
        input.relayToken ??
        input['relay-token'] ??
        existing.kakaoRelayToken,
    ),
    kakaoSessionToken: normalizeOptionalString(
      input.kakaoSessionToken ??
        input['kakao-session-token'] ??
        input.sessionToken ??
        input['session-token'] ??
        existing.kakaoSessionToken,
    ),
  };

  validateConnectorDefinition(name, merged);
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
    showDetails: resolveBooleanValue(
      input.showDetails ?? input['show-details'],
      existing.showDetails ?? true,
    ),
  };

  merged.refreshMs = parseInteger(merged.refreshMs, 'refreshMs');
  validateDashboardDefinition(config, merged);
  return sortObjectKeys(merged);
}

export function buildLocalLlmConnectionDefinition(name, input = {}, existing = {}) {
  assert(name, 'Local LLM connection name is required.');
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Local LLM connection name may only contain letters, numbers, dot, underscore, and dash.',
  );

  const merged = {
    ...stripManagedFields(existing),
    baseUrl:
      normalizeOptionalString(input.baseUrl ?? input['base-url'] ?? existing.baseUrl) ||
      DEFAULT_LOCAL_LLM_BASE_URL,
    apiKey: normalizeOptionalString(input.apiKey ?? input['api-key'] ?? existing.apiKey),
    description: normalizeOptionalString(input.description ?? existing.description),
  };

  validateLocalLlmConnectionDefinition(name, merged);
  return sortObjectKeys(merged);
}

export function resolveLocalLlmConnectionConfig(
  config,
  agent = {},
) {
  const connectionName = normalizeOptionalString(agent.localLlmConnection);
  const configuredConnection =
    connectionName && isPlainObject(config?.localLlmConnections)
      ? config.localLlmConnections[connectionName]
      : null;
  if (configuredConnection) {
    return {
      connectionName,
      baseUrl: configuredConnection.baseUrl || DEFAULT_LOCAL_LLM_BASE_URL,
      apiKey: normalizeOptionalString(configuredConnection.apiKey),
    };
  }

  return {
    connectionName: null,
    baseUrl:
      normalizeOptionalString(agent.baseUrl) ||
      DEFAULT_LOCAL_LLM_BASE_URL,
    apiKey: '',
  };
}

function validateAgentDefinition(projectRoot, agent) {
  assert(
    SUPPORTED_AGENTS.includes(agent.agent),
    `Unsupported agent "${agent.agent}". Supported: ${SUPPORTED_AGENTS.join(', ')}.`,
  );

  if (agent.fallbackAgent) {
    assert(agent.fallbackAgent !== agent.name, 'fallbackAgent must be different from the agent.');
  }

  if (agent.managementPolicy !== undefined) {
    validateManagementPolicy(agent.managementPolicy);
  }

  if (agent.systemPromptFile) {
    const resolvedPromptFile = resolveProjectPath(projectRoot, agent.systemPromptFile);
    assert(
      fs.existsSync(resolvedPromptFile),
      `System prompt file does not exist: ${resolvedPromptFile}`,
    );
  }

  for (const skillPath of agent.skills ?? []) {
    const resolvedSkillPath = resolveProjectPath(projectRoot, skillPath);
    assert(fs.existsSync(resolvedSkillPath), `Skill path does not exist: ${resolvedSkillPath}`);
    if (fs.statSync(resolvedSkillPath).isDirectory()) {
      const skillFilePath = path.join(resolvedSkillPath, 'SKILL.md');
      assert(
        fs.existsSync(skillFilePath),
        `Skill directory does not contain SKILL.md: ${skillFilePath}`,
      );
    }
  }

  for (const contextFile of agent.contextFiles ?? []) {
    const resolvedContextFile = resolveProjectPath(projectRoot, contextFile);
    assert(
      fs.existsSync(resolvedContextFile),
      `Context file does not exist: ${resolvedContextFile}`,
    );
    assert(
      !fs.statSync(resolvedContextFile).isDirectory(),
      `Context file must be a file: ${resolvedContextFile}`,
    );
  }

  if (agent.timeoutMs !== undefined) {
    assert(
      Number.isInteger(agent.timeoutMs) && agent.timeoutMs > 0,
      'timeoutMs must be a positive integer.',
    );
  }

  if (agent.effort) {
    const supportedEfforts = resolveAgentEffortChoices(agent.agent, agent.model);
    assert(
      supportedEfforts.length === 0 || supportedEfforts.includes(agent.effort),
      `Unsupported effort "${agent.effort}" for agent "${agent.agent}" model "${agent.model || '(default)'}".`,
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

  assert(
    MESSAGING_PLATFORM_CHOICES.some((entry) => entry.value === agent.platform),
    `Unsupported platform "${agent.platform}".`,
  );

  if (agent.discordToken !== undefined) {
    assert(
      typeof agent.discordToken === 'string' && agent.discordToken.trim().length > 0,
      'discordToken must be a non-empty string.',
    );
  }
  if (agent.telegramBotToken !== undefined) {
    assert(
      typeof agent.telegramBotToken === 'string' && agent.telegramBotToken.trim().length > 0,
      'telegramBotToken must be a non-empty string.',
    );
  }
  if (agent.kakaoRelayUrl !== undefined) {
    assert(
      typeof agent.kakaoRelayUrl === 'string' && agent.kakaoRelayUrl.trim().length > 0,
      'kakaoRelayUrl must be a non-empty string.',
    );
  }
  if (agent.kakaoRelayToken !== undefined) {
    assert(
      typeof agent.kakaoRelayToken === 'string' && agent.kakaoRelayToken.trim().length > 0,
      'kakaoRelayToken must be a non-empty string.',
    );
  }
  if (agent.kakaoSessionToken !== undefined) {
    assert(
      typeof agent.kakaoSessionToken === 'string' && agent.kakaoSessionToken.trim().length > 0,
      'kakaoSessionToken must be a non-empty string.',
    );
  }

}

function validateConnectorDefinition(name, connector) {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Connector name may only contain letters, numbers, dot, underscore, and dash.',
  );
  assert(
    MESSAGING_PLATFORM_CHOICES.some((entry) => entry.value === connector.type),
    `Unsupported connector type "${connector.type}".`,
  );
  if (connector.discordToken !== undefined) {
    assert(
      typeof connector.discordToken === 'string' && connector.discordToken.trim().length > 0,
      'discordToken must be a non-empty string.',
    );
  }
  if (connector.telegramBotToken !== undefined) {
    assert(
      typeof connector.telegramBotToken === 'string' && connector.telegramBotToken.trim().length > 0,
      'telegramBotToken must be a non-empty string.',
    );
  }
  if (connector.kakaoRelayUrl !== undefined) {
    assert(
      typeof connector.kakaoRelayUrl === 'string' && connector.kakaoRelayUrl.trim().length > 0,
      'kakaoRelayUrl must be a non-empty string.',
    );
  }
  if (connector.kakaoRelayToken !== undefined) {
    assert(
      typeof connector.kakaoRelayToken === 'string' && connector.kakaoRelayToken.trim().length > 0,
      'kakaoRelayToken must be a non-empty string.',
    );
  }
  if (connector.kakaoSessionToken !== undefined) {
    assert(
      typeof connector.kakaoSessionToken === 'string' && connector.kakaoSessionToken.trim().length > 0,
      'kakaoSessionToken must be a non-empty string.',
    );
  }
}

function validateChannelDefinition(projectRoot, config, channel) {
  assert(
    MESSAGING_PLATFORM_CHOICES.some((entry) => entry.value === channel.platform),
    `Unsupported platform "${channel.platform}".`,
  );
  assert(
    CHANNEL_MODE_CHOICES.some((entry) => entry.value === channel.mode),
    `Unsupported channel mode "${channel.mode}".`,
  );
  if (channel.connector) {
    const connector = config.connectors?.[channel.connector];
    assert(connector, `Channel references unknown connector "${channel.connector}".`);
    assert(
      connector.type === channel.platform,
      `Channel connector "${channel.connector}" is ${connector.type}, not ${channel.platform}.`,
    );
  }
  if (channel.platform === 'telegram') {
    assert(
      typeof channel.telegramChatId === 'string' &&
        channel.telegramChatId.trim().length > 0,
      'telegramChatId is required.',
    );
  } else if (channel.platform === 'kakao') {
    assert(
      typeof channel.kakaoChannelId === 'string' &&
        channel.kakaoChannelId.trim().length > 0,
      'kakaoChannelId is required.',
    );
  } else {
    assert(
      typeof channel.discordChannelId === 'string' &&
        channel.discordChannelId.trim().length > 0,
      'discordChannelId is required.',
    );
  }
  assert(
    typeof channel.workspace === 'string' && channel.workspace.trim().length > 0,
    'workspace is required.',
  );
  const resolvedWorkspace = resolveProjectPath(projectRoot, channel.workspace);
  assert(fs.existsSync(resolvedWorkspace), `Workspace does not exist: ${resolvedWorkspace}`);
  assert(
    fs.statSync(resolvedWorkspace).isDirectory(),
    `Workspace must be a directory: ${resolvedWorkspace}`,
  );
  for (const [fieldName, workspaceValue] of [
    ['ownerWorkspace', channel.ownerWorkspace],
    ['reviewerWorkspace', channel.reviewerWorkspace],
    ['arbiterWorkspace', channel.arbiterWorkspace],
  ]) {
    if (!workspaceValue) {
      continue;
    }
    const resolvedRoleWorkspace = resolveProjectPath(projectRoot, workspaceValue);
    assert(
      fs.existsSync(resolvedRoleWorkspace),
      `${fieldName} does not exist: ${resolvedRoleWorkspace}`,
    );
    assert(
      fs.statSync(resolvedRoleWorkspace).isDirectory(),
      `${fieldName} must be a directory: ${resolvedRoleWorkspace}`,
    );
  }
  assert(config.agents[channel.agent], `Channel references unknown agent "${channel.agent}".`);
  const hasTribunal = channel.mode === 'tribunal';
  if (hasTribunal) {
    assert(channel.reviewer, 'Tribunal channel requires a reviewer.');
    assert(channel.arbiter, 'Tribunal channel requires an arbiter.');
  } else {
    assert(!channel.reviewer, 'Single channel cannot define a reviewer.');
    assert(!channel.arbiter, 'Single channel cannot define an arbiter.');
  }
  if (channel.reviewer) {
    assert(config.agents[channel.reviewer], `Channel references unknown reviewer "${channel.reviewer}".`);
    assert(channel.reviewer !== channel.agent, 'Reviewer must be different from the owner agent.');
  }
  if (channel.arbiter) {
    assert(config.agents[channel.arbiter], `Channel references unknown arbiter "${channel.arbiter}".`);
    assert(channel.arbiter !== channel.agent, 'Arbiter must be different from the owner agent.');
    assert(
      channel.arbiter !== channel.reviewer,
      'Arbiter must be different from the reviewer agent.',
    );
  }
  if (channel.reviewRounds !== undefined) {
    assert(
      Number.isInteger(channel.reviewRounds) && channel.reviewRounds > 0,
      'reviewRounds must be a positive integer.',
    );
    assert(hasTribunal, 'reviewRounds requires a tribunal channel.');
  }
}

function validateKakaoChannelRouteUniqueness(config, candidate) {
  if ((candidate.platform || 'discord') !== 'kakao') {
    return;
  }
  const candidateRoute = getKakaoChannelRouteKey(candidate);
  for (const [channelName, channel] of Object.entries(config.channels || {})) {
    if (channelName === candidate.name || (channel.name && channel.name === candidate.name)) {
      continue;
    }
    if ((channel.platform || 'discord') !== 'kakao') {
      continue;
    }
    if (getKakaoChannelRouteKey(channel) !== candidateRoute) {
      continue;
    }
    if (!kakaoChannelFiltersOverlap(candidate, channel)) {
      continue;
    }
    assert(
      false,
      `Kakao channel "${candidate.name}" overlaps with "${channelName}" for ${formatKakaoRouteKey(candidateRoute)}. Narrow kakaoChannelId or kakaoUserId so only one channel can match each inbound message.`,
    );
  }
}

function getKakaoChannelRouteKey(channel) {
  if (channel.connector) {
    return `connector:${channel.connector}`;
  }
  return `legacy:${channel.agent || ''}`;
}

function formatKakaoRouteKey(routeKey) {
  if (routeKey.startsWith('connector:')) {
    return `connector "${routeKey.slice('connector:'.length)}"`;
  }
  return `legacy agent "${routeKey.slice('legacy:'.length)}"`;
}

function kakaoChannelFiltersOverlap(left, right) {
  return (
    kakaoChannelIdFiltersOverlap(left.kakaoChannelId, right.kakaoChannelId) &&
    kakaoUserIdFiltersOverlap(left.kakaoUserId, right.kakaoUserId)
  );
}

function kakaoChannelIdFiltersOverlap(left, right) {
  const leftValue = normalizeKakaoChannelIdFilter(left);
  const rightValue = normalizeKakaoChannelIdFilter(right);
  return leftValue === '*' || rightValue === '*' || leftValue === rightValue;
}

function kakaoUserIdFiltersOverlap(left, right) {
  const leftValue = normalizeKakaoUserIdFilter(left);
  const rightValue = normalizeKakaoUserIdFilter(right);
  return !leftValue || !rightValue || leftValue === rightValue;
}

function normalizeKakaoChannelIdFilter(value) {
  return String(value || '*').trim() || '*';
}

function normalizeKakaoUserIdFilter(value) {
  return String(value || '').trim();
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

function normalizeManagementPolicy(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  assert(isPlainObject(value), 'managementPolicy must be an object.');

  const policy = {
    canApply: resolveBooleanValue(value.canApply ?? value['can-apply'], false),
    canPlan: resolveBooleanValue(value.canPlan ?? value['can-plan'], false),
    allowInlineSecrets: resolveBooleanValue(
      value.allowInlineSecrets ?? value['allow-inline-secrets'],
      false,
    ),
    allowServiceControl: resolveBooleanValue(
      value.allowServiceControl ?? value['allow-service-control'],
      false,
    ),
    allowedActions: normalizeStringList(
      value.allowedActions ?? value['allowed-actions'],
    ),
    allowedNamePrefixes: normalizeStringList(
      value.allowedNamePrefixes ?? value['allowed-name-prefixes'],
    ),
    allowedPlatforms: normalizeStringList(
      value.allowedPlatforms ?? value['allowed-platforms'],
    ),
    allowedWorkspaces: normalizeStringList(
      value.allowedWorkspaces ?? value['allowed-workspaces'],
    ),
    maxChangesPerApply: parseOptionalInteger(
      value.maxChangesPerApply ?? value['max-changes-per-apply'],
      'managementPolicy.maxChangesPerApply',
    ),
  };

  return sortObjectKeys(policy);
}

function normalizeStringList(value) {
  const values = Array.isArray(value)
    ? value.flatMap((entry) => normalizeStringList(entry) ?? [])
    : parseCommaSeparatedList(value);
  const unique = [
    ...new Set(values.map((entry) => String(entry).trim()).filter(Boolean)),
  ];
  return unique.length > 0 ? unique : undefined;
}

function validateManagementPolicy(policy) {
  assert(isPlainObject(policy), 'managementPolicy must be an object.');
  for (const fieldName of [
    'canApply',
    'canPlan',
    'allowInlineSecrets',
    'allowServiceControl',
  ]) {
    if (policy[fieldName] !== undefined) {
      assert(
        typeof policy[fieldName] === 'boolean',
        `managementPolicy.${fieldName} must be a boolean.`,
      );
    }
  }
  for (const fieldName of [
    'allowedActions',
    'allowedNamePrefixes',
    'allowedPlatforms',
    'allowedWorkspaces',
  ]) {
    if (policy[fieldName] !== undefined) {
      assert(
        Array.isArray(policy[fieldName]) &&
          policy[fieldName].every(
            (entry) => typeof entry === 'string' && entry.trim(),
          ),
        `managementPolicy.${fieldName} must be a list of non-empty strings.`,
      );
    }
  }
  if (policy.maxChangesPerApply !== undefined) {
    assert(
      Number.isInteger(policy.maxChangesPerApply) && policy.maxChangesPerApply > 0,
      'managementPolicy.maxChangesPerApply must be a positive integer.',
    );
  }
}

function normalizeMessagingConnectorRecords(connectors, rawAgents = {}) {
  const next = normalizeConnectorRecords(connectors);
  const agents = isPlainObject(rawAgents) ? rawAgents : {};

  for (const [agentName, agent] of Object.entries(agents)) {
    if (!isPlainObject(agent) || next[agentName]) {
      continue;
    }
    const platform = resolveMessagingPlatform(agent.platform, agent);
    const legacyConnector = buildLegacyAgentConnector(platform, agent);
    if (legacyConnector) {
      next[agentName] = buildConnectorDefinition(agentName, legacyConnector);
    }
  }

  return next;
}

function normalizeConnectorRecords(connectors) {
  if (!isPlainObject(connectors)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(connectors).map(([name, connector]) => [
      name,
      normalizeConnectorRecord(name, connector),
    ]),
  );
}

function normalizeConnectorRecord(name, connector) {
  const type = resolveMessagingPlatform(connector?.type ?? connector?.platform, connector);
  if (type === 'kakao') {
    return buildConnectorDefinition(name, connector);
  }

  return normalizeLegacyNonKakaoConnector(type, connector);
}

function normalizeLegacyNonKakaoConnector(type, connector = {}) {
  const normalizedType = type === 'telegram' ? 'telegram' : 'discord';
  const next = {
    type: normalizedType,
    description: normalizeOptionalString(connector.description),
  };
  if (normalizedType === 'telegram') {
    next.telegramBotToken = normalizeOptionalString(
      connector.telegramBotToken ?? connector['telegram-bot-token'],
    );
  } else {
    next.discordToken = normalizeOptionalString(connector.discordToken ?? connector['discord-token']);
  }
  return sortObjectKeys(next);
}

function buildLegacyAgentConnector(platform, agent) {
  if (platform === 'kakao') {
    return {
      type: 'kakao',
      kakaoRelayUrl: normalizeOptionalString(agent.kakaoRelayUrl),
      kakaoRelayToken: normalizeOptionalString(agent.kakaoRelayToken),
      kakaoSessionToken: normalizeOptionalString(agent.kakaoSessionToken),
      description: 'Migrated from agent platform settings',
    };
  }
  return null;
}

function normalizeLegacyAgentRecords(agents) {
  if (!isPlainObject(agents)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => {
      if (!isPlainObject(agent)) {
        return [name, agent];
      }
      const next = { ...agent };
      delete next.historyWindow;
      delete next.workdir;
      delete next.env;
      if (typeof next.token === 'string' && next.discordToken === undefined) {
        next.discordToken = next.token;
      }
      if (!next.platform) {
        next.platform =
          typeof next.kakaoRelayToken === 'string' && next.kakaoRelayToken.trim()
            ? 'kakao'
            : typeof next.telegramBotToken === 'string' && next.telegramBotToken.trim()
              ? 'telegram'
              : 'discord';
      }
      delete next.token;
      return [name, next];
    }),
  );
}

function mergeLegacyBotTokensIntoAgents(agents, bots) {
  const nextAgents = { ...agents };
  for (const [botName, bot] of Object.entries(bots || {})) {
    if (!isPlainObject(bot) || !bot.agent || !nextAgents[bot.agent]) {
      continue;
    }
    if (
      typeof bot.discordToken === 'string' &&
      bot.discordToken.trim() &&
      nextAgents[bot.agent].discordToken === undefined
    ) {
      nextAgents[bot.agent] = {
        ...nextAgents[bot.agent],
        discordToken: bot.discordToken.trim(),
      };
    }
  }
  return nextAgents;
}

function normalizeLegacyBotRecords(bots) {
  if (!isPlainObject(bots)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(bots).map(([name, bot]) => {
      if (!isPlainObject(bot)) {
        return [name, bot];
      }
      const next = { ...bot };
      if (typeof next.token === 'string' && next.discordToken === undefined) {
        next.discordToken = next.token;
      }
      delete next.token;
      return [name, next];
    }),
  );
}

function normalizeLegacyChannelRecords(channels, rawAgents, rawBots = {}) {
  if (!isPlainObject(channels)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(channels).map(([name, channel]) => {
      if (!isPlainObject(channel)) {
        return [name, channel];
      }
      const next = { ...channel };
      if (!next.bot && typeof next.ownerBot === 'string') {
        next.bot = next.ownerBot;
      }
      if (!next.workspace) {
        const ownerAgent =
          isPlainObject(rawAgents) && isPlainObject(rawAgents[next.agent])
            ? rawAgents[next.agent]
            : null;
        next.workspace =
          next.workdir || ownerAgent?.workdir || getDefaultChannelWorkspace();
      }
      if (!next.mode) {
        next.mode = next.reviewer || next.arbiter ? 'tribunal' : 'single';
      }
      if (!next.platform) {
        next.platform =
          typeof next.kakaoChannelId === 'string' && next.kakaoChannelId.trim()
            ? 'kakao'
            : typeof next.telegramChatId === 'string' && next.telegramChatId.trim()
              ? 'telegram'
              : 'discord';
      }
      if (typeof next.ownerBot === 'string' && !next.bot) {
        next.bot = next.ownerBot;
      }
      if (typeof next.bot === 'string' && !next.agent) {
        next.agent = resolveLegacyBotAgentName(rawBots, next.bot);
      }
      if (typeof next.reviewerBot === 'string' && !next.reviewer) {
        next.reviewer = resolveLegacyBotAgentName(rawBots, next.reviewerBot);
      }
      if (typeof next.arbiterBot === 'string' && !next.arbiter) {
        next.arbiter = resolveLegacyBotAgentName(rawBots, next.arbiterBot);
      }
      delete next.ownerBot;
      delete next.bot;
      delete next.reviewerBot;
      delete next.arbiterBot;
      delete next.workdir;
      return [name, next];
    }),
  );
}

function resolveMessagingPlatform(value, existing = {}) {
  const normalized = normalizeOptionalString(value);
  if (normalized) {
    return normalized;
  }
  if (typeof existing?.telegramBotToken === 'string' && existing.telegramBotToken.trim()) {
    return 'telegram';
  }
  if (typeof existing?.telegramChatId === 'string' && existing.telegramChatId.trim()) {
    return 'telegram';
  }
  if (typeof existing?.kakaoRelayToken === 'string' && existing.kakaoRelayToken.trim()) {
    return 'kakao';
  }
  if (typeof existing?.kakaoSessionToken === 'string' && existing.kakaoSessionToken.trim()) {
    return 'kakao';
  }
  if (typeof existing?.kakaoRelayUrl === 'string' && existing.kakaoRelayUrl.trim()) {
    return 'kakao';
  }
  if (typeof existing?.kakaoChannelId === 'string' && existing.kakaoChannelId.trim()) {
    return 'kakao';
  }
  return 'discord';
}

function resolveOptionalChannelAgentName(explicitAgentName) {
  return normalizeOptionalString(explicitAgentName);
}

function resolveLegacyBotAgentName(rawBots, botName) {
  const bot = isPlainObject(rawBots) ? rawBots[botName] : null;
  if (!isPlainObject(bot) || typeof bot.agent !== 'string' || !bot.agent.trim()) {
    return undefined;
  }
  return bot.agent.trim();
}

function normalizeLegacyDashboardRecords(dashboards) {
  if (!isPlainObject(dashboards)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(dashboards).map(([name, dashboard]) => {
      if (!isPlainObject(dashboard)) {
        return [name, dashboard];
      }
      const next = { ...dashboard };
      delete next.showSessions;
      return [name, next];
    }),
  );
}

function normalizeLocalLlmConnectionRecords(connections) {
  if (!isPlainObject(connections) || Object.keys(connections).length === 0) {
    return createDefaultLocalLlmConnections();
  }

  return Object.fromEntries(
    Object.entries(connections).map(([name, connection]) => [
      name,
      buildLocalLlmConnectionDefinition(name, connection),
    ]),
  );
}

function createDefaultLocalLlmConnections() {
  return {
    LLM1: buildLocalLlmConnectionDefinition('LLM1', {
      baseUrl: DEFAULT_LOCAL_LLM_BASE_URL,
      apiKey: '',
    }),
  };
}

function normalizePathEntries(value) {
  const entries = Array.isArray(value)
    ? value.flatMap((entry) => normalizePathEntries(entry) ?? [])
    : parseCommaSeparatedList(value);
  const unique = [...new Set(entries)];
  return unique.length > 0 ? unique : undefined;
}

function validateLocalLlmConnections(value) {
  assert(isPlainObject(value), 'localLlmConnections must be an object.');
  const names = Object.keys(value);
  assert(names.length > 0, 'At least one local LLM connection is required.');
  for (const [name, connection] of Object.entries(value)) {
    validateLocalLlmConnectionDefinition(name, connection);
  }
}

function validateLocalLlmConnectionDefinition(name, connection) {
  assert(
    typeof connection?.baseUrl === 'string' && connection.baseUrl.trim().length > 0,
    `Local LLM connection "${name}" requires a baseUrl.`,
  );
  if (connection?.apiKey !== undefined) {
    assert(
      typeof connection.apiKey === 'string',
      `Local LLM connection "${name}" apiKey must be a string.`,
    );
  }
  if (connection?.description !== undefined) {
    assert(
      typeof connection.description === 'string',
      `Local LLM connection "${name}" description must be a string.`,
    );
  }
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
  delete next.env;
  return next;
}

export function resolveProjectPath(projectRoot, maybeRelativePath) {
  const rawPath = String(maybeRelativePath || '').trim();
  if (!rawPath || rawPath === '~') {
    return os.homedir();
  }
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return path.resolve(projectRoot, rawPath);
}
