import readline from 'node:readline/promises';

import { buildPromptEnvelope } from './prompt.js';
import { inspectServiceRuntime, runServiceTurn } from './runners.js';
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
} from './session-store.js';
import {
  buildServiceDefinition,
  getProjectLayout,
  getService,
  initProject,
  listServices,
  loadConfig,
  removeService,
  resolveProjectRoot,
  saveConfig,
} from './store.js';
import {
  assert,
  getBooleanFlag,
  getFlagValue,
  getFlagValues,
  humanDate,
  parseArgs,
  parseKeyValuePairs,
  readStdin,
  stdinHasData,
  toErrorMessage,
} from './utils.js';

export async function main(argv) {
  try {
    const { rootOverride, rest } = extractGlobalOptions(argv);
    const [command, ...tail] = rest;

    if (!command || command === 'help' || command === '--help' || command === '-h') {
      printHelp();
      return;
    }

    if (command === 'init') {
      const projectRoot = rootOverride ? rootOverride : process.cwd();
      const { flags } = parseArgs(tail);
      initProject(projectRoot, { force: getBooleanFlag(flags, 'force') });
      const layout = getProjectLayout(projectRoot);
      console.log(`Initialized hkclaw-lite at ${layout.toolRoot}`);
      return;
    }

    const projectRoot = resolveProjectRoot(process.cwd(), rootOverride);

    switch (command) {
      case 'service':
        await handleServiceCommand(projectRoot, tail);
        return;
      case 'run':
        await handleRunCommand(projectRoot, tail);
        return;
      case 'chat':
        await handleChatCommand(projectRoot, tail);
        return;
      case 'session':
        await handleSessionCommand(projectRoot, tail);
        return;
      case 'status':
        await handleStatusCommand(projectRoot, tail);
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

async function handleServiceCommand(projectRoot, argv) {
  const [subcommand, ...tail] = argv;
  const config = loadConfig(projectRoot);

  switch (subcommand) {
    case 'add':
    case 'update': {
      const { flags, positionals } = parseArgs(tail);
      const name = positionals[0];
      const envEntries = getFlagValues(flags, 'env');
      const env =
        envEntries.length > 0 ? parseKeyValuePairs(envEntries, 'env') : undefined;
      const existing = subcommand === 'update' ? config.services[name] || null : {};
      if (subcommand === 'update') {
        assert(existing, `Service "${name}" does not exist.`);
      }
      const service = buildServiceDefinition(projectRoot, name, { ...flags, env }, existing);

      if (subcommand === 'add') {
        assert(!config.services[name], `Service "${name}" already exists.`);
      }

      config.services[name] = service;
      saveConfig(projectRoot, config);
      console.log(`${subcommand === 'add' ? 'Added' : 'Updated'} service "${name}".`);
      return;
    }
    case 'remove': {
      const { positionals } = parseArgs(tail);
      const name = positionals[0];
      removeService(config, name);
      saveConfig(projectRoot, config);
      console.log(`Removed service "${name}".`);
      return;
    }
    case 'list': {
      const services = listServices(config);
      if (services.length === 0) {
        console.log('No services configured.');
        return;
      }
      for (const service of services) {
        console.log(
          `${service.name}\tagent=${service.agent}\tworkdir=${service.workdir}`,
        );
      }
      return;
    }
    case 'show': {
      const { positionals } = parseArgs(tail);
      const name = positionals[0];
      console.log(JSON.stringify(getService(config, name), null, 2));
      return;
    }
    default:
      throw new Error(
        'Usage: hkclaw-lite service <add|update|remove|list|show> ...',
      );
  }
}

async function handleRunCommand(projectRoot, argv) {
  const { flags, positionals } = parseArgs(argv);
  const serviceName = positionals[0];
  assert(serviceName, 'Usage: hkclaw-lite run <service> [prompt]');
  const prompt = await resolvePromptText(positionals.slice(1), flags);
  const config = loadConfig(projectRoot);
  const service = getService(config, serviceName);
  const requestedSessionId =
    getFlagValue(flags, 'session') ||
    (getBooleanFlag(flags, 'last')
      ? resolveSessionId(projectRoot, serviceName, { useLast: true })
      : null);

  const response = await executeTurn({
    projectRoot,
    config,
    service,
    sessionId: requestedSessionId,
    prompt,
    persist: Boolean(requestedSessionId),
  });

  console.log(response);
}

async function handleChatCommand(projectRoot, argv) {
  const { flags, positionals } = parseArgs(argv);
  const serviceName = positionals[0];
  assert(serviceName, 'Usage: hkclaw-lite chat <service> [prompt]');
  const config = loadConfig(projectRoot);
  const service = getService(config, serviceName);
  const explicitSessionId = getFlagValue(flags, 'session');
  const useLast = getBooleanFlag(flags, 'last');
  const sessionId = resolveSessionId(projectRoot, serviceName, {
    requested: explicitSessionId,
    useLast,
  });

  const message = await resolvePromptText(positionals.slice(1), flags, {
    allowEmpty: true,
  });
  if (message) {
    const response = await executeTurn({
      projectRoot,
      config,
      service,
      sessionId,
      prompt: message,
      persist: true,
    });
    console.log(response);
    return;
  }

  await startInteractiveChat(projectRoot, config, service, sessionId);
}

async function handleSessionCommand(projectRoot, argv) {
  const [subcommand, ...tail] = argv;
  switch (subcommand) {
    case 'list': {
      const { positionals } = parseArgs(tail);
      const serviceName = positionals[0] || null;
      const sessions = listSessions(projectRoot, serviceName);
      if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
      }
      for (const session of sessions) {
        console.log(
          `${session.service}/${session.id}\tupdated=${humanDate(session.updatedAt)}\tturns=${session.turnCount}`,
        );
      }
      return;
    }
    case 'show': {
      const { positionals } = parseArgs(tail);
      const [serviceName, sessionId] = positionals;
      assert(serviceName && sessionId, 'Usage: hkclaw-lite session show <service> <session>');
      const session = loadExistingSession(projectRoot, serviceName, sessionId);
      console.log(formatSession(session));
      return;
    }
    case 'clear': {
      const { positionals } = parseArgs(tail);
      const [serviceName, sessionId] = positionals;
      assert(
        serviceName && sessionId,
        'Usage: hkclaw-lite session clear <service> <session>',
      );
      clearSession(projectRoot, serviceName, sessionId);
      console.log(`Cleared session "${sessionId}" for "${serviceName}".`);
      return;
    }
    case 'remove': {
      const { positionals } = parseArgs(tail);
      const [serviceName, sessionId] = positionals;
      assert(
        serviceName && sessionId,
        'Usage: hkclaw-lite session remove <service> <session>',
      );
      deleteSession(projectRoot, serviceName, sessionId);
      console.log(`Removed session "${sessionId}" for "${serviceName}".`);
      return;
    }
    default:
      throw new Error(
        'Usage: hkclaw-lite session <list|show|clear|remove> ...',
      );
  }
}

async function handleStatusCommand(projectRoot, argv) {
  const { positionals } = parseArgs(argv);
  const config = loadConfig(projectRoot);
  const services = positionals[0]
    ? [getService(config, positionals[0])]
    : listServices(config);

  console.log(`project=${projectRoot}`);
  console.log(`services=${services.length}`);
  if (services.length === 0) {
    return;
  }
  for (const service of services) {
    const runtime = inspectServiceRuntime(projectRoot, service);
    const sessionCount = listSessions(projectRoot, service.name).length;
    console.log('');
    console.log(`${service.name}`);
    console.log(`  agent=${service.agent}`);
    console.log(`  workdir=${runtime.workdir}`);
    console.log(`  ready=${runtime.ready ? 'yes' : 'no'}`);
    console.log(`  detail=${runtime.detail}`);
    console.log(`  sessions=${sessionCount}`);
  }
}

async function executeTurn({
  projectRoot,
  config,
  service,
  sessionId,
  prompt,
  persist,
}) {
  const session = persist && sessionId ? loadSession(projectRoot, service.name, sessionId) : null;
  const fullPrompt = buildPromptEnvelope({
    projectRoot,
    config,
    service,
    session,
    userPrompt: prompt,
  });
  const response = await runServiceTurn({
    projectRoot,
    service,
    prompt: fullPrompt,
    rawPrompt: prompt,
    sessionId,
  });

  if (persist && session) {
    appendTurn(session, prompt, response);
    saveSession(projectRoot, session);
  }

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
  throw new Error('Prompt is required. Pass text or pipe stdin.');
}

async function startInteractiveChat(projectRoot, config, service, sessionId) {
  console.log(`service=${service.name}`);
  console.log(`session=${sessionId}`);
  console.log('Commands: .help .history .clear .exit');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const line = (await rl.question(`${service.name}> `)).trim();
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
        const session = loadSession(projectRoot, service.name, sessionId);
        console.log(formatSession(session));
        continue;
      }
      if (line === '.clear') {
        clearSession(projectRoot, service.name, sessionId);
        console.log('Session cleared.');
        continue;
      }

      const response = await executeTurn({
        projectRoot,
        config,
        service,
        sessionId,
        prompt: line,
        persist: true,
      });
      console.log(response);
    }
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log(`hkclaw-lite

Usage:
  hkclaw-lite init [--root DIR] [--force]
  hkclaw-lite service add <name> --agent <agent> [options]
  hkclaw-lite service update <name> [options]
  hkclaw-lite service remove <name>
  hkclaw-lite service list
  hkclaw-lite service show <name>
  hkclaw-lite run <service> [prompt] [--session ID|--last]
  hkclaw-lite chat <service> [prompt] [--session ID|--last]
  hkclaw-lite session list [service]
  hkclaw-lite session show <service> <session>
  hkclaw-lite session clear <service> <session>
  hkclaw-lite session remove <service> <session>
  hkclaw-lite status [service]

Agents:
  codex
  claude-code
  gemini-cli
  local-llm
  command

Common service options:
  --workdir DIR
  --model MODEL
  --effort LEVEL
  --system TEXT
  --system-file FILE
  --history-window N
  --timeout-ms N
  --env KEY=VALUE

Agent-specific options:
  codex: --sandbox read-only|workspace-write|danger-full-access --dangerous
  claude-code: --permission-mode MODE --dangerous
  local-llm: --base-url URL
  command: --command "node ./script.mjs"
`);
}
