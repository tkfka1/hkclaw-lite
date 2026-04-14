import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { serveAdmin } from './admin.js';
import {
  createProjectBackup,
  restoreProjectBackup,
  writeProjectBackup,
} from './backup.js';
import {
  buildCiRequest,
  checkGitHubActionsRun,
  checkGitLabCiStatus,
  DEFAULT_CI_WATCH_INTERVAL_MS,
  DEFAULT_CI_WATCH_TIMEOUT_MS,
  formatCiResult,
  watchCi,
} from './ci.js';
import {
  createCiWatcherId,
  getCiWatcherLogPath,
  loadCiWatcher,
  listCiWatchers,
  saveCiWatcher,
} from './ci-watch-store.js';
import { executeChannelTurn } from './channel-runtime.js';
import {
  AGENT_TYPE_CHOICES,
  CLAUDE_PERMISSION_MODE_CHOICES,
  CHANNEL_MODE_CHOICES,
  CODEX_SANDBOX_CHOICES,
  DASHBOARD_ALL_AGENTS,
  DEFAULT_ADMIN_PORT,
  DEFAULT_CHANNEL_WORKSPACE,
} from './constants.js';
import { withPrompter } from './interactive.js';
import { inspectAgentRuntime } from './runners.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  buildDashboardDefinition,
  findProjectRoot,
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
  resolveOrInitProjectRoot,
  resolveProjectPath,
  resolveProjectRoot,
  saveConfig,
} from './store.js';
import {
  assert,
  ensureDir,
  getBooleanFlag,
  getFlagValue,
  getFlagValues,
  humanDate,
  parseCommaSeparatedList,
  parseInteger,
  parseKeyValuePairs,
  parseKeyValueText,
  parseArgs,
  parseOptionalInteger,
  readStdin,
  sleep,
  stdinHasData,
  timestamp,
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

    if (command === 'ci') {
      await handleCiCommand(rootOverride, tail);
      return;
    }

    if (command === 'backup') {
      await handleBackupCommand(rootOverride, tail);
      return;
    }

    if (command === 'migrate') {
      await handleMigrateCommand(rootOverride, tail);
      return;
    }

    const projectRoot = resolveOrInitProjectRoot(process.cwd(), rootOverride);

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
      case 'run':
        await handleRunCommand(projectRoot, tail);
        return;
      case 'dashboard':
        await handleDashboardCommand(projectRoot, tail);
        return;
      case 'status':
        await handleStatusCommand(projectRoot, tail);
        return;
      case 'env':
        await handleEnvCommand(projectRoot, tail);
        return;
      case 'admin':
        await handleAdminCommand(projectRoot, tail);
        return;
      case 'discord':
        await handleDiscordCommand(projectRoot, tail);
        return;
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
    console.log(`Next step: hkclaw-lite show agent ${definition.name}`);
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
        projectRoot,
        mode: 'add',
        initial: preset,
      }),
    );
    assert(!config.channels[definition.name], `Channel "${definition.name}" already exists.`);
    config.channels[definition.name] = buildChannelDefinition(
      projectRoot,
      config,
      definition.name,
      definition,
    );
    saveConfig(projectRoot, config);
    console.log(`Added channel "${definition.name}".`);
    console.log(`Next step: hkclaw-lite show channel ${definition.name}`);
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
        if (channel.reviewer === name) {
          channel.reviewer = definition.name;
        }
        if (channel.arbiter === name) {
          channel.arbiter = definition.name;
        }
      }
      for (const agent of Object.values(config.agents)) {
        if (agent.fallbackAgent === name) {
          agent.fallbackAgent = definition.name;
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
        projectRoot,
        mode: 'edit',
        initial: existing,
      }),
    );
    if (definition.name !== name) {
      assert(!config.channels[definition.name], `Channel "${definition.name}" already exists.`);
      delete config.channels[name];
    }
    config.channels[definition.name] = buildChannelDefinition(
      projectRoot,
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
      [
        blockingDashboards.length > 0
          ? `dashboards: ${blockingDashboards.join(', ')}`
          : null,
        blockingChannels.length > 0 ? `channels: ${blockingChannels.join(', ')}` : null,
        blockingAgents.length > 0 ? `fallback agents: ${blockingAgents.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(' | ')
        ? `Agent "${name}" is referenced by ${[
            blockingDashboards.length > 0
              ? `dashboards: ${blockingDashboards.join(', ')}`
              : null,
            blockingChannels.length > 0 ? `channels: ${blockingChannels.join(', ')}` : null,
            blockingAgents.length > 0 ? `fallback agents: ${blockingAgents.join(', ')}` : null,
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

async function handleRunCommand(projectRoot, argv) {
  const { flags, positionals } = parseArgs(argv);
  const config = loadConfig(projectRoot);
  const target = resolveRunTarget(projectRoot, config, positionals, flags);
  const prompt = await resolvePromptText(target.promptPositionals, flags);

  const result = await executeChannelTurn({
    projectRoot,
    config,
    channel:
      target.channel || {
        name: target.agent.name,
        mode: 'single',
        agent: target.agent.name,
      },
    prompt,
    workdir: target.workdir,
  });

  console.log(result.content);
}

function resolveRunTarget(projectRoot, config, positionals, flags) {
  const channelFlag = getFlagValue(flags, 'channel');
  const workdirFlag = getFlagValue(flags, 'workdir');
  const viaChannelCommand = positionals[0] === 'channel';
  const requestedChannelName = channelFlag || (viaChannelCommand ? positionals[1] : null);

  if (requestedChannelName) {
    assert(!workdirFlag, 'Do not combine --workdir with --channel.');
    const channel = getChannel(config, requestedChannelName);
    return {
      agent: getAgent(config, channel.agent),
      channel,
      workdir: resolveExistingWorkdir(projectRoot, channel.workspace || channel.workdir),
      promptPositionals: viaChannelCommand ? positionals.slice(2) : positionals,
    };
  }

  const agentName = positionals[0];
  if (!agentName) {
    const channels = listChannels(config);
    assert(
      channels.length === 1,
      'Usage: hkclaw-lite run <agent> [--workdir DIR] [--message TEXT] or hkclaw-lite run --channel <name> [--message TEXT].',
    );
    const [channel] = channels;
    return {
      agent: getAgent(config, channel.agent),
      channel,
      workdir: resolveExistingWorkdir(projectRoot, channel.workspace || channel.workdir),
      promptPositionals: positionals,
    };
  }

  const agent = getAgent(config, agentName);
  const mappedChannels = listChannels(config).filter((channel) =>
    [channel.agent, channel.reviewer, channel.arbiter].filter(Boolean).includes(agent.name),
  );
  const channel =
    !workdirFlag && mappedChannels.length === 1 ? mappedChannels[0] : null;
  return {
    agent,
    channel,
    workdir: resolveRunWorkdir(projectRoot, config, agent, workdirFlag, mappedChannels),
    promptPositionals: positionals.slice(1),
  };
}

function resolveRunWorkdir(
  projectRoot,
  config,
  agent,
  workdirOverride,
  mappedChannels = null,
) {
  void config;
  if (workdirOverride) {
    return resolveExistingWorkdir(projectRoot, workdirOverride);
  }

  assert(
    Array.isArray(mappedChannels) && mappedChannels.length > 0,
    `Agent "${agent.name}" is not mapped to any channel. Pass --workdir or run through --channel.`,
  );
  assert(
    mappedChannels.length === 1,
    `Agent "${agent.name}" is mapped to multiple channels (${uniqueChannelNames(mappedChannels).join(', ')}). Pass --channel or --workdir.`,
  );

  return resolveExistingWorkdir(
    projectRoot,
    mappedChannels[0].workspace || mappedChannels[0].workdir,
  );
}

function resolveExistingWorkdir(projectRoot, workdir) {
  assert(typeof workdir === 'string' && workdir.trim().length > 0, 'workdir is required.');
  const resolved = resolveProjectPath(projectRoot, workdir);
  assert(fs.existsSync(resolved), `Workdir does not exist: ${resolved}`);
  assert(fs.statSync(resolved).isDirectory(), `Workdir must be a directory: ${resolved}`);
  return resolved;
}

async function resolvePromptText(positionals, flags) {
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
  throw new Error('Prompt is required. Pass text, --message, or pipe stdin.');
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

async function handleEnvCommand(projectRoot, argv) {
  const [subcommand, ...tail] = argv;
  const config = loadConfig(projectRoot);

  if (!subcommand || subcommand === 'list') {
    console.log(renderSharedEnv(config.sharedEnv));
    return;
  }

  if (subcommand === 'set') {
    const { positionals } = parseArgs(tail);
    assert(positionals.length > 0, 'Usage: hkclaw-lite env set KEY=VALUE [KEY=VALUE ...]');
    const updates = parseKeyValuePairs(positionals, 'shared env');
    config.sharedEnv = {
      ...config.sharedEnv,
      ...updates,
    };
    saveConfig(projectRoot, config);
    console.log(`Updated shared env: ${Object.keys(updates).join(', ')}`);
    return;
  }

  if (subcommand === 'unset') {
    const { positionals } = parseArgs(tail);
    assert(positionals.length > 0, 'Usage: hkclaw-lite env unset KEY [KEY ...]');
    for (const key of positionals) {
      assert(key.trim().length > 0, 'Env key cannot be empty.');
      delete config.sharedEnv[key];
    }
    saveConfig(projectRoot, config);
    console.log(`Removed shared env: ${positionals.join(', ')}`);
    return;
  }

  throw new Error('Usage: hkclaw-lite env <list|set|unset> ...');
}

async function handleAdminCommand(projectRoot, argv) {
  const { flags } = parseArgs(argv);
  const host = getFlagValue(flags, 'host', '127.0.0.1');
  const port = getFlagValue(flags, 'port', String(DEFAULT_ADMIN_PORT));
  await serveAdmin(projectRoot, {
    host,
    port,
  });
}

async function handleDiscordCommand(projectRoot, argv) {
  const [subcommand = 'serve', ...tail] = argv;
  if (subcommand !== 'serve') {
    throw new Error(`Unknown discord subcommand "${subcommand}".`);
  }

  const { flags } = parseArgs(tail);
  const { serveDiscord } = await import('./discord-service.js');
  await serveDiscord(projectRoot, {
    envFile: getFlagValue(flags, 'env-file'),
    agentName: getFlagValue(flags, 'agent'),
  });
}

async function handleBackupCommand(rootOverride, argv) {
  const [subcommand, ...tail] = argv;
  const { positionals, flags } = parseArgs(tail);

  if (subcommand === 'export') {
    const outputPath = positionals[0];
    assert(outputPath, 'Usage: hkclaw-lite backup export <file> [--no-watchers] [--no-logs]');
    const projectRoot = resolveProjectRoot(process.cwd(), rootOverride);
    const backup = createProjectBackup(projectRoot, {
      includeWatchers: !getBooleanFlag(flags, 'no-watchers'),
      includeLogs: !getBooleanFlag(flags, 'no-logs'),
    });
    writeProjectBackup(outputPath, backup);
    console.log(
      `Exported backup to ${path.resolve(outputPath)} (agents=${Object.keys(backup.config.agents || {}).length}, channels=${Object.keys(backup.config.channels || {}).length}, dashboards=${Object.keys(backup.config.dashboards || {}).length}, watchers=${backup.watchers.length})`,
    );
    if (backup.externalRefs.length > 0) {
      console.log(
        `External paths not bundled: ${backup.externalRefs.map((entry) => entry.field).join(', ')}`,
      );
    }
    return;
  }

  if (subcommand === 'import') {
    const inputPath = positionals[0];
    assert(inputPath, 'Usage: hkclaw-lite backup import <file> [--force]');
    const projectRoot = rootOverride ? path.resolve(rootOverride) : process.cwd();
    const backup = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
    const summary = restoreProjectBackup(projectRoot, backup, {
      force: getBooleanFlag(flags, 'force'),
    });
    console.log(
      `Imported backup into ${projectRoot} (agents=${summary.agents}, channels=${summary.channels}, dashboards=${summary.dashboards}, watchers=${summary.watchers})`,
    );
    if (summary.externalRefs > 0) {
      console.log(`Reused external paths: ${summary.externalRefs}`);
    }
    return;
  }

  throw new Error(
    'Usage: hkclaw-lite backup <export|import> ...',
  );
}

async function handleCiCommand(rootOverride, argv) {
  const [subcommand, secondArg, ...tail] = argv;

  if (subcommand === 'list') {
    const projectRoot = resolveCiStateRoot(rootOverride);
    console.log(renderCiWatcherList(listCiWatchers(projectRoot)));
    return;
  }

  if (subcommand === 'show') {
    const projectRoot = resolveCiStateRoot(rootOverride);
    assert(secondArg, 'Usage: hkclaw-lite ci show <watcher-id>');
    console.log(renderCiWatcher(loadCiWatcher(projectRoot, secondArg)));
    return;
  }

  if (subcommand === 'stop') {
    const projectRoot = resolveCiStateRoot(rootOverride);
    assert(secondArg, 'Usage: hkclaw-lite ci stop <watcher-id>');
    stopCiWatcher(projectRoot, secondArg);
    console.log(`Stopped CI watcher "${secondArg}".`);
    return;
  }

  if (subcommand === 'worker') {
    const projectRoot = resolveCiStateRoot(rootOverride);
    assert(secondArg, 'Usage: hkclaw-lite ci worker <watcher-id>');
    await runCiWatcherWorker(projectRoot, secondArg);
    return;
  }

  const projectRoot = resolveCiProjectRoot(rootOverride);
  const sharedEnv = loadSharedEnvIfConfigured(projectRoot);
  const provider = secondArg;
  assert(
    ['check', 'watch'].includes(subcommand),
    'Usage: hkclaw-lite ci <check|watch> <github|gitlab> ...',
  );
  assert(
    ['github', 'gitlab'].includes(provider),
    'Usage: hkclaw-lite ci <check|watch> <github|gitlab> ...',
  );

  const { flags } = parseArgs(tail);
  assert(
    !getFlagValue(flags, 'agent') &&
      !getFlagValue(flags, 'channel') &&
      !getFlagValue(flags, 'session'),
    'CI completion handoff options (--agent, --channel, --session) were removed.',
  );
  const ci = buildCiRequest(provider, flags, {
    assert,
    getFlagValue,
    parseInteger,
    parseOptionalInteger,
  });

  const check =
    provider === 'github'
      ? () => checkGitHubActionsRun(ci.request)
      : () => checkGitLabCiStatus(ci.request);

  if (subcommand === 'check') {
    console.log(formatCiResult(await withEnvOverlay(sharedEnv, () => check())));
    return;
  }

  const intervalMs =
    parseOptionalInteger(getFlagValue(flags, 'interval-ms'), 'interval-ms') ??
    DEFAULT_CI_WATCH_INTERVAL_MS;
  const timeoutMs =
    parseOptionalInteger(getFlagValue(flags, 'timeout-ms'), 'timeout-ms') ??
    DEFAULT_CI_WATCH_TIMEOUT_MS;
  assert(intervalMs > 0, 'interval-ms must be a positive integer.');
  assert(timeoutMs > 0, 'timeout-ms must be a positive integer.');

  if (getBooleanFlag(flags, 'background')) {
    await startBackgroundCiWatch({
      projectRoot,
      provider,
      ci,
      intervalMs,
      timeoutMs,
      flags,
      sharedEnv,
    });
    return;
  }

  let lastSummary = '';
  const result = await withEnvOverlay(sharedEnv, () =>
    watchCi({
      label: ci.label,
      intervalMs,
      timeoutMs,
      check,
      onProgress: (currentResult, attempt) => {
        if (currentResult.terminal || currentResult.resultSummary !== lastSummary) {
          console.log(`[attempt ${attempt}] ${currentResult.resultSummary}`);
          lastSummary = currentResult.resultSummary;
        }
      },
    }),
  );

  if (!result.terminal || !result.completionMessage) {
    return;
  }

  if (result.completionMessage !== result.resultSummary) {
    console.log(result.completionMessage);
  }
}

async function handleMigrateCommand(rootOverride, argv) {
  const { flags } = parseArgs(argv);
  const sourceRoot = getFlagValue(flags, 'from');
  assert(
    sourceRoot,
    'Usage: hkclaw-lite migrate --from <project-root> [--force] [--no-watchers] [--no-logs]',
  );
  const resolvedSourceRoot = resolveProjectRoot(process.cwd(), sourceRoot);
  const destinationRoot = rootOverride ? path.resolve(rootOverride) : process.cwd();
  const backup = createProjectBackup(resolvedSourceRoot, {
    includeWatchers: !getBooleanFlag(flags, 'no-watchers'),
    includeLogs: !getBooleanFlag(flags, 'no-logs'),
  });
  const summary = restoreProjectBackup(destinationRoot, backup, {
    force: getBooleanFlag(flags, 'force'),
  });
  console.log(
    `Migrated hkclaw-lite state from ${resolvedSourceRoot} to ${destinationRoot} (agents=${summary.agents}, channels=${summary.channels}, dashboards=${summary.dashboards}, watchers=${summary.watchers})`,
  );
  if (summary.externalRefs > 0) {
    console.log(`Reused external paths: ${summary.externalRefs}`);
  }
}

function resolveCiProjectRoot(rootOverride) {
  if (rootOverride) {
    return path.resolve(rootOverride);
  }
  return findProjectRoot(process.cwd()) || process.cwd();
}

function resolveCiStateRoot(rootOverride) {
  const candidate = rootOverride
    ? path.resolve(rootOverride)
    : findCiStateRoot(process.cwd());
  assert(
    candidate && hasCiStateRoot(candidate),
    'No CI watcher state found. Run "hkclaw-lite ci watch ... --background" first or pass --root.',
  );
  return candidate;
}

function findCiStateRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (hasCiStateRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function hasCiStateRoot(projectRoot) {
  const layout = getProjectLayout(projectRoot);
  return fs.existsSync(layout.configPath) || fs.existsSync(layout.watchersRoot);
}

function loadSharedEnvIfConfigured(projectRoot) {
  const configPath = getProjectLayout(projectRoot).configPath;
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return loadConfig(projectRoot).sharedEnv || {};
}

async function withEnvOverlay(sharedEnv, callback) {
  const entries = Object.entries(sharedEnv || {});
  const originalValues = new Map();

  for (const [key, value] of entries) {
    originalValues.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key] of entries) {
      const originalValue = originalValues.get(key);
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  }
}

async function startBackgroundCiWatch({
  projectRoot,
  provider,
  ci,
  intervalMs,
  timeoutMs,
  flags,
  sharedEnv,
}) {
  void flags;
  const watcherId = createCiWatcherId();
  const logPath = getCiWatcherLogPath(projectRoot, watcherId);
  const watcherRequest = omitTokenFromCiRequest(ci.request);
  let watcher = saveCiWatcher(projectRoot, {
    id: watcherId,
    provider,
    label: ci.label,
    request: watcherRequest,
    intervalMs,
    timeoutMs,
    status: 'starting',
    createdAt: timestamp(),
    updatedAt: timestamp(),
    logPath,
  });

  ensureDir(path.dirname(logPath));
  const logFd = fs.openSync(logPath, 'a');

  try {
    const entryPath = fileURLToPath(new URL('../bin/hkclaw-lite.js', import.meta.url));
    const child = spawn(
      process.execPath,
      [entryPath, '--root', projectRoot, 'ci', 'worker', watcherId],
      {
        cwd: projectRoot,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: buildCiWorkerEnv(provider, sharedEnv, ci.request.token),
      },
    );
    child.unref();
    watcher = saveCiWatcher(projectRoot, {
      ...watcher,
      pid: child.pid,
      updatedAt: timestamp(),
    });
    console.log(`Started CI watcher "${watcherId}".`);
    console.log(`status=${watcher.status}`);
    console.log(`pid=${child.pid}`);
    console.log(`log=${watcher.logPath}`);
  } finally {
    fs.closeSync(logFd);
  }
}

function omitTokenFromCiRequest(request) {
  const { token, ...rest } = request;
  void token;
  return rest;
}

function buildCiWorkerEnv(provider, sharedEnv, explicitToken) {
  const env = {
    ...process.env,
    ...sharedEnv,
  };

  if (!explicitToken) {
    return env;
  }

  if (provider === 'github') {
    env.GITHUB_TOKEN = explicitToken;
    return env;
  }

  env.GITLAB_TOKEN = explicitToken;
  return env;
}

async function runCiWatcherWorker(projectRoot, watcherId) {
  let watcher = loadCiWatcher(projectRoot, watcherId);
  if (['completed', 'failed', 'stopped'].includes(watcher.status)) {
    return;
  }

  const persist = (updates) => {
    watcher = saveCiWatcher(projectRoot, {
      ...watcher,
      ...updates,
      updatedAt: timestamp(),
    });
    return watcher;
  };

  const stopWorker = () => {
    persist({
      status: 'stopped',
      stoppedAt: watcher.stoppedAt || timestamp(),
      pid: process.pid,
    });
    process.exit(0);
  };

  process.on('SIGTERM', stopWorker);
  process.on('SIGINT', stopWorker);

  persist({
    status: 'running',
    startedAt: watcher.startedAt || timestamp(),
    pid: process.pid,
    error: null,
  });

  const check =
    watcher.provider === 'github'
      ? () => checkGitHubActionsRun(watcher.request)
      : () => checkGitLabCiStatus(watcher.request);

  try {
    const result = await watchCi({
      label: watcher.label,
      intervalMs: watcher.intervalMs,
      timeoutMs: watcher.timeoutMs,
      check,
      onProgress: (currentResult, attempt) => {
        console.log(`[attempt ${attempt}] ${currentResult.resultSummary}`);
        persist({
          status: 'running',
          attempts: attempt,
          lastSummary: currentResult.resultSummary,
          pid: process.pid,
        });
      },
    });

    persist({
      status: 'completed',
      completedAt: timestamp(),
      pid: process.pid,
      attempts: Math.max(watcher.attempts, 1),
      lastSummary: result.resultSummary,
      resultSummary: result.resultSummary,
      completionMessage: result.completionMessage || null,
      error: null,
    });
  } catch (error) {
    persist({
      status: 'failed',
      pid: process.pid,
      error: toErrorMessage(error),
    });
    throw error;
  }
}

function stopCiWatcher(projectRoot, watcherId) {
  const watcher = loadCiWatcher(projectRoot, watcherId);
  if (['completed', 'failed', 'stopped'].includes(watcher.status)) {
    return;
  }
  if (watcher.pid && isProcessAlive(watcher.pid)) {
    try {
      process.kill(watcher.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
  }

  saveCiWatcher(projectRoot, {
    ...watcher,
    status: 'stopped',
    stoppedAt: watcher.stoppedAt || timestamp(),
    updatedAt: timestamp(),
  });
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function renderCiWatcherList(watchers) {
  if (watchers.length === 0) {
    return 'No CI watchers found.';
  }

  const lines = ['CI Watchers'];
  for (const watcher of watchers) {
    lines.push(
      `  ${watcher.id}\t${watcher.provider}\tstatus=${watcher.status}\tupdated=${humanDate(watcher.updatedAt)}`,
    );
  }
  return lines.join('\n');
}

function renderCiWatcher(watcher) {
  return [
    `watcher=${watcher.id}`,
    `provider=${watcher.provider}`,
    `status=${watcher.status}`,
    watcher.pid ? `pid=${watcher.pid}` : null,
    `createdAt=${watcher.createdAt}`,
    `updatedAt=${watcher.updatedAt}`,
    watcher.startedAt ? `startedAt=${watcher.startedAt}` : null,
    watcher.completedAt ? `completedAt=${watcher.completedAt}` : null,
    watcher.stoppedAt ? `stoppedAt=${watcher.stoppedAt}` : null,
    `intervalMs=${watcher.intervalMs}`,
    `timeoutMs=${watcher.timeoutMs}`,
    `attempts=${watcher.attempts}`,
    watcher.lastSummary ? `lastSummary=${watcher.lastSummary}` : null,
    watcher.resultSummary ? `resultSummary=${watcher.resultSummary}` : null,
    watcher.error ? `error=${watcher.error}` : null,
    watcher.logPath ? `log=${watcher.logPath}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderSharedEnv(sharedEnv) {
  const entries = Object.entries(sharedEnv || {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) {
    return 'No shared env configured.';
  }
  return ['Shared Env', ...entries.map(([key, value]) => `  ${key}=${value}`)].join('\n');
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

  const model = await prompter.askText('Model (optional)', {
    defaultValue: initial.model,
    allowEmpty: true,
  });
  const effort = await prompter.askText('Effort (optional)', {
    defaultValue: initial.effort,
    allowEmpty: true,
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
  const skillsText = await prompter.askText(
    'Skill paths as SKILL.md file or directory, comma separated (optional)',
    {
      defaultValue: formatListText(initial.skills),
      allowEmpty: true,
      validate: (value) => validateSkillPathText(projectRoot, value),
    },
  );
  const contextFilesText = await prompter.askText(
    'Context file paths, comma separated (optional)',
    {
      defaultValue: formatListText(initial.contextFiles),
      allowEmpty: true,
      validate: (value) => validateContextFileText(projectRoot, value),
    },
  );
  const fallbackAgent = await prompter.askText('Fallback agent name (optional)', {
    defaultValue: initial.fallbackAgent,
    allowEmpty: true,
    validate: (value) => {
      if (!value) {
        return true;
      }
      if (value === name) {
        return 'Fallback agent must be different from the agent.';
      }
      return config.agents[value] ? true : `Unknown agent "${value}".`;
    },
  });
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
    model,
    effort,
    timeoutMs,
    systemPrompt,
    systemPromptFile,
    skills: skillsText ? parseCommaSeparatedList(skillsText) : [],
    contextFiles: contextFilesText ? parseCommaSeparatedList(contextFilesText) : [],
    fallbackAgent,
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
        defaultValue: initial.permissionMode || (initial.dangerous ? 'bypassPermissions' : undefined),
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
  const showDetails = await prompter.askConfirm('Show runtime details?', {
    defaultValue: initial.showDetails ?? true,
  });

  return {
    name,
    monitors,
    refreshMs,
    showDetails,
  };
}

async function promptForChannelDefinition(prompter, config, options) {
  const projectRoot = options.projectRoot;
  const initial = options.initial || {};
  const existingChannelNames = new Set(Object.keys(config.channels));
  const agents = listAgents(config);
  const agentChoices = agents.map((currentAgent) => ({
    value: currentAgent.name,
    label: currentAgent.name,
    description: currentAgent.model
      ? `${currentAgent.agent} @ ${currentAgent.model}`
      : currentAgent.agent,
  }));
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
  const workspace = await prompter.askText('Channel workspace directory', {
    defaultValue: initial.workspace ?? initial.workdir ?? DEFAULT_CHANNEL_WORKSPACE,
    validate: (value) => {
      const resolved = resolveProjectPath(projectRoot, value);
      if (!fs.existsSync(resolved)) {
        return `Directory does not exist: ${resolved}`;
      }
      return fs.statSync(resolved).isDirectory()
        ? true
        : `Path must be a directory: ${resolved}`;
    },
  });
  const channelMode = await prompter.askChoice(
    'What kind of channel do you want to create?',
    CHANNEL_MODE_CHOICES,
    {
      defaultValue:
        initial.mode === 'tribunal' || initial.reviewer || initial.arbiter
          ? 'tribunal'
          : 'single',
    },
  );
  const agent = await prompter.askChoice(
    channelMode === 'tribunal'
      ? 'Which owner agent should handle user requests?'
      : 'Which agent should this channel map to?',
    agentChoices,
    {
      defaultValue: initial.agent,
    },
  );

  let reviewer = '';
  let arbiter = '';
  let reviewRounds = '';
  if (channelMode === 'tribunal') {
    assert(
      agents.length >= 3,
      'Add at least three agents before creating a tribunal channel.',
    );
    const reviewerChoices = agentChoices.filter((choice) => choice.value !== agent);
    reviewer = await prompter.askChoice(
      'Which reviewer agent should critique owner output?',
      reviewerChoices,
      {
        defaultValue:
          initial.reviewer && initial.reviewer !== agent
            ? initial.reviewer
            : reviewerChoices[0]?.value,
      },
    );
    const arbiterChoices = reviewerChoices.filter(
      (choice) => choice.value !== reviewer,
    );
    arbiter = await prompter.askChoice(
      'Which arbiter agent should break deadlocks?',
      arbiterChoices,
      {
        defaultValue:
          initial.arbiter &&
          initial.arbiter !== agent &&
          initial.arbiter !== reviewer
            ? initial.arbiter
            : arbiterChoices[0]?.value,
      },
    );
    reviewRounds = await prompter.askText('Max review rounds', {
      defaultValue: initial.reviewRounds ?? '2',
      validate: (value) => {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isInteger(parsed) && parsed > 0
          ? true
          : 'Review rounds must be a positive integer.';
      },
    });
  }
  const description = await prompter.askText('Channel description (optional)', {
    defaultValue: initial.description,
    allowEmpty: true,
  });

  return {
    name,
    mode: channelMode,
    discordChannelId,
    guildId,
    workspace,
    agent,
    reviewer,
    arbiter,
    reviewRounds,
    description,
  };
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
  const channelsByAgent = buildChannelsByAgent(config);

  for (const agent of agents) {
    const runtime = inspectAgentRuntime(projectRoot, agent);
    const mappedChannels = channelsByAgent[agent.name] || [];
    const channelNames = uniqueChannelNames(mappedChannels);
    const workspaces = uniqueChannelWorkspaces(mappedChannels);

    lines.push('');
    lines.push(agent.name);
    lines.push(`  type=${agent.agent}`);
    lines.push(`  ready=${runtime.ready ? 'yes' : 'no'}`);
    lines.push(`  detail=${runtime.detail}`);
    if (agent.fallbackAgent) {
      lines.push(`  fallback=${agent.fallbackAgent}`);
    }
    lines.push(`  channels=${channelNames.length}`);
    if (channelNames.length > 0) {
      lines.push(`  mapped=${channelNames.join(', ')}`);
      lines.push(`  workspaces=${workspaces.join(', ')}`);
    }
  }

  return lines.join('\n');
}

function renderDashboard(projectRoot, config, dashboard) {
  const agentNames = resolveDashboardAgentNames(config, dashboard);
  const agents = agentNames.map((agentName) => getAgent(config, agentName));
  const channelsByAgent = buildChannelsByAgent(config);
  const lines = [
    `dashboard=${dashboard.name}`,
    `monitors=${formatDashboardMonitorText(dashboard.monitors)}`,
    `refreshMs=${dashboard.refreshMs}`,
    `agents=${agents.length}`,
  ];

  for (const agent of agents) {
    const runtime = inspectAgentRuntime(projectRoot, agent);
    const mappedChannels = channelsByAgent[agent.name] || [];
    const channelNames = uniqueChannelNames(mappedChannels);
    const workspaces = uniqueChannelWorkspaces(mappedChannels);
    lines.push('');
    lines.push(agent.name);
    lines.push(`  type=${agent.agent}`);
    lines.push(`  ready=${runtime.ready ? 'yes' : 'no'}`);

    if (dashboard.showDetails) {
      lines.push(`  detail=${runtime.detail}`);
      if (agent.model) {
        lines.push(`  model=${agent.model}`);
      }
      if (agent.fallbackAgent) {
        lines.push(`  fallback=${agent.fallbackAgent}`);
      }
      lines.push(`  channels=${channelNames.length}`);
      if (channelNames.length > 0) {
        lines.push(`  mapped=${channelNames.join(', ')}`);
        lines.push(`  workspaces=${workspaces.join(', ')}`);
      }
    }

  }

  return lines.join('\n');
}

function renderChannelStatus(config, channel) {
  const agent = getAgent(config, channel.agent);
  return [
    `channel=${channel.name}`,
    `mode=${channel.mode || (channel.reviewer || channel.arbiter ? 'tribunal' : 'single')}`,
    `discordChannelId=${channel.discordChannelId}`,
    channel.guildId ? `guildId=${channel.guildId}` : null,
    `workspace=${channel.workspace || channel.workdir}`,
    `agent=${channel.agent}`,
    channel.reviewer ? `reviewer=${channel.reviewer}` : null,
    channel.arbiter ? `arbiter=${channel.arbiter}` : null,
    channel.reviewRounds ? `reviewRounds=${channel.reviewRounds}` : null,
    channel.description ? `description=${channel.description}` : null,
    `agentType=${agent.agent}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildChannelsByAgent(config) {
  const output = {};
  for (const channel of listChannels(config)) {
    for (const agentName of [channel.agent, channel.reviewer, channel.arbiter].filter(Boolean)) {
      output[agentName] = output[agentName] || [];
      output[agentName].push(channel);
    }
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
    console.log(`  ${agent.name}\t${agent.agent}`);
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
      `  ${channel.name}\t${channel.discordChannelId}\tmode=${channel.mode || (channel.reviewer || channel.arbiter ? 'tribunal' : 'single')}\tagent=${channel.agent}\tworkspace=${channel.workspace || channel.workdir}`,
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

function formatListText(values) {
  return parseCommaSeparatedList(values).join(', ');
}

function validateSkillPathText(projectRoot, value) {
  for (const entry of parseCommaSeparatedList(value)) {
    const resolved = resolveProjectPath(projectRoot, entry);
    if (!fs.existsSync(resolved)) {
      return `Path does not exist: ${resolved}`;
    }
    if (fs.statSync(resolved).isDirectory()) {
      const skillFile = path.join(resolved, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        return `Skill directory does not contain SKILL.md: ${skillFile}`;
      }
    }
  }
  return true;
}

function validateContextFileText(projectRoot, value) {
  for (const entry of parseCommaSeparatedList(value)) {
    const resolved = resolveProjectPath(projectRoot, entry);
    if (!fs.existsSync(resolved)) {
      return `File does not exist: ${resolved}`;
    }
    if (fs.statSync(resolved).isDirectory()) {
      return `Context path must be a file: ${resolved}`;
    }
  }
  return true;
}

function buildAgentPreset(name, flags) {
  const skillFiles = [
    ...getFlagValues(flags, 'skill'),
    ...getFlagValues(flags, 'skill-file'),
  ];
  const contextFiles = getFlagValues(flags, 'context-file');
  return {
    name,
    agent: getFlagValue(flags, 'agent'),
    fallbackAgent: getFlagValue(flags, 'fallback-agent'),
    model: getFlagValue(flags, 'model'),
    effort: getFlagValue(flags, 'effort'),
    timeoutMs: getFlagValue(flags, 'timeout-ms'),
    systemPrompt: getFlagValue(flags, 'system'),
    systemPromptFile: getFlagValue(flags, 'system-file'),
    skills: skillFiles.length > 0 ? skillFiles : undefined,
    contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
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
    showDetails: getFlagValue(flags, 'show-details'),
  };
}

function buildChannelPreset(name, flags) {
  return {
    name,
    mode: getFlagValue(flags, 'mode') || getFlagValue(flags, 'channel-mode'),
    discordChannelId: getFlagValue(flags, 'discord-channel-id'),
    guildId: getFlagValue(flags, 'guild-id'),
    workspace: getFlagValue(flags, 'workspace') || getFlagValue(flags, 'workdir'),
    agent: getFlagValue(flags, 'agent'),
    reviewer: getFlagValue(flags, 'reviewer'),
    arbiter: getFlagValue(flags, 'arbiter'),
    reviewRounds: getFlagValue(flags, 'review-rounds'),
    description: getFlagValue(flags, 'description'),
  };
}

function printHelp() {
  console.log(`hkclaw-lite

Discord-only AI agent runtime managed primarily from the local web admin.
Use the web admin for most setup and day-to-day control; keep the CLI for automation and operational tasks.
Agents intentionally run with the full permissions of the host account that launched them.
Most commands auto-create .hkclaw-lite in the current directory when missing.
Installing the package never starts a process by itself.

Execution model:
  hkclaw-lite / --help      Show help only
  hkclaw-lite admin         Start the web admin server
  hkclaw-lite run ...       Execute one one-shot turn
  hkclaw-lite discord serve Start the long-running Discord worker
  Containers and Kubernetes only run whichever command you pass explicitly.

Usage:
  hkclaw-lite init [--root DIR] [--force]
  hkclaw-lite admin [--root DIR] [--host 127.0.0.1] [--port ${DEFAULT_ADMIN_PORT}]
  hkclaw-lite discord serve [--root DIR] [--env-file .env]
  hkclaw-lite backup export <file> [--root DIR] [--no-watchers] [--no-logs]
  hkclaw-lite backup import <file> [--root DIR] [--force]
  hkclaw-lite migrate --from <project-root> [--root DIR] [--force]
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
  hkclaw-lite run <agent> [--workdir DIR] [--message TEXT]
  hkclaw-lite run --channel <name> [--message TEXT]
  hkclaw-lite dashboard [name] [--once]
  hkclaw-lite env list
  hkclaw-lite env set GITHUB_TOKEN=... GITLAB_TOKEN=...
  hkclaw-lite env unset GITLAB_TOKEN
  hkclaw-lite ci check github --repo owner/repo --run-id 123
  hkclaw-lite ci check gitlab --project group/project --pipeline-id 456
  hkclaw-lite ci watch github --repo owner/repo --run-id 123
  hkclaw-lite ci watch gitlab --project group/project --job-id 789
  hkclaw-lite ci watch gitlab --project group/project --pipeline-id 456 --background
  hkclaw-lite ci list
  hkclaw-lite ci show <watcher-id>
  hkclaw-lite ci stop <watcher-id>
  hkclaw-lite status
  hkclaw-lite status agent <name>
  hkclaw-lite status channel <name>
  hkclaw-lite status dashboard <name>

Examples:
  hkclaw-lite admin
  hkclaw-lite admin --host 0.0.0.0 --port ${DEFAULT_ADMIN_PORT}
  hkclaw-lite discord serve --env-file .env
  hkclaw-lite backup export ./backups/project.json
  hkclaw-lite backup import ./backups/project.json --root ./restored
  hkclaw-lite migrate --from ../old-project --root ./new-project
  hkclaw-lite add agent
  hkclaw-lite add channel
  hkclaw-lite add dashboard
  hkclaw-lite run --channel discord-main --message "summarize the repo"
  hkclaw-lite run dev-codex --workdir ./workspaces/dev --message "review the latest diff"
  hkclaw-lite show agent dev-codex
  hkclaw-lite status channel discord-main
  hkclaw-lite env set GITHUB_TOKEN=ghp_xxx GITLAB_TOKEN=glpat-xxx
  hkclaw-lite ci watch gitlab --project group/project --pipeline-id 456
  hkclaw-lite ci watch gitlab --project group/project --pipeline-id 456 --background
  hkclaw-lite dashboard ops
`);
}

function uniqueChannelNames(channels) {
  return [...new Set(channels.map((channel) => channel.name))];
}

function uniqueChannelWorkspaces(channels) {
  return [...new Set(channels.map((channel) => channel.workspace || channel.workdir).filter(Boolean))];
}
