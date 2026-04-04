import fs from 'node:fs';

import {
  AGENT_TYPE_CHOICES,
  CLAUDE_PERMISSION_MODE_CHOICES,
  CODEX_SANDBOX_CHOICES,
  DASHBOARD_ALL_AGENTS,
} from './constants.js';
import { withPrompter } from './interactive.js';
import { buildPromptEnvelope } from './prompt.js';
import { inspectAgentRuntime, runAgentTurn } from './runners.js';
import {
  appendTurn,
  clearSession,
  deleteSession,
  formatSession,
  listSessions,
  loadExistingSession,
  loadSession,
  resolveSessionId,
  saveSession,
  summarizeSessions,
} from './session-store.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  buildDashboardDefinition,
  getAgent,
  getChannel,
  getDashboard,
  getProjectLayout,
  initProject,
  listAgents,
  listChannels,
  listDashboards,
  loadConfig,
  removeAgent,
  removeChannel,
  removeDashboard,
  resolveProjectPath,
  resolveProjectRoot,
  saveConfig,
} from './store.js';
import {
  assert,
  getBooleanFlag,
  getFlagValue,
  humanDate,
  parseKeyValueText,
  parseArgs,
  sleep,
  stdinHasData,
  readStdin,
  toErrorMessage,
} from './utils.js';

export async function main(argv) {
  try {
    const { rootOverride, rest } = extractGlobalOptions(argv);
    const [command, ...tail] = rest;

    if (!command || ['help', '--help', '-h'].includes(command)) {
      printHelp();
      return;
    }

    if (command === 'init') {
      const projectRoot = rootOverride ? rootOverride : process.cwd();
      const { flags } = parseArgs(tail);
      initProject(projectRoot, { force: getBooleanFlag(flags, 'force') });
      const layout = getProjectLayout(projectRoot);
      console.log(`Initialized hkclaw-lite at ${layout.toolRoot}`);
      console.log('Next step: hkclaw-lite add agent');
      return;
    }

    const projectRoot = resolveProjectRoot(process.cwd(), rootOverride);

    switch (command) {
      case 'add':
        await handleAddCommand(projectRoot, tail);
        return;
      case 'edit':
        await handleEditCommand(projectRoot, tail);
        return;
      case 'remove':
        await handleRemoveCommand(projectRoot, tail);
        return;
      case 'list':
        await handleListCommand(projectRoot, tail);
        return;
      case 'show':
        await handleShowCommand(projectRoot, tail);
        return;
      case 'chat':
        await handleChatCommand(projectRoot, tail);
        return;
      case 'session':
        await handleSessionCommand(projectRoot, tail);
        return;
      case 'dashboard':
        await handleDashboardCommand(projectRoot, tail);
        return;
      case 'status':
        await handleStatusCommand(projectRoot, tail);
        return;
      case 'run':
        throw new Error('The run command was removed. Use "hkclaw-lite chat <agent>" instead.');
      case 'service':
        throw new Error(
          'The service command was removed. Use "add agent", "edit agent", "remove agent", "list", and "show".',
        );
      default:
        throw new Error(`Unknown command "${command}". Run "hkclaw-lite help".`);
    }
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

function extractGlobalOptions(argv) {
  const rest = [];
  let rootOverride = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--root') {
      rootOverride = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--root=')) {
      rootOverride = token.slice('--root='.length);
      continue;
    }
    rest.push(token);
  }

  return { rootOverride, rest };
}

async function handleAddCommand(projectRoot, argv) {
  const [kind, ...tail] = argv;
  const config = loadConfig(projectRoot);

  if (kind === 'agent') {
    const { positionals, flags } = parseArgs(tail);
    const preset = buildAgentPreset(positionals[0], flags);
    const definition = await withPrompter((prompter) =>
      promptForAgentDefinition(prompter, projectRoot, config, {
        mode: 'add',
        initial: preset,
      }),
    );
    assert(!config.agents[definition.name], `Agent "${definition.name}" already exists.`);
    config.agents[definition.name] = buildAgentDefinition(
      projectRoot,
      definition.name,
      definition,
    );
    saveConfig(projectRoot, config);
    console.log(`Added agent "${definition.name}".`);
    console.log(`Next step: hkclaw-lite chat ${definition.name}`);
    return;
  }

  if (kind === 'dashboard') {
    const { positionals, flags } = parseArgs(tail);
    const preset = buildDashboardPreset(positionals[0], flags);
    const definition = await withPrompter((prompter) =>
      promptForDashboardDefinition(prompter, projectRoot, config, {
        mode: 'add',
        initial: preset,
      }),
    );
    assert(
      !config.dashboards[definition.name],
      `Dashboard "${definition.name}" already exists.`,
    );
    config.dashboards[definition.name] = buildDashboardDefinition(
      projectRoot,
      definition.name,
      definition,
      config,
    );
    saveConfig(projectRoot, config);
    console.log(`Added dashboard "${definition.name}".`);
    console.log(`Next step: hkclaw-lite dashboard ${definition.name}`);
    return;
  }

  if (kind === 'channel') {
    assert(
      Object.keys(config.agents).length > 0,
      'Add at least one agent before adding a channel.',
    );
    const { positionals, flags } = parseArgs(tail);
    const preset = buildChannelPreset(positionals[0], flags);
    const definition = await withPrompter((prompter) =>
      promptForChannelDefinition(prompter, config, {
        mode: 'add',
        initial: preset,
      }),
    );
    assert(!config.channels[definition.name], `Channel "${definition.name}" already exists.`);
    config.channels[definition.name] = buildChannelDefinition(
      config,
      definition.name,
      definition,
    );
    saveConfig(projectRoot, config);
    console.log(`Added channel "${definition.name}".`);
    console.log(`Next step: hkclaw-lite chat --channel ${definition.name}`);
    return;
  }

  throw new Error('Usage: hkclaw-lite add <agent|channel|dashboard>');
}

async function handleEditCommand(projectRoot, argv) {
  const [kind, ...tail] = argv;
  const config = loadConfig(projectRoot);

  if (kind === 'agent') {
    const { positionals } = parseArgs(tail);
    const name = positionals[0];
    assert(name, 'Usage: hkclaw-lite edit agent <name>');
    const existing = getAgent(config, name);
    const definition = await withPrompter((prompter) =>
      promptForAgentDefinition(prompter, projectRoot, config, {
        mode: 'edit',
        initial: existing,
      }),
    );
    if (definition.name !== name) {
      assert(!config.agents[definition.name], `Agent "${definition.name}" already exists.`);
      for (const dashboard of Object.values(config.dashboards)) {
        if (dashboard.monitors?.includes?.(name)) {
          dashboard.monitors = dashboard.monitors.map((entry) =>
            entry === name ? definition.name : entry,
          );
        }
      }
      for (const channel of Object.values(config.channels)) {
        if (channel.agent === name) {
          channel.agent = definition.name;
        }
      }
      delete config.agents[name];
    }
    config.agents[definition.name] = buildAgentDefinition(
      projectRoot,
      definition.name,
      definition,
      config.agents[definition.name] || existing,
    );
    saveConfig(projectRoot, config);
    console.log(`Updated agent "${definition.name}".`);
    return;
  }

  if (kind === 'dashboard') {
    const { positionals } = parseArgs(tail);
    const name = positionals[0];
    assert(name, 'Usage: hkclaw-lite edit dashboard <name>');
    const existing = getDashboard(config, name);
    const definition = await withPrompter((prompter) =>
      promptForDashboardDefinition(prompter, projectRoot, config, {
        mode: 'edit',
        initial: existing,
      }),
    );
    if (definition.name !== name) {
      assert(
        !config.dashboards[definition.name],
        `Dashboard "${definition.name}" already exists.`,
      );
      delete config.dashboards[name];
    }
    config.dashboards[definition.name] = buildDashboardDefinition(
      projectRoot,
      definition.name,
      definition,
      config,
      config.dashboards[definition.name] || existing,
    );
    saveConfig(projectRoot, config);
    console.log(`Updated dashboard "${definition.name}".`);
    return;
  }

  if (kind === 'channel') {
    const { positionals } = parseArgs(tail);
    const name = positionals[0];
    assert(name, 'Usage: hkclaw-lite edit channel <name>');
    const existing = getChannel(config, name);
    const definition = await withPrompter((prompter) =>
      promptForChannelDefinition(prompter, config, {
        mode: 'edit',
        initial: existing,
      }),
    );
    if (definition.name !== name) {
      assert(!config.channels[definition.name], `Channel "${definition.name}" already exists.`);
      delete config.channels[name];
    }
    config.channels[definition.name] = buildChannelDefinition(
      config,
      definition.name,
      definition,
      config.channels[definition.name] || existing,
    );
    saveConfig(projectRoot, config);
    console.log(`Updated channel "${definition.name}".`);
    return;
  }

  throw new Error('Usage: hkclaw-lite edit <agent|channel|dashboard> <name>');
}

async function handleRemoveCommand(projectRoot, argv) {
  const [kind, ...tail] = argv;
  const config = loadConfig(projectRoot);
  const { positionals, flags } = parseArgs(tail);
  const name = positionals[0];
  const force = getBooleanFlag(flags, 'yes');

  if (kind === 'agent') {
    assert(name, 'Usage: hkclaw-lite remove agent <name> [--yes]');
    getAgent(config, name);
    const blockingChannels = listChannels(config)
      .filter((channel) => channel.agent === name)
      .map((channel) => channel.name);
    const blockingDashboards = listDashboards(config)
      .filter(
        (dashboard) =>
          !dashboard.monitors.includes(DASHBOARD_ALL_AGENTS) &&
          dashboard.monitors.includes(name),
      )
      .map((dashboard) => dashboard.name);
    assert(
      blockingDashboards.length === 0 && blockingChannels.length === 0,
      [
        blockingDashboards.length > 0
          ? `dashboards: ${blockingDashboards.join(', ')}`
          : null,
        blockingChannels.length > 0 ? `channels: ${blockingChannels.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(' | ')
        ? `Agent "${name}" is referenced by ${[
            blockingDashboards.length > 0
              ? `dashboards: ${blockingDashboards.join(', ')}`
              : null,
            blockingChannels.length > 0 ? `channels: ${blockingChannels.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join(' | ')}.`
        : '',
    );
    const confirmed = force
      ? true
      : await withPrompter((prompter) =>
          prompter.askConfirm(`Remove agent "${name}"?`, { defaultValue: false }),
        );
    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }
    removeAgent(config, name);
    saveConfig(projectRoot, config);
    console.log(`Removed agent "${name}".`);
    return;
  }

  if (kind === 'dashboard') {
    assert(name, 'Usage: hkclaw-lite remove dashboard <name> [--yes]');
    getDashboard(config, name);
    const confirmed = force
      ? true
      : await withPrompter((prompter) =>
          prompter.askConfirm(`Remove dashboard "${name}"?`, {
            defaultValue: false,
          }),
        );
    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }
    removeDashboard(config, name);
    saveConfig(projectRoot, config);
    console.log(`Removed dashboard "${name}".`);
    return;
  }

  if (kind === 'channel') {
    assert(name, 'Usage: hkclaw-lite remove channel <name> [--yes]');
    getChannel(config, name);
    const confirmed = force
      ? true
      : await withPrompter((prompter) =>
          prompter.askConfirm(`Remove channel "${name}"?`, {
            defaultValue: false,
          }),
        );
    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }
    removeChannel(config, name);
    saveConfig(projectRoot, config);
    console.log(`Removed channel "${name}".`);
    return;
  }

  throw new Error('Usage: hkclaw-lite remove <agent|channel|dashboard> <name>');
}

async function handleListCommand(projectRoot, argv) {
  const [kind] = argv;
  const config = loadConfig(projectRoot);

  if (!kind || kind === 'all') {
    printAgents(listAgents(config));
    console.log('');
    printChannels(listChannels(config));
    console.log('');
    printDashboards(listDashboards(config));
    return;
  }

  if (['agent', 'agents'].includes(kind)) {
    printAgents(listAgents(config));
    return;
  }

  if (['dashboard', 'dashboards'].includes(kind)) {
    printDashboards(listDashboards(config));
    return;
  }

  if (['channel', 'channels'].includes(kind)) {
    printChannels(listChannels(config));
    return;
  }

  throw new Error('Usage: hkclaw-lite list [agents|channels|dashboards|all]');
}

async function handleShowCommand(projectRoot, argv) {
  const [kind, name] = argv;
  const config = loadConfig(projectRoot);

  if (kind === 'agent') {
    assert(name, 'Usage: hkclaw-lite show agent <name>');
    console.log(JSON.stringify(getAgent(config, name), null, 2));
    return;
  }

  if (kind === 'dashboard') {
    assert(name, 'Usage: hkclaw-lite show dashboard <name>');
    console.log(JSON.stringify(getDashboard(config, name), null, 2));
    return;
  }

  if (kind === 'channel') {
    assert(name, 'Usage: hkclaw-lite show channel <name>');
    console.log(JSON.stringify(getChannel(config, name), null, 2));
    return;
  }

  throw new Error('Usage: hkclaw-lite show <agent|channel|dashboard> <name>');
}

async function handleChatCommand(projectRoot, argv) {
  const { flags, positionals } = parseArgs(argv);
  const config = loadConfig(projectRoot);
  const chatTarget = await resolveChatTarget(config, positionals, flags);
  const sessionId =
    getFlagValue(flags, 'session') ||
    (getBooleanFlag(flags, 'last')
      ? resolveSessionId(projectRoot, chatTarget.agent.name, { useLast: true })
      : chatTarget.channel
        ? `channel-${chatTarget.channel.name}`
        : resolveSessionId(projectRoot, chatTarget.agent.name, {}));

  const message = await resolvePromptText(chatTarget.messagePositionals, flags, {
    allowEmpty: true,
  });
  if (message) {
    const response = await executeChatTurn({
      projectRoot,
      config,
      agent: chatTarget.agent,
      channel: chatTarget.channel,
      sessionId,
      prompt: message,
    });
    console.log(response);
    return;
  }

  await startInteractiveChat(
    projectRoot,
    config,
    chatTarget.agent,
    sessionId,
    chatTarget.channel,
  );
}

async function handleSessionCommand(projectRoot, argv) {
  const [subcommand, ...tail] = argv;
  switch (subcommand) {
    case 'list': {
      const { positionals } = parseArgs(tail);
      const agentName = positionals[0] || null;
      const sessions = listSessions(projectRoot, agentName);
      if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
      }
      for (const session of sessions) {
        console.log(
          `${session.agent}/${session.id}\tupdated=${humanDate(session.updatedAt)}\tturns=${session.turnCount}`,
        );
      }
      return;
    }
    case 'show': {
      const { positionals } = parseArgs(tail);
      const [agentName, sessionId] = positionals;
      assert(agentName && sessionId, 'Usage: hkclaw-lite session show <agent> <session>');
      console.log(formatSession(loadExistingSession(projectRoot, agentName, sessionId)));
      return;
    }
    case 'clear': {
      const { positionals } = parseArgs(tail);
      const [agentName, sessionId] = positionals;
      assert(agentName && sessionId, 'Usage: hkclaw-lite session clear <agent> <session>');
      clearSession(projectRoot, agentName, sessionId);
      console.log(`Cleared session "${sessionId}" for "${agentName}".`);
      return;
    }
    case 'remove': {
      const { positionals } = parseArgs(tail);
      const [agentName, sessionId] = positionals;
      assert(agentName && sessionId, 'Usage: hkclaw-lite session remove <agent> <session>');
      deleteSession(projectRoot, agentName, sessionId);
      console.log(`Removed session "${sessionId}" for "${agentName}".`);
      return;
    }
    default:
      throw new Error('Usage: hkclaw-lite session <list|show|clear|remove> ...');
  }
}

async function handleDashboardCommand(projectRoot, argv) {
  const { flags, positionals } = parseArgs(argv);
  const config = loadConfig(projectRoot);
  const dashboards = listDashboards(config);

  if (dashboards.length === 0) {
    console.log('No dashboards configured.');
    return;
  }

  const dashboardName = await resolveDashboardName(config, positionals[0]);
  const dashboard = getDashboard(config, dashboardName);
  const once = getBooleanFlag(flags, 'once') || !process.stdout.isTTY;

  if (once) {
    console.log(renderDashboard(projectRoot, config, dashboard));
    return;
  }

  while (true) {
    process.stdout.write('\x1bc');
    console.log(renderDashboard(projectRoot, config, dashboard));
    console.log('');
    console.log('Press Ctrl+C to exit.');
    await sleep(dashboard.refreshMs);
  }
}

async function handleStatusCommand(projectRoot, argv) {
  const config = loadConfig(projectRoot);
  const [kind, name] = argv;

  if (!kind) {
    console.log(renderAgentStatusReport(projectRoot, config, listAgents(config)));
    return;
  }

  if (kind === 'agent') {
    assert(name, 'Usage: hkclaw-lite status agent <name>');
    console.log(renderAgentStatusReport(projectRoot, config, [getAgent(config, name)]));
    return;
  }

  if (kind === 'channel') {
    assert(name, 'Usage: hkclaw-lite status channel <name>');
    console.log(renderChannelStatus(config, getChannel(config, name)));
    return;
  }

  if (kind === 'dashboard') {
    assert(name, 'Usage: hkclaw-lite status dashboard <name>');
    console.log(renderDashboard(projectRoot, config, getDashboard(config, name)));
    return;
  }

  if (config.agents[kind]) {
    console.log(renderAgentStatusReport(projectRoot, config, [getAgent(config, kind)]));
    return;
  }

  if (config.channels[kind]) {
    console.log(renderChannelStatus(config, getChannel(config, kind)));
    return;
  }

  if (config.dashboards[kind]) {
    console.log(renderDashboard(projectRoot, config, getDashboard(config, kind)));
    return;
  }

  throw new Error(
    'Usage: hkclaw-lite status [agent <name>|channel <name>|dashboard <name>|<name>]',
  );
}

async function executeChatTurn({
  projectRoot,
  config,
  agent,
  channel,
  sessionId,
  prompt,
}) {
  const session = loadSession(projectRoot, agent.name, sessionId);
  const fullPrompt = buildPromptEnvelope({
    projectRoot,
    config,
    agent,
    channel,
    session,
    userPrompt: prompt,
  });
  const response = await runAgentTurn({
    projectRoot,
    agent,
    prompt: fullPrompt,
    rawPrompt: prompt,
    sessionId,
  });
  appendTurn(session, prompt, response);
  saveSession(projectRoot, session);
  return response;
}

async function resolvePromptText(positionals, flags, { allowEmpty = false } = {}) {
  const inlineMessage = getFlagValue(flags, 'message');
  if (inlineMessage) {
    return inlineMessage;
  }
  if (positionals.length > 0) {
    return positionals.join(' ').trim();
  }
  if (stdinHasData()) {
    const stdinText = (await readStdin()).trim();
    if (stdinText) {
      return stdinText;
    }
  }
  if (allowEmpty) {
    return '';
  }
  throw new Error('Prompt is required. Pass text, --message, or pipe stdin.');
}

async function startInteractiveChat(projectRoot, config, agent, sessionId, channel = null) {
  console.log(`agent=${agent.name}`);
  if (channel) {
    console.log(`channel=${channel.name}`);
  }
  console.log(`session=${sessionId}`);
  console.log('Commands: .help .history .clear .exit');

  await withPrompter(async (prompter) => {
    while (true) {
      const line = (await prompter.askText(`${agent.name}>`, { allowEmpty: true })).trim();
      if (!line) {
        continue;
      }
      if (line === '.exit' || line === '.quit') {
        break;
      }
      if (line === '.help') {
        console.log('Commands: .help .history .clear .exit');
        continue;
      }
      if (line === '.history') {
        console.log(formatSession(loadSession(projectRoot, agent.name, sessionId)));
        continue;
      }
      if (line === '.clear') {
        clearSession(projectRoot, agent.name, sessionId);
        console.log('Session cleared.');
        continue;
      }

      const response = await executeChatTurn({
        projectRoot,
        config,
        agent,
        channel,
        sessionId,
        prompt: line,
      });
      console.log(response);
    }
  });
}

async function promptForAgentDefinition(prompter, projectRoot, config, options) {
  const initial = options.initial || {};
  const existingAgentNames = new Set(Object.keys(config.agents));

  const name = await prompter.askText('Agent name', {
    defaultValue: initial.name,
    validate: (value) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        return 'Use only letters, numbers, dot, underscore, and dash.';
      }
      if (
        options.mode === 'add' &&
        existingAgentNames.has(value) &&
        value !== initial.name
      ) {
        return `Agent "${value}" already exists.`;
      }
      if (
        options.mode === 'edit' &&
        value !== initial.name &&
        existingAgentNames.has(value)
      ) {
        return `Agent "${value}" already exists.`;
      }
      return true;
    },
  });

  const agent = await prompter.askChoice(
    'Which agent type do you want to create?',
    AGENT_TYPE_CHOICES,
    {
      defaultValue: initial.agent,
    },
  );

  const workdir = await prompter.askText('Working directory', {
    defaultValue: initial.workdir ?? '.',
    validate: (value) => {
      const resolved = resolveProjectPath(projectRoot, value);
      return fs.existsSync(resolved) ? true : `Directory does not exist: ${resolved}`;
    },
  });

  const model = await prompter.askText('Model (optional)', {
    defaultValue: initial.model,
    allowEmpty: true,
  });
  const effort = await prompter.askText('Effort (optional)', {
    defaultValue: initial.effort,
    allowEmpty: true,
  });
  const historyWindow = await prompter.askText('History window', {
    defaultValue:
      initial.historyWindow ?? config.defaults.historyWindow,
  });
  const timeoutMs = await prompter.askText('Timeout ms (optional)', {
    defaultValue: initial.timeoutMs,
    allowEmpty: true,
  });
  const systemPrompt = await prompter.askText('Inline system prompt (optional)', {
    defaultValue: initial.systemPrompt,
    allowEmpty: true,
  });
  const systemPromptFile = await prompter.askText(
    'System prompt file path (optional)',
    {
      defaultValue: initial.systemPromptFile,
      allowEmpty: true,
      validate: (value) => {
        if (!value) {
          return true;
        }
        const resolved = resolveProjectPath(projectRoot, value);
        return fs.existsSync(resolved) ? true : `File does not exist: ${resolved}`;
      },
    },
  );
  const envText = await prompter.askText(
    'Extra env as KEY=VALUE,KEY=VALUE (optional)',
    {
      defaultValue: formatEnvText(initial.env),
      allowEmpty: true,
    },
  );

  const definition = {
    name,
    agent,
    workdir,
    model,
    effort,
    historyWindow,
    timeoutMs,
    systemPrompt,
    systemPromptFile,
    env: envText ? parseKeyValueText(envText, 'env') : {},
  };

  if (agent === 'codex') {
    definition.sandbox = await prompter.askChoice(
      'Codex sandbox mode',
      CODEX_SANDBOX_CHOICES,
      {
        defaultValue: initial.sandbox,
      },
    );
    if (definition.sandbox === 'danger-full-access') {
      definition.dangerous = await prompter.askConfirm(
        'Bypass Codex sandbox and approval checks?',
        {
          defaultValue: initial.dangerous ?? true,
        },
      );
    }
  }

  if (agent === 'claude-code') {
    definition.permissionMode = await prompter.askChoice(
      'Claude permission mode',
      CLAUDE_PERMISSION_MODE_CHOICES,
      {
        defaultValue: initial.permissionMode,
      },
    );
    definition.dangerous = await prompter.askConfirm(
      'Allow dangerously skip permissions?',
      {
        defaultValue: initial.dangerous ?? false,
      },
    );
  }

  if (agent === 'local-llm') {
    definition.baseUrl = await prompter.askText('Local LLM base URL', {
      defaultValue: initial.baseUrl ?? 'http://127.0.0.1:11434/v1',
    });
  }

  if (agent === 'command') {
    definition.command = await prompter.askText('Command to execute', {
      defaultValue: initial.command,
    });
  }

  return definition;
}

async function promptForDashboardDefinition(prompter, projectRoot, config, options) {
  void projectRoot;
  const initial = options.initial || {};
  const existingDashboardNames = new Set(Object.keys(config.dashboards));
  const name = await prompter.askText('Dashboard name', {
    defaultValue: initial.name,
    validate: (value) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        return 'Use only letters, numbers, dot, underscore, and dash.';
      }
      if (
        options.mode === 'add' &&
        existingDashboardNames.has(value) &&
        value !== initial.name
      ) {
        return `Dashboard "${value}" already exists.`;
      }
      if (
        options.mode === 'edit' &&
        value !== initial.name &&
        existingDashboardNames.has(value)
      ) {
        return `Dashboard "${value}" already exists.`;
      }
      return true;
    },
  });

  const monitorMode = await prompter.askChoice(
    'Which agents should this dashboard monitor?',
    [
      {
        value: 'all',
        label: 'All Agents',
        description: 'Show every current and future agent',
      },
      {
        value: 'selected',
        label: 'Selected Agents',
        description: 'Show only explicit agent names',
      },
    ],
    {
      defaultValue:
        Array.isArray(initial.monitors) &&
        initial.monitors.length === 1 &&
        initial.monitors[0] === DASHBOARD_ALL_AGENTS
          ? 'all'
          : 'selected',
    },
  );

  let monitors = [DASHBOARD_ALL_AGENTS];
  if (monitorMode === 'selected') {
    const agentNames = listAgents(config).map((agent) => agent.name);
    assert(agentNames.length > 0, 'Add at least one agent before selecting specific dashboard targets.');
    console.log(`Available agents: ${agentNames.join(', ')}`);
    monitors = await prompter.askList('Agent names (comma separated or "all")', {
      defaultValue: initial.monitors,
      allowAll: true,
    });
    monitors = monitors[0] === 'all' ? [DASHBOARD_ALL_AGENTS] : monitors;
    for (const agentName of monitors) {
      assert(config.agents[agentName], `Unknown agent "${agentName}".`);
    }
  }

  const refreshMs = await prompter.askText('Refresh interval ms', {
    defaultValue: initial.refreshMs ?? config.defaults.dashboardRefreshMs,
  });
  const showSessions = await prompter.askConfirm('Show session counts?', {
    defaultValue: initial.showSessions ?? true,
  });
  const showDetails = await prompter.askConfirm('Show runtime details?', {
    defaultValue: initial.showDetails ?? true,
  });

  return {
    name,
    monitors,
    refreshMs,
    showSessions,
    showDetails,
  };
}

async function promptForChannelDefinition(prompter, config, options) {
  const initial = options.initial || {};
  const existingChannelNames = new Set(Object.keys(config.channels));
  const name = await prompter.askText('Channel name', {
    defaultValue: initial.name,
    validate: (value) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        return 'Use only letters, numbers, dot, underscore, and dash.';
      }
      if (
        options.mode === 'add' &&
        existingChannelNames.has(value) &&
        value !== initial.name
      ) {
        return `Channel "${value}" already exists.`;
      }
      if (
        options.mode === 'edit' &&
        value !== initial.name &&
        existingChannelNames.has(value)
      ) {
        return `Channel "${value}" already exists.`;
      }
      return true;
    },
  });

  const discordChannelId = await prompter.askText('Discord channel ID', {
    defaultValue: initial.discordChannelId,
  });
  const guildId = await prompter.askText('Discord guild ID (optional)', {
    defaultValue: initial.guildId,
    allowEmpty: true,
  });
  const agent = await prompter.askChoice(
    'Which agent should this channel map to?',
    listAgents(config).map((currentAgent) => ({
      value: currentAgent.name,
      label: currentAgent.name,
      description: `${currentAgent.agent} @ ${currentAgent.workdir}`,
    })),
    {
      defaultValue: initial.agent,
    },
  );
  const description = await prompter.askText('Channel description (optional)', {
    defaultValue: initial.description,
    allowEmpty: true,
  });

  return {
    name,
    discordChannelId,
    guildId,
    agent,
    description,
  };
}

async function resolveChatTarget(config, positionals, flags) {
  const channelFlag = getFlagValue(flags, 'channel');
  const viaChannelCommand = positionals[0] === 'channel';
  const requestedChannelName = channelFlag || (viaChannelCommand ? positionals[1] : null);

  if (requestedChannelName) {
    const channel = getChannel(config, requestedChannelName);
    return {
      agent: getAgent(config, channel.agent),
      channel,
      messagePositionals: viaChannelCommand ? positionals.slice(2) : positionals,
    };
  }

  const agentName = await resolveAgentNameForChat(config, positionals[0]);
  return {
    agent: getAgent(config, agentName),
    channel: null,
    messagePositionals: positionals.slice(1),
  };
}

async function resolveAgentNameForChat(config, explicitName) {
  if (explicitName) {
    return explicitName;
  }
  const agents = listAgents(config);
  assert(agents.length > 0, 'No agents configured. Run "hkclaw-lite add agent" first.');
  if (agents.length === 1) {
    return agents[0].name;
  }
  return withPrompter((prompter) =>
    prompter.askChoice(
      'Which agent do you want to chat with?',
      agents.map((agent) => ({
        value: agent.name,
        label: agent.name,
        description: `${agent.agent} @ ${agent.workdir}`,
      })),
    ),
  );
}

async function resolveDashboardName(config, explicitName) {
  if (explicitName) {
    return explicitName;
  }
  const dashboards = listDashboards(config);
  if (dashboards.length === 1) {
    return dashboards[0].name;
  }
  return withPrompter((prompter) =>
    prompter.askChoice(
      'Which dashboard do you want to open?',
      dashboards.map((dashboard) => ({
        value: dashboard.name,
        label: dashboard.name,
        description: formatDashboardMonitorText(dashboard.monitors),
      })),
    ),
  );
}

function renderAgentStatusReport(projectRoot, config, agents) {
  const lines = [
    `project=${projectRoot}`,
    `agents=${agents.length}`,
    `channels=${listChannels(config).length}`,
  ];
  const sessionSummary = summarizeSessions(projectRoot);
  const channelsByAgent = buildChannelsByAgent(config);

  for (const agent of agents) {
    const runtime = inspectAgentRuntime(projectRoot, agent);
    const sessions = sessionSummary[agent.name] || {
      count: 0,
      latestUpdatedAt: null,
      latestSessionId: null,
    };
    const mappedChannels = channelsByAgent[agent.name] || [];

    lines.push('');
    lines.push(agent.name);
    lines.push(`  type=${agent.agent}`);
    lines.push(`  workdir=${runtime.workdir}`);
    lines.push(`  ready=${runtime.ready ? 'yes' : 'no'}`);
    lines.push(`  detail=${runtime.detail}`);
    lines.push(`  sessions=${sessions.count}`);
    lines.push(`  channels=${mappedChannels.length}`);
    if (mappedChannels.length > 0) {
      lines.push(`  mapped=${mappedChannels.join(', ')}`);
    }
    if (sessions.latestSessionId) {
      lines.push(
        `  latest=${sessions.latestSessionId} @ ${humanDate(sessions.latestUpdatedAt)}`,
      );
    }
  }

  return lines.join('\n');
}

function renderDashboard(projectRoot, config, dashboard) {
  const agentNames = resolveDashboardAgentNames(config, dashboard);
  const agents = agentNames.map((agentName) => getAgent(config, agentName));
  const sessionSummary = summarizeSessions(projectRoot);
  const channelsByAgent = buildChannelsByAgent(config);
  const lines = [
    `dashboard=${dashboard.name}`,
    `monitors=${formatDashboardMonitorText(dashboard.monitors)}`,
    `refreshMs=${dashboard.refreshMs}`,
    `agents=${agents.length}`,
  ];

  for (const agent of agents) {
    const runtime = inspectAgentRuntime(projectRoot, agent);
    const sessions = sessionSummary[agent.name] || {
      count: 0,
      latestUpdatedAt: null,
      latestSessionId: null,
    };
    const mappedChannels = channelsByAgent[agent.name] || [];
    lines.push('');
    lines.push(agent.name);
    lines.push(`  type=${agent.agent}`);
    lines.push(`  ready=${runtime.ready ? 'yes' : 'no'}`);

    if (dashboard.showDetails) {
      lines.push(`  workdir=${runtime.workdir}`);
      lines.push(`  detail=${runtime.detail}`);
      if (agent.model) {
        lines.push(`  model=${agent.model}`);
      }
      lines.push(`  channels=${mappedChannels.length}`);
      if (mappedChannels.length > 0) {
        lines.push(`  mapped=${mappedChannels.join(', ')}`);
      }
    }

    if (dashboard.showSessions) {
      lines.push(`  sessions=${sessions.count}`);
      if (sessions.latestSessionId) {
        lines.push(
          `  latest=${sessions.latestSessionId} @ ${humanDate(sessions.latestUpdatedAt)}`,
        );
      }
    }
  }

  return lines.join('\n');
}

function renderChannelStatus(config, channel) {
  const agent = getAgent(config, channel.agent);
  return [
    `channel=${channel.name}`,
    `discordChannelId=${channel.discordChannelId}`,
    channel.guildId ? `guildId=${channel.guildId}` : null,
    `agent=${channel.agent}`,
    channel.description ? `description=${channel.description}` : null,
    `agentType=${agent.agent}`,
    `agentWorkdir=${agent.workdir}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildChannelsByAgent(config) {
  const output = {};
  for (const channel of listChannels(config)) {
    output[channel.agent] = output[channel.agent] || [];
    output[channel.agent].push(channel.name);
  }
  return output;
}

function resolveDashboardAgentNames(config, dashboard) {
  if (dashboard.monitors.includes(DASHBOARD_ALL_AGENTS)) {
    return listAgents(config).map((agent) => agent.name);
  }
  return dashboard.monitors;
}

function printAgents(agents) {
  console.log('Agents');
  if (agents.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const agent of agents) {
    console.log(`  ${agent.name}\t${agent.agent}\t${agent.workdir}`);
  }
}

function printChannels(channels) {
  console.log('Channels');
  if (channels.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const channel of channels) {
    console.log(
      `  ${channel.name}\t${channel.discordChannelId}\tagent=${channel.agent}`,
    );
  }
}

function printDashboards(dashboards) {
  console.log('Dashboards');
  if (dashboards.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const dashboard of dashboards) {
    console.log(
      `  ${dashboard.name}\t${formatDashboardMonitorText(dashboard.monitors)}\trefresh=${dashboard.refreshMs}ms`,
    );
  }
}

function formatDashboardMonitorText(monitors) {
  return monitors.includes(DASHBOARD_ALL_AGENTS) ? 'all' : monitors.join(', ');
}

function formatEnvText(env) {
  if (!env || typeof env !== 'object') {
    return '';
  }
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function buildAgentPreset(name, flags) {
  return {
    name,
    agent: getFlagValue(flags, 'agent'),
    workdir: getFlagValue(flags, 'workdir'),
    model: getFlagValue(flags, 'model'),
    effort: getFlagValue(flags, 'effort'),
    historyWindow: getFlagValue(flags, 'history-window'),
    timeoutMs: getFlagValue(flags, 'timeout-ms'),
    systemPrompt: getFlagValue(flags, 'system'),
    systemPromptFile: getFlagValue(flags, 'system-file'),
    sandbox: getFlagValue(flags, 'sandbox'),
    permissionMode: getFlagValue(flags, 'permission-mode'),
    dangerous: getFlagValue(flags, 'dangerous'),
    baseUrl: getFlagValue(flags, 'base-url'),
    command: getFlagValue(flags, 'command'),
    env: getFlagValue(flags, 'env')
      ? parseKeyValueText(getFlagValue(flags, 'env'), 'env')
      : undefined,
  };
}

function buildDashboardPreset(name, flags) {
  return {
    name,
    monitors: getFlagValue(flags, 'agents') || getFlagValue(flags, 'monitors'),
    refreshMs: getFlagValue(flags, 'refresh-ms'),
    showSessions: getFlagValue(flags, 'show-sessions'),
    showDetails: getFlagValue(flags, 'show-details'),
  };
}

function buildChannelPreset(name, flags) {
  return {
    name,
    discordChannelId: getFlagValue(flags, 'discord-channel-id'),
    guildId: getFlagValue(flags, 'guild-id'),
    agent: getFlagValue(flags, 'agent'),
    description: getFlagValue(flags, 'description'),
  };
}

function printHelp() {
  console.log(`hkclaw-lite

Discord-only AI agent runtime managed entirely from the CLI.
Agents intentionally run with the full permissions of the host account that launched them.

Usage:
  hkclaw-lite init [--root DIR] [--force]
  hkclaw-lite add agent
  hkclaw-lite add channel
  hkclaw-lite add dashboard
  hkclaw-lite edit agent <name>
  hkclaw-lite edit channel <name>
  hkclaw-lite edit dashboard <name>
  hkclaw-lite remove agent <name> [--yes]
  hkclaw-lite remove channel <name> [--yes]
  hkclaw-lite remove dashboard <name> [--yes]
  hkclaw-lite list [agents|channels|dashboards|all]
  hkclaw-lite show agent <name>
  hkclaw-lite show channel <name>
  hkclaw-lite show dashboard <name>
  hkclaw-lite chat <agent> [--session ID|--last] [--message TEXT]
  hkclaw-lite chat --channel <channel> [--message TEXT]
  hkclaw-lite dashboard [name] [--once]
  hkclaw-lite status
  hkclaw-lite status agent <name>
  hkclaw-lite status channel <name>
  hkclaw-lite status dashboard <name>

Examples:
  hkclaw-lite add agent
  hkclaw-lite add channel
  hkclaw-lite add dashboard
  hkclaw-lite chat dev-codex
  hkclaw-lite chat --channel discord-main
  hkclaw-lite dashboard ops
`);
}
