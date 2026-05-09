import fs from 'node:fs';
import os from 'node:os';
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
  AGENT_ACCESS_MODE_AGENT_TYPES,
  AGENT_ACCESS_MODE_CHOICES,
  AGENT_TYPE_CHOICES,
  CHANNEL_TARGET_TYPE_CHOICES,
  CLAUDE_PERMISSION_MODE_CHOICES,
  CHANNEL_MODE_CHOICES,
  CONNECTOR_PLATFORM_CHOICES,
  DASHBOARD_ALL_AGENTS,
  DEFAULT_ADMIN_PORT,
  MESSAGING_PLATFORM_CHOICES,
} from './constants.js';
import { withPrompter } from './interactive.js';
import { getDefaultKakaoRelayUrl } from './kakao-service.js';
import { setAdminPassword } from './runtime-db.js';
import { inspectAgentRuntime } from './runners.js';
import {
  deleteSchedule,
  formatScheduleSummary,
  listSchedules,
  runDueSchedulesOnce,
  runScheduleNow,
  upsertSchedule,
} from './scheduler.js';
import {
  buildAgentDefinition,
  buildChannelDefinition,
  buildConnectorDefinition,
  buildDashboardDefinition,
  findProjectRoot,
  getAgent,
  getChannel,
  getConnector,
  getDashboard,
  getDefaultChannelWorkspace,
  getProjectLayout,
  initProject,
  listAgents,
  listChannels,
  listConnectors,
  listDashboards,
  loadConfig,
  removeAgent,
  removeChannel,
  removeConnector,
  removeDashboard,
  resolveOrInitProjectRoot,
  resolveProjectPath,
  resolveProjectRoot,
  saveConfig,
} from './store.js';
import {
  getUnitPath,
  installSystemdUnit,
  readBinPath,
  restartService,
  serviceLogs,
  serviceStatus,
  startService,
  stopService,
  uninstallSystemdUnit,
} from './service.js';
import {
  assert,
  ensureDir,
  getBooleanFlag,
  getFlagValue,
  getFlagValues,
  humanDate,
  parseCommaSeparatedList,
  parseInteger,
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

    if (command === 'admin') {
      await handleAdminCommand({
        cwd: process.cwd(),
        rootOverride,
        argv: tail,
      });
      return;
    }

    if (command === 'onboard') {
      await handleOnboardCommand({
        cwd: process.cwd(),
        rootOverride,
        argv: tail,
      });
      return;
    }

    if (command === 'start' || command === 'stop' || command === 'restart' || command === 'service') {
      await handleServiceCommand({
        cwd: process.cwd(),
        rootOverride,
        command,
        argv: tail,
      });
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
      case 'schedule':
        await handleScheduleCommand(projectRoot, tail);
        return;
      case 'dashboard':
        await handleDashboardCommand(projectRoot, tail);
        return;
      case 'status':
        await handleStatusCommand(projectRoot, tail);
        return;
      case 'env':
        throw new Error(
          'The env command was removed. Use explicit flags, stored agent fields, or your deployment environment instead.',
        );
      case 'discord':
        await handleDiscordCommand(projectRoot, tail);
        return;
      case 'telegram':
        await handleTelegramCommand(projectRoot, tail);
        return;
      case 'kakao':
        await handleKakaoCommand(projectRoot, tail);
        return;
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

  if (kind === 'connector') {
    const { positionals, flags } = parseArgs(tail);
    const preset = buildConnectorPreset(positionals[0], flags);
    const definition = await withPrompter((prompter) =>
      promptForConnectorDefinition(prompter, config, {
        mode: 'add',
        initial: preset,
      }),
    );
    config.connectors = config.connectors || {};
    assert(!config.connectors[definition.name], `Kakao session "${definition.name}" already exists.`);
    config.connectors[definition.name] = buildConnectorDefinition(definition.name, definition);
    saveConfig(projectRoot, config);
    console.log(`Added Kakao session "${definition.name}" (connector).`);
    console.log(`Next step: hkclaw-lite add channel --connector ${definition.name}`);
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

  throw new Error('Usage: hkclaw-lite add <agent|connector|channel|dashboard>');
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

  if (kind === 'connector') {
    const { positionals } = parseArgs(tail);
    const name = positionals[0];
    assert(name, 'Usage: hkclaw-lite edit connector <name>');
    const existing = getConnector(config, name);
    const definition = await withPrompter((prompter) =>
      promptForConnectorDefinition(prompter, config, {
        mode: 'edit',
        initial: existing,
      }),
    );
    if (definition.name !== name) {
      assert(!config.connectors?.[definition.name], `Kakao session "${definition.name}" already exists.`);
      for (const channel of Object.values(config.channels)) {
        if (channel.connector === name) {
          channel.connector = definition.name;
        }
      }
      delete config.connectors[name];
    }
    config.connectors = config.connectors || {};
    config.connectors[definition.name] = buildConnectorDefinition(
      definition.name,
      definition,
      config.connectors[definition.name] || existing,
    );
    saveConfig(projectRoot, config);
    console.log(`Updated Kakao session "${definition.name}" (connector).`);
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

  throw new Error('Usage: hkclaw-lite edit <agent|connector|channel|dashboard> <name>');
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

  if (kind === 'connector') {
    assert(name, 'Usage: hkclaw-lite remove connector <name> [--yes]');
    const connector = getConnector(config, name);
    assert(
      !isDerivedLegacyConnector(config, name, connector),
      `Connector "${name}" is derived from legacy agent platform settings; edit the agent Kakao session settings first.`,
    );
    const blockingChannels = listChannels(config)
      .filter((channel) => channel.connector === name)
      .map((channel) => channel.name);
    assert(
      blockingChannels.length === 0,
      `Connector "${name}" is referenced by channels: ${blockingChannels.join(', ')}.`,
    );
    const confirmed = force
      ? true
      : await withPrompter((prompter) =>
          prompter.askConfirm(`Remove Kakao session "${name}"?`, {
            defaultValue: false,
          }),
        );
    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }
    removeConnector(config, name);
    saveConfig(projectRoot, config);
    console.log(`Removed Kakao session "${name}" (connector).`);
    return;
  }

  if (kind === 'channel') {
    assert(name, 'Usage: hkclaw-lite remove channel <name> [--yes]');
    getChannel(config, name);
    const blockingSchedules = (await listSchedules(projectRoot))
      .filter((schedule) => schedule.channelName === name)
      .map((schedule) => schedule.name);
    assert(
      blockingSchedules.length === 0,
      `Channel "${name}" is referenced by schedules: ${blockingSchedules.join(', ')}.`,
    );
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

  throw new Error('Usage: hkclaw-lite remove <agent|connector|channel|dashboard> <name>');
}

async function handleListCommand(projectRoot, argv) {
  const [kind] = argv;
  const config = loadConfig(projectRoot);

  if (!kind || kind === 'all') {
    printAgents(listAgents(config));
    console.log('');
    printConnectors(listConnectors(config));
    console.log('');
    printChannels(listChannels(config));
    console.log('');
    printDashboards(listDashboards(config));
    console.log('');
    printSchedules(await listSchedules(projectRoot));
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

  if (['connector', 'connectors'].includes(kind)) {
    printConnectors(listConnectors(config));
    return;
  }

  if (['channel', 'channels'].includes(kind)) {
    printChannels(listChannels(config));
    return;
  }

  if (['schedule', 'schedules'].includes(kind)) {
    printSchedules(await listSchedules(projectRoot));
    return;
  }

  throw new Error('Usage: hkclaw-lite list [agents|connectors|channels|dashboards|schedules|all]');
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

  if (kind === 'connector') {
    assert(name, 'Usage: hkclaw-lite show connector <name>');
    console.log(JSON.stringify(getConnector(config, name), null, 2));
    return;
  }

  if (kind === 'channel') {
    assert(name, 'Usage: hkclaw-lite show channel <name>');
    console.log(JSON.stringify(getChannel(config, name), null, 2));
    return;
  }

  throw new Error('Usage: hkclaw-lite show <agent|connector|channel|dashboard> <name>');
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

async function handleScheduleCommand(projectRoot, argv) {
  const [subcommand = 'list', ...tail] = argv;

  if (['list', 'ls'].includes(subcommand)) {
    printSchedules(await listSchedules(projectRoot));
    return;
  }

  if (subcommand === 'show') {
    const { positionals } = parseArgs(tail);
    const scheduleName = positionals[0];
    assert(scheduleName, 'Usage: hkclaw-lite schedule show <name>');
    const schedule = (await listSchedules(projectRoot)).find(
      (entry) => entry.name === scheduleName || entry.scheduleId === scheduleName,
    );
    assert(schedule, `Unknown schedule "${scheduleName}".`);
    console.log(JSON.stringify(schedule, null, 2));
    return;
  }

  if (['add', 'edit', 'set'].includes(subcommand)) {
    const { flags, positionals } = parseArgs(tail);
    const scheduleName = positionals[0];
    assert(
      scheduleName,
      `Usage: hkclaw-lite schedule ${subcommand} <name> --channel <channel> (--every 10m|--daily HH:mm) --message TEXT`,
    );
    const definition = buildScheduleCliDefinition(scheduleName, flags);
    const existingSchedule = (await listSchedules(projectRoot)).find(
      (entry) => entry.name === scheduleName || entry.scheduleId === scheduleName,
    );
    assert(subcommand !== 'edit' || existingSchedule, `Unknown schedule "${scheduleName}".`);
    const currentName =
      subcommand === 'add'
        ? null
        : existingSchedule
          ? existingSchedule.name
          : null;
    const schedule = await upsertSchedule(projectRoot, currentName, definition);
    console.log(`${subcommand === 'add' ? 'Added' : 'Updated'} schedule "${schedule.name}".`);
    console.log(`  ${formatScheduleSummary(schedule)} -> next=${humanDate(schedule.nextRunAt)}`);
    return;
  }

  if (['remove', 'rm', 'delete'].includes(subcommand)) {
    const { flags, positionals } = parseArgs(tail);
    const scheduleName = positionals[0];
    assert(scheduleName, 'Usage: hkclaw-lite schedule remove <name> [--yes]');
    const confirmed = getBooleanFlag(flags, 'yes')
      ? true
      : await withPrompter((prompter) =>
          prompter.askConfirm(`Remove schedule "${scheduleName}"?`, {
            defaultValue: false,
          }),
        );
    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }
    await deleteSchedule(projectRoot, scheduleName);
    console.log(`Removed schedule "${scheduleName}".`);
    return;
  }

  if (subcommand === 'run') {
    const { positionals } = parseArgs(tail);
    const scheduleName = positionals[0];
    assert(scheduleName, 'Usage: hkclaw-lite schedule run <name>');
    const result = await runScheduleNow(projectRoot, scheduleName);
    console.log(result.result?.content || `Schedule "${scheduleName}" completed.`);
    return;
  }

  if (['tick', 'worker', 'due'].includes(subcommand)) {
    const { flags } = parseArgs(tail);
    const maxSchedules = parseOptionalInteger(getFlagValue(flags, 'max'), 'max') || 5;
    const results = await runDueSchedulesOnce(projectRoot, { maxSchedules });
    printScheduleRunResults(results);
    return;
  }

  throw new Error(
    'Usage: hkclaw-lite schedule <list|show|add|edit|set|remove|run|tick> ...',
  );
}

function buildScheduleCliDefinition(name, flags) {
  const every = getFlagValue(flags, 'every') || getFlagValue(flags, 'interval');
  const intervalMs = getFlagValue(flags, 'interval-ms');
  const daily = getFlagValue(flags, 'daily') || getFlagValue(flags, 'time-of-day');
  const scheduleType = daily ? 'daily' : every || intervalMs ? 'interval' : undefined;
  return {
    name,
    enabled: !getBooleanFlag(flags, 'disabled'),
    channelName: getFlagValue(flags, 'channel') || getFlagValue(flags, 'channel-name'),
    prompt: getFlagValue(flags, 'message') || getFlagValue(flags, 'prompt'),
    skillName: getFlagValue(flags, 'skill') || getFlagValue(flags, 'skill-name'),
    scheduleType,
    every,
    intervalMs,
    timeOfDay: daily,
    timezone: getFlagValue(flags, 'timezone') || getFlagValue(flags, 'tz'),
    nextRunAt: getFlagValue(flags, 'next-run-at') || getFlagValue(flags, 'next'),
  };
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
      workdir: resolveExistingWorkdir(projectRoot, resolveChannelAgentWorkspace(channel, channel.agent)),
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
      workdir: resolveExistingWorkdir(projectRoot, resolveChannelAgentWorkspace(channel, channel.agent)),
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
    resolveChannelAgentWorkspace(mappedChannels[0], agent.name),
  );
}

function resolveChannelAgentWorkspace(channel, agentName) {
  if (channel?.reviewer === agentName && channel?.reviewerWorkspace) {
    return channel.reviewerWorkspace;
  }
  if (channel?.arbiter === agentName && channel?.arbiterWorkspace) {
    return channel.arbiterWorkspace;
  }
  if (channel?.agent === agentName && channel?.ownerWorkspace) {
    return channel.ownerWorkspace;
  }
  return channel?.workspace || channel?.workdir;
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

async function handleAdminCommand({ cwd, rootOverride, argv }) {
  const { flags, positionals } = parseArgs(argv);
  assert(positionals.length === 0, 'Usage: hkclaw-lite admin [--host HOST] [--port PORT]');

  const projectRoot = resolveOrInitProjectRoot(cwd, rootOverride);
  const host = getFlagValue(flags, 'host', '127.0.0.1');
  const port = getFlagValue(flags, 'port', String(DEFAULT_ADMIN_PORT));
  await serveAdmin(projectRoot, {
    host,
    port,
  });
}

async function handleOnboardCommand({ cwd, rootOverride, argv }) {
  const { positionals } = parseArgs(argv);
  assert(positionals.length === 0, 'Usage: hkclaw-lite onboard');

  console.log('hkclaw-lite onboard — interactive first-run setup\n');

  const result = await withPrompter(async (prompter) => {
    // Step 1: project root
    const defaultRoot = rootOverride
      ? path.resolve(rootOverride)
      : path.join(os.homedir(), 'hkclaw-lite');
    const candidateRoot = await prompter.askText('1) 프로젝트 루트', {
      defaultValue: defaultRoot,
    });
    const projectRoot = path.resolve(candidateRoot);
    fs.mkdirSync(projectRoot, { recursive: true });
    const layout = getProjectLayout(projectRoot);
    if (!fs.existsSync(layout.configPath)) {
      initProject(projectRoot, { force: false });
      console.log(`   ${layout.toolRoot} 초기화 완료.`);
    } else {
      console.log(`   기존 프로젝트 사용: ${projectRoot}`);
    }

    // Step 2: admin password
    const enablePassword = await prompter.askConfirm(
      '2) 관리자 비밀번호 설정 (비활성화하면 누구나 admin 접근 가능)',
      { defaultValue: true },
    );
    if (enablePassword) {
      const password = await prompter.askText('   새 비밀번호', {
        validate: (value) =>
          String(value).trim().length >= 6 || '비밀번호는 6자 이상이어야 합니다.',
      });
      await setAdminPassword(projectRoot, password.trim());
      console.log('   비밀번호 저장 완료.');
    } else {
      console.log('   비밀번호 미설정 — 로그인 disabled.');
    }

    // Step 3: external admin URL / Kakao relay base
    const relayUrl = (
      await prompter.askText(
        '3) 외부 admin URL (Kakao relay base)\n   비우면 로컬 fallback 사용',
        { defaultValue: '', allowEmpty: true },
      )
    ).trim();
    const envFile = path.join(layout.toolRoot, 'service.env');
    if (relayUrl) {
      const normalized = relayUrl.endsWith('/') ? relayUrl : `${relayUrl}/`;
      fs.writeFileSync(envFile, `OPENCLAW_TALKCHANNEL_RELAY_URL=${normalized}\n`);
      console.log(`   ${envFile} 에 relay URL 저장.`);
    } else {
      console.log('   로컬 fallback 사용: http://127.0.0.1:5687/');
    }

    // Step 4: systemd service
    let serviceInstalled = false;
    if (process.platform === 'linux') {
      const installService = await prompter.askConfirm(
        '4) systemd user service 등록 + 시작?',
        { defaultValue: true },
      );
      if (installService) {
        const binPath = readBinPath();
        assert(binPath, '바이너리 경로 해석 실패. npm install -g hkclaw-lite 다시 시도.');
        const { unitPath } = installSystemdUnit({
          binPath,
          projectRoot,
          host: '0.0.0.0',
          port: String(DEFAULT_ADMIN_PORT),
        });
        console.log(`   ${unitPath} 작성 + daemon-reload.`);
        startService();
        console.log('   서비스 시작 완료.');
        serviceInstalled = true;
      } else {
        console.log('   systemd 등록 건너뜀. "hkclaw-lite start" 로 나중에 등록 가능.');
      }
    } else {
      console.log('4) systemd 등록은 Linux 에서만 지원. "hkclaw-lite admin" 으로 직접 실행.');
    }

    return { projectRoot, serviceInstalled };
  });

  console.log('\n완료. 다음 단계:');
  console.log(`   웹 어드민: http://127.0.0.1:${DEFAULT_ADMIN_PORT}`);
  console.log('   브라우저에서 AI 로그인 → 에이전트 추가 → 채널 추가 순으로 진행.');
  if (result.serviceInstalled) {
    console.log('   서비스 명령: hkclaw-lite status / restart / service logs -f');
  } else {
    console.log(`   직접 실행: cd ${result.projectRoot} && hkclaw-lite admin`);
  }
}

async function handleServiceCommand({ cwd, rootOverride, command, argv }) {
  if (command === 'start') {
    return runServiceInstallAndStart({ cwd, rootOverride, argv });
  }
  if (command === 'stop') {
    stopService();
    console.log(`Stopped ${getUnitPath()}`);
    return undefined;
  }
  if (command === 'restart') {
    restartService();
    console.log(`Restarted ${getUnitPath()}`);
    return undefined;
  }

  const [subcommand, ...tail] = argv;
  switch (subcommand) {
    case 'install':
      return runServiceInstall({ cwd, rootOverride, argv: tail, autoStart: false });
    case 'start':
      return runServiceInstallAndStart({ cwd, rootOverride, argv: tail });
    case 'stop':
      stopService();
      return undefined;
    case 'restart':
      restartService();
      return undefined;
    case 'status':
      serviceStatus();
      return undefined;
    case 'logs': {
      const { flags } = parseArgs(tail);
      serviceLogs({
        follow: getBooleanFlag(flags, 'follow') || getBooleanFlag(flags, 'f'),
        lines: parseOptionalInteger(getFlagValue(flags, 'lines')) ?? 200,
      });
      return undefined;
    }
    case 'uninstall':
      uninstallSystemdUnit();
      console.log(`Removed ${getUnitPath()}`);
      return undefined;
    default:
      throw new Error(
        'Usage: hkclaw-lite service <install|start|stop|restart|status|logs|uninstall>',
      );
  }
}

function runServiceInstall({ cwd, rootOverride, argv, autoStart }) {
  const { flags, positionals } = parseArgs(argv);
  assert(
    positionals.length === 0,
    'Usage: hkclaw-lite service install [--host HOST] [--port PORT]',
  );
  const projectRoot = resolveOrInitProjectRoot(cwd, rootOverride);
  const host = getFlagValue(flags, 'host', '0.0.0.0');
  const port = getFlagValue(flags, 'port', String(DEFAULT_ADMIN_PORT));
  const binPath = readBinPath();
  assert(binPath, 'Could not resolve hkclaw-lite binary path. Reinstall via npm install -g hkclaw-lite.');
  const { unitPath, envFile } = installSystemdUnit({ binPath, projectRoot, host, port });
  console.log(`Installed ${unitPath}`);
  console.log(`Project root: ${projectRoot}`);
  console.log(`Bind: ${host}:${port}`);
  if (envFile) {
    console.log(`EnvironmentFile: ${envFile}`);
  }
  if (autoStart) {
    startService();
    console.log('Service enabled and started.');
    console.log('  hkclaw-lite status   # SQLite-backed app status');
    console.log('  hkclaw-lite service status   # systemd unit state');
    console.log('  hkclaw-lite service logs -f  # follow journal');
  } else {
    console.log('Run "hkclaw-lite start" or "hkclaw-lite service start" to enable and launch.');
    console.log('If the service is already running, use "hkclaw-lite restart" to apply the new unit.');
  }
}

function runServiceInstallAndStart({ cwd, rootOverride, argv }) {
  return runServiceInstall({ cwd, rootOverride, argv, autoStart: true });
}

async function handleDiscordCommand(projectRoot, argv) {
  const [subcommand = 'serve', ...tail] = argv;
  if (subcommand !== 'serve') {
    throw new Error(`Unknown discord subcommand "${subcommand}".`);
  }

  const { flags } = parseArgs(tail);
  const { serveDiscord } = await import('./discord-service.js');
  await serveDiscord(projectRoot, {
    agentName: getFlagValue(flags, 'connector') || getFlagValue(flags, 'agent'),
  });
}

async function handleTelegramCommand(projectRoot, argv) {
  const [subcommand = 'serve', ...tail] = argv;
  if (subcommand !== 'serve') {
    throw new Error(`Unknown telegram subcommand "${subcommand}".`);
  }

  const { flags } = parseArgs(tail);
  const { serveTelegram } = await import('./telegram-service.js');
  await serveTelegram(projectRoot, {
    agentName: getFlagValue(flags, 'connector') || getFlagValue(flags, 'agent'),
  });
}

async function handleKakaoCommand(projectRoot, argv) {
  const [subcommand = 'serve', ...tail] = argv;
  if (subcommand !== 'serve') {
    throw new Error(`Unknown kakao subcommand "${subcommand}".`);
  }

  const { flags } = parseArgs(tail);
  const { serveKakao } = await import('./kakao-service.js');
  await serveKakao(projectRoot, {
    agentName: getFlagValue(flags, 'connector') || getFlagValue(flags, 'agent'),
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
    console.log(formatCiResult(await check()));
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
    });
    return;
  }

  let lastSummary = '';
  const result = await watchCi({
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
  });

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

async function startBackgroundCiWatch({
  projectRoot,
  provider,
  ci,
  intervalMs,
  timeoutMs,
  flags,
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
        env: buildCiWorkerEnv(provider, ci.request.token),
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

function buildCiWorkerEnv(provider, explicitToken) {
  const env = {
    ...process.env,
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
  const platform = await prompter.askChoice(
    'Which messaging platform should this agent use?',
    MESSAGING_PLATFORM_CHOICES,
    {
      defaultValue: initial.platform || 'discord',
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

  const definition = {
    name,
    agent,
    platform,
    model,
    effort,
    timeoutMs,
    systemPrompt,
    systemPromptFile,
    skills: skillsText ? parseCommaSeparatedList(skillsText) : [],
    contextFiles: contextFilesText ? parseCommaSeparatedList(contextFilesText) : [],
    fallbackAgent,
  };

  if (platform === 'telegram') {
    definition.telegramBotToken = await prompter.askText('Telegram bot token', {
      defaultValue: initial.telegramBotToken,
    });
  } else if (platform === 'kakao') {
    definition.kakaoRelayUrl = await prompter.askText('Kakao relay server URL', {
      defaultValue: initial.kakaoRelayUrl || getDefaultKakaoRelayUrl(),
      allowEmpty: true,
    });
    definition.kakaoRelayToken = await prompter.askText(
      'Kakao pairing token (optional; empty creates a pairing session)',
      {
        defaultValue: initial.kakaoRelayToken,
        allowEmpty: true,
      },
    );
    definition.kakaoSessionToken = await prompter.askText(
      'Kakao session token (optional)',
      {
        defaultValue: initial.kakaoSessionToken,
        allowEmpty: true,
      },
    );
  } else {
    definition.discordToken = await prompter.askText('Discord bot token', {
      defaultValue: initial.discordToken,
    });
  }

  if (AGENT_ACCESS_MODE_AGENT_TYPES.includes(agent)) {
    definition.sandbox = await prompter.askChoice(
      agent === 'codex' ? 'Codex sandbox mode' : 'Agent access mode',
      AGENT_ACCESS_MODE_CHOICES,
      {
        defaultValue: initial.sandbox,
      },
    );
    if (definition.sandbox === 'danger-full-access') {
      definition.dangerous = await prompter.askConfirm(
        agent === 'codex'
          ? 'Bypass Codex sandbox and approval checks?'
          : 'Enable full host-account access for this agent?',
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

async function promptForConnectorDefinition(prompter, config, options) {
  const initial = options.initial || {};
  const existingConnectorNames = new Set(Object.keys(config.connectors || {}));
  const name = await prompter.askText('Kakao session name (connector)', {
    defaultValue: initial.name,
    validate: (value) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        return 'Use only letters, numbers, dot, underscore, and dash.';
      }
      if (
        options.mode === 'add' &&
        existingConnectorNames.has(value) &&
        value !== initial.name
      ) {
        return `Kakao session "${value}" already exists.`;
      }
      if (
        options.mode === 'edit' &&
        value !== initial.name &&
        existingConnectorNames.has(value)
      ) {
        return `Kakao session "${value}" already exists.`;
      }
      return true;
    },
  });
  const connectorPlatform = CONNECTOR_PLATFORM_CHOICES[0];
  console.log(`Kakao session type: ${connectorPlatform.label} (${connectorPlatform.description})`);
  const description = await prompter.askText('Kakao session memo (optional)', {
    defaultValue: initial.description,
    allowEmpty: true,
  });
  const definition = {
    name,
    type: 'kakao',
    description,
  };
  definition.kakaoRelayUrl = await prompter.askText('Kakao relay server URL', {
    defaultValue: initial.kakaoRelayUrl || getDefaultKakaoRelayUrl(),
    allowEmpty: true,
  });
  definition.kakaoRelayToken = await prompter.askText(
    'Kakao pairing token (optional; empty creates a pairing session)',
    {
      defaultValue: initial.kakaoRelayToken,
      allowEmpty: true,
    },
  );
  definition.kakaoSessionToken = await prompter.askText('Kakao session token (optional)', {
    defaultValue: initial.kakaoSessionToken,
    allowEmpty: true,
  });
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

  const platform = await prompter.askChoice(
    'Which messaging platform should this channel use?',
    MESSAGING_PLATFORM_CHOICES,
    {
      defaultValue: initial.platform || 'discord',
    },
  );
  const connectorChoices = listConnectors(config)
    .filter((connector) => connector.type === platform)
    .map((connector) => ({
      value: connector.name,
      label: connector.name,
      description: connector.description || (platform === 'kakao' ? 'Kakao session' : `${platform} connector`),
    }));
  let connector = initial.connector || '';
  if (connectorChoices.length > 0) {
    connector = await prompter.askChoice(
      'Kakao session for this routing channel',
      [
        {
          value: '',
          label: 'Agent Kakao session settings',
          description: 'Use the Kakao session derived from the selected agent for compatibility',
        },
        ...connectorChoices,
      ],
      {
        defaultValue: initial.connector || '',
      },
    );
  }
  let targetType =
    initial.targetType || (initial.discordUserId ? 'direct' : 'channel');
  if (platform !== 'kakao') {
    targetType = await prompter.askChoice(
      'Message target',
      CHANNEL_TARGET_TYPE_CHOICES,
      {
        defaultValue: targetType,
      },
    );
  } else {
    targetType = '';
  }
  let discordChannelId = '';
  let discordUserId = '';
  let guildId = '';
  let telegramChatId = '';
  let telegramThreadId = '';
  let kakaoChannelId = '';
  let kakaoUserId = '';
  if (platform === 'telegram') {
    telegramChatId = await prompter.askText(
      targetType === 'direct' ? 'Telegram 1:1 chat ID' : 'Telegram group/channel chat ID',
      {
        defaultValue: initial.telegramChatId,
      },
    );
    if (targetType !== 'direct') {
      telegramThreadId = await prompter.askText('Telegram thread ID (optional)', {
        defaultValue: initial.telegramThreadId,
        allowEmpty: true,
      });
    }
  } else if (platform === 'kakao') {
    kakaoChannelId = await prompter.askText('Kakao inbound channelId filter (* allows any paired channel)', {
      defaultValue: initial.kakaoChannelId || '*',
    });
    kakaoUserId = await prompter.askText('Kakao user ID filter (optional; empty allows any paired user)', {
      defaultValue: initial.kakaoUserId,
      allowEmpty: true,
    });
  } else {
    if (targetType === 'direct') {
      discordUserId = await prompter.askText('Discord user ID for DM', {
        defaultValue: initial.discordUserId,
      });
    } else {
      discordChannelId = await prompter.askText('Discord channel ID', {
        defaultValue: initial.discordChannelId,
      });
      guildId = await prompter.askText('Discord guild ID (optional)', {
        defaultValue: initial.guildId,
        allowEmpty: true,
      });
    }
  }
  const workspace = await prompter.askText('Channel workspace directory', {
    defaultValue: initial.workspace ?? initial.workdir ?? getDefaultChannelWorkspace(),
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
  let ownerWorkspace = '';
  let reviewerWorkspace = '';
  let arbiterWorkspace = '';
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
    ownerWorkspace = await prompter.askText('Owner workspace override (optional)', {
      defaultValue: initial.ownerWorkspace,
      allowEmpty: true,
    });
    reviewerWorkspace = await prompter.askText('Reviewer workspace override (optional)', {
      defaultValue: initial.reviewerWorkspace,
      allowEmpty: true,
    });
    arbiterWorkspace = await prompter.askText('Arbiter workspace override (optional)', {
      defaultValue: initial.arbiterWorkspace,
      allowEmpty: true,
    });
  }
  const description = await prompter.askText('Channel description (optional)', {
    defaultValue: initial.description,
    allowEmpty: true,
  });

  return {
    name,
    platform,
    connector,
    targetType,
    mode: channelMode,
    discordChannelId,
    discordUserId,
    guildId,
    telegramChatId,
    telegramThreadId,
    kakaoChannelId,
    kakaoUserId,
    workspace,
    ownerWorkspace,
    reviewerWorkspace,
    arbiterWorkspace,
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
    lines.push(`  platform=${agent.platform || 'discord'}`);
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
    `platform=${channel.platform || 'discord'}`,
    channel.connector ? `connector=${channel.connector}` : null,
    `mode=${channel.mode || (channel.reviewer || channel.arbiter ? 'tribunal' : 'single')}`,
    ...renderChannelTargetStatusLines(channel),
    `workspace=${channel.workspace || channel.workdir}`,
    channel.ownerWorkspace ? `ownerWorkspace=${channel.ownerWorkspace}` : null,
    `agent=${channel.agent}`,
    channel.reviewer ? `reviewer=${channel.reviewer}` : null,
    channel.reviewerWorkspace ? `reviewerWorkspace=${channel.reviewerWorkspace}` : null,
    channel.arbiter ? `arbiter=${channel.arbiter}` : null,
    channel.arbiterWorkspace ? `arbiterWorkspace=${channel.arbiterWorkspace}` : null,
    channel.reviewRounds ? `reviewRounds=${channel.reviewRounds}` : null,
    channel.description ? `description=${channel.description}` : null,
    `agentType=${agent.agent}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderChannelTargetStatusLines(channel) {
  if (channel.platform === 'telegram') {
    return [
      channel.targetType ? `targetType=${channel.targetType}` : null,
      `telegramChatId=${channel.telegramChatId}`,
      channel.telegramThreadId ? `telegramThreadId=${channel.telegramThreadId}` : null,
    ];
  }
  if (channel.platform === 'kakao') {
    return [
      `kakaoChannelId=${channel.kakaoChannelId || '*'}`,
      channel.kakaoUserId ? `kakaoUserId=${channel.kakaoUserId}` : null,
    ];
  }
  if (channel.targetType === 'direct') {
    return [
      'targetType=direct',
      `discordUserId=${channel.discordUserId}`,
    ];
  }
  return [
    `discordChannelId=${channel.discordChannelId}`,
    channel.guildId ? `guildId=${channel.guildId}` : null,
  ];
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
    console.log(`  ${agent.name}\t${agent.agent}\tplatform=${agent.platform || 'discord'}`);
  }
}

function printConnectors(connectors) {
  console.log('Kakao sessions (connectors)');
  if (connectors.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const connector of connectors) {
    console.log(`  ${connector.name}\t${connector.type || 'discord'}${connector.description ? `\t${connector.description}` : ''}`);
  }
}

function printChannels(channels) {
  console.log('Channels');
  if (channels.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const channel of channels) {
    const target = formatChannelListTarget(channel);
    console.log(
      `  ${channel.name}\t${channel.platform || 'discord'}:${target}\tconnector=${channel.connector || 'legacy'}\tmode=${channel.mode || (channel.reviewer || channel.arbiter ? 'tribunal' : 'single')}\tagent=${channel.agent}\tworkspace=${channel.workspace || channel.workdir}`,
    );
  }
}

function formatChannelListTarget(channel) {
  if (channel.platform === 'telegram') {
    const prefix = channel.targetType === 'direct' ? 'dm:' : '';
    return channel.telegramThreadId
      ? `${prefix}${channel.telegramChatId}/${channel.telegramThreadId}`
      : `${prefix}${channel.telegramChatId}`;
  }
  if (channel.platform === 'kakao') {
    return channel.kakaoUserId
      ? `${channel.kakaoChannelId || '*'}/${channel.kakaoUserId}`
      : channel.kakaoChannelId || '*';
  }
  if (channel.targetType === 'direct') {
    return `dm:${channel.discordUserId || '-'}`;
  }
  return channel.discordChannelId;
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

function printSchedules(schedules) {
  console.log('Schedules');
  if (schedules.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const schedule of schedules) {
    const stateText = schedule.enabled ? 'enabled' : 'disabled';
    const targetText = `channel=${schedule.channelName || '-'}`;
    const timingText = formatScheduleSummary(schedule);
    const statusText = schedule.lastStatus ? `last=${schedule.lastStatus}` : 'last=never';
    console.log(
      `  ${schedule.name}\t${stateText}\t${targetText}\t${timingText}\tnext=${humanDate(schedule.nextRunAt)}\t${statusText}`,
    );
  }
}

function printScheduleRunResults(results) {
  if (!results.length) {
    console.log('No due schedules.');
    return;
  }
  for (const result of results) {
    const suffix = result.error ? `\t${result.error}` : '';
    console.log(
      `${result.scheduleName}\t${result.status}\trun=${result.runtimeRunId || '-'}\tnext=${result.nextRunAt ? humanDate(result.nextRunAt) : '-'}${suffix}`,
    );
  }
}

function formatDashboardMonitorText(monitors) {
  return monitors.includes(DASHBOARD_ALL_AGENTS) ? 'all' : monitors.join(', ');
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
    platform: getFlagValue(flags, 'platform'),
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
    discordToken: getFlagValue(flags, 'discord-token'),
    telegramBotToken: getFlagValue(flags, 'telegram-bot-token'),
    kakaoRelayUrl: getFlagValue(flags, 'kakao-relay-url'),
    kakaoRelayToken: getFlagValue(flags, 'kakao-relay-token'),
    kakaoSessionToken: getFlagValue(flags, 'kakao-session-token'),
    baseUrl: getFlagValue(flags, 'base-url'),
    command: getFlagValue(flags, 'command'),
  };
}

function buildConnectorPreset(name, flags) {
  return {
    name,
    type: getFlagValue(flags, 'type') || getFlagValue(flags, 'platform'),
    description: getFlagValue(flags, 'description'),
    discordToken: getFlagValue(flags, 'discord-token'),
    telegramBotToken: getFlagValue(flags, 'telegram-bot-token'),
    kakaoRelayUrl: getFlagValue(flags, 'kakao-relay-url'),
    kakaoRelayToken: getFlagValue(flags, 'kakao-relay-token'),
    kakaoSessionToken: getFlagValue(flags, 'kakao-session-token'),
  };
}

function isDerivedLegacyConnector(config, name, connector) {
  return Boolean(
    config.agents?.[name] &&
      connector?.description === 'Migrated from agent platform settings',
  );
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
    platform: getFlagValue(flags, 'platform'),
    connector: getFlagValue(flags, 'connector') || getFlagValue(flags, 'connector-name'),
    targetType: getFlagValue(flags, 'target-type') || getFlagValue(flags, 'target'),
    mode: getFlagValue(flags, 'mode') || getFlagValue(flags, 'channel-mode'),
    discordChannelId: getFlagValue(flags, 'discord-channel-id'),
    discordUserId: getFlagValue(flags, 'discord-user-id') || getFlagValue(flags, 'user-id'),
    guildId: getFlagValue(flags, 'guild-id'),
    telegramChatId: getFlagValue(flags, 'telegram-chat-id'),
    telegramThreadId: getFlagValue(flags, 'telegram-thread-id'),
    kakaoChannelId: getFlagValue(flags, 'kakao-channel-id'),
    kakaoUserId: getFlagValue(flags, 'kakao-user-id'),
    workspace: getFlagValue(flags, 'workspace') || getFlagValue(flags, 'workdir'),
    ownerWorkspace: getFlagValue(flags, 'owner-workspace'),
    reviewerWorkspace: getFlagValue(flags, 'reviewer-workspace'),
    arbiterWorkspace: getFlagValue(flags, 'arbiter-workspace'),
    agent: getFlagValue(flags, 'agent'),
    reviewer: getFlagValue(flags, 'reviewer'),
    arbiter: getFlagValue(flags, 'arbiter'),
    reviewRounds: getFlagValue(flags, 'review-rounds'),
    description: getFlagValue(flags, 'description'),
  };
}

function printHelp() {
  console.log(`hkclaw-lite

AI agent runtime managed primarily from the local web admin.
Use the web admin for most setup and day-to-day control; keep the CLI for automation and operational tasks.
Agents intentionally run with the full permissions of the host account that launched them.
Most commands auto-create .hkclaw-lite in the current directory when missing.
Installing the package never starts a process by itself.

Execution model:
  hkclaw-lite / --help      Show help only
  hkclaw-lite onboard       Interactive first-run setup wizard
  hkclaw-lite admin         Start the web admin server (foreground)
  hkclaw-lite start         Install + enable the systemd user service
  hkclaw-lite stop          Stop the systemd user service
  hkclaw-lite restart       Restart the systemd user service
  hkclaw-lite service ...   Manage the systemd user service (status, logs, uninstall)
  hkclaw-lite run ...       Execute one one-shot turn
  hkclaw-lite schedule ...  Manage durable channel schedules
  hkclaw-lite discord serve Start the long-running Discord worker
  hkclaw-lite telegram serve Start the long-running Telegram worker
  hkclaw-lite kakao serve   Start the long-running Kakao TalkChannel worker

Usage:
  hkclaw-lite onboard [--root DIR]
  hkclaw-lite init [--root DIR] [--force]
  hkclaw-lite admin [--root DIR] [--host 127.0.0.1] [--port ${DEFAULT_ADMIN_PORT}]
  hkclaw-lite start [--root DIR] [--host 0.0.0.0] [--port ${DEFAULT_ADMIN_PORT}]
  hkclaw-lite stop
  hkclaw-lite restart
  hkclaw-lite service install [--root DIR] [--host 0.0.0.0] [--port ${DEFAULT_ADMIN_PORT}]
  hkclaw-lite service status
  hkclaw-lite service logs [--follow] [--lines 200]
  hkclaw-lite service uninstall
  hkclaw-lite discord serve [--root DIR] [--agent <legacy-agent-name>]
  hkclaw-lite telegram serve [--root DIR] [--agent <legacy-agent-name>]
  hkclaw-lite kakao serve [--root DIR] [--connector <kakao-name>|--agent <legacy-agent-name>]
  hkclaw-lite backup export <file> [--root DIR] [--no-watchers] [--no-logs]
  hkclaw-lite backup import <file> [--root DIR] [--force]
  hkclaw-lite migrate --from <project-root> [--root DIR] [--force]
  hkclaw-lite add agent
  hkclaw-lite add connector   # KakaoTalk reusable session only
  hkclaw-lite add channel
  hkclaw-lite add dashboard
  hkclaw-lite edit agent <name>
  hkclaw-lite edit connector <name>
  hkclaw-lite edit channel <name>
  hkclaw-lite edit dashboard <name>
  hkclaw-lite remove agent <name> [--yes]
  hkclaw-lite remove connector <name> [--yes]
  hkclaw-lite remove channel <name> [--yes]
  hkclaw-lite remove dashboard <name> [--yes]
  hkclaw-lite list [agents|connectors|channels|dashboards|schedules|all]
  hkclaw-lite show agent <name>
  hkclaw-lite show connector <name>
  hkclaw-lite show channel <name>
  hkclaw-lite show dashboard <name>
  hkclaw-lite run <agent> [--workdir DIR] [--message TEXT]
  hkclaw-lite run --channel <name> [--message TEXT]
  hkclaw-lite schedule list
  hkclaw-lite schedule add <name> --channel <channel> (--every 10m|--daily 09:00 --timezone Asia/Seoul) --message TEXT
  hkclaw-lite schedule edit <name> [--every 1h|--daily 09:00] [--message TEXT] [--disabled]
  hkclaw-lite schedule run <name>
  hkclaw-lite schedule tick
  hkclaw-lite schedule remove <name> [--yes]
  hkclaw-lite dashboard [name] [--once]
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
  hkclaw-lite discord serve --agent discord-main
  hkclaw-lite telegram serve --agent telegram-main
  hkclaw-lite kakao serve --connector kakao-main
  hkclaw-lite backup export ./backups/project.json
  hkclaw-lite backup import ./backups/project.json --root ./restored
  hkclaw-lite migrate --from ../old-project --root ./new-project
  hkclaw-lite add agent
  hkclaw-lite add connector   # KakaoTalk reusable session only
  hkclaw-lite add channel
  hkclaw-lite add dashboard
  hkclaw-lite run --channel discord-main --message "summarize the repo"
  hkclaw-lite run dev-codex --workdir ./workspaces/dev --message "review the latest diff"
  hkclaw-lite schedule add daily-ops --channel discord-main --daily 09:00 --timezone Asia/Seoul --message "run the daily ops checklist"
  hkclaw-lite schedule add repo-watch --channel discord-main --every 30m --message "check for actionable repository updates"
  hkclaw-lite show agent dev-codex
  hkclaw-lite status channel discord-main
  hkclaw-lite ci watch gitlab --project group/project --pipeline-id 456
  hkclaw-lite ci watch gitlab --project group/project --pipeline-id 456 --background
  hkclaw-lite dashboard ops
`);
}

function uniqueChannelNames(channels) {
  return [...new Set(channels.map((channel) => channel.name))];
}

function uniqueChannelWorkspaces(channels) {
  return [
    ...new Set(
      channels
        .flatMap((channel) => [
          channel.workspace || channel.workdir,
          channel.ownerWorkspace,
          channel.reviewerWorkspace,
          channel.arbiterWorkspace,
        ])
        .filter(Boolean),
    ),
  ];
}
