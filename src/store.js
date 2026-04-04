import fs from 'node:fs';
import path from 'node:path';

import {
  CONFIG_FILENAME,
  CURRENT_CONFIG_VERSION,
  DEFAULT_HISTORY_WINDOW,
  SUPPORTED_AGENTS,
  TOOL_DIRNAME,
} from './constants.js';
import {
  assert,
  ensureDir,
  isPlainObject,
  parseInteger,
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
    },
    services: {},
  };
}

export function loadConfig(projectRoot) {
  const layout = getProjectLayout(projectRoot);
  const config = readJson(layout.configPath);
  assert(
    isPlainObject(config),
    `Invalid config file at ${layout.configPath}. Expected a JSON object.`,
  );
  assert(
    config.version === CURRENT_CONFIG_VERSION,
    `Unsupported config version "${config.version}".`,
  );
  assert(
    isPlainObject(config.defaults),
    'Config defaults must be an object.',
  );
  assert(
    isPlainObject(config.services),
    'Config services must be an object.',
  );

  return config;
}

export function saveConfig(projectRoot, config) {
  const layout = getProjectLayout(projectRoot);
  writeJson(layout.configPath, config);
}

export function listServices(config) {
  return Object.entries(config.services)
    .map(([name, service]) => ({ name, ...service }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getService(config, name) {
  const service = config.services[name];
  assert(service, `Unknown service "${name}".`);
  return { name, ...service };
}

export function removeService(config, name) {
  assert(config.services[name], `Unknown service "${name}".`);
  delete config.services[name];
}

export function buildServiceDefinition(projectRoot, name, flags, existing = {}) {
  assert(name, 'Service name is required.');
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    'Service name may only contain letters, numbers, dot, underscore, and dash.',
  );

  const merged = {
    ...existing,
    agent: getRequiredString(flags.agent ?? existing.agent, 'agent'),
    workdir: flags.workdir ?? existing.workdir ?? '.',
    model: flags.model ?? existing.model,
    effort: flags.effort ?? existing.effort,
    systemPrompt: flags.system ?? existing.systemPrompt,
    systemPromptFile: flags['system-file'] ?? existing.systemPromptFile,
    historyWindow:
      flags['history-window'] !== undefined
        ? parseInteger(flags['history-window'], 'history-window')
        : existing.historyWindow,
    timeoutMs:
      flags['timeout-ms'] !== undefined
        ? parseInteger(flags['timeout-ms'], 'timeout-ms')
        : existing.timeoutMs,
    sandbox: flags.sandbox ?? existing.sandbox,
    permissionMode: flags['permission-mode'] ?? existing.permissionMode,
    dangerous:
      flags.dangerous !== undefined
        ? flags.dangerous === true || flags.dangerous === 'true'
        : existing.dangerous,
    baseUrl: flags['base-url'] ?? existing.baseUrl,
    command: flags.command ?? existing.command,
    env: flags.env ?? existing.env ?? {},
  };

  validateServiceDefinition(projectRoot, merged);
  return sortObjectKeys(merged);
}

function validateServiceDefinition(projectRoot, service) {
  assert(
    SUPPORTED_AGENTS.includes(service.agent),
    `Unsupported agent "${service.agent}". Supported: ${SUPPORTED_AGENTS.join(', ')}.`,
  );

  assert(
    typeof service.workdir === 'string' && service.workdir.trim().length > 0,
    'workdir is required.',
  );
  const resolvedWorkdir = resolveProjectPath(projectRoot, service.workdir);
  assert(fs.existsSync(resolvedWorkdir), `Workdir does not exist: ${resolvedWorkdir}`);

  if (service.systemPromptFile) {
    const resolvedPromptFile = resolveProjectPath(
      projectRoot,
      service.systemPromptFile,
    );
    assert(
      fs.existsSync(resolvedPromptFile),
      `System prompt file does not exist: ${resolvedPromptFile}`,
    );
  }

  if (service.historyWindow !== undefined) {
    assert(
      Number.isInteger(service.historyWindow) && service.historyWindow > 0,
      'historyWindow must be a positive integer.',
    );
  }

  if (service.timeoutMs !== undefined) {
    assert(
      Number.isInteger(service.timeoutMs) && service.timeoutMs > 0,
      'timeoutMs must be a positive integer.',
    );
  }

  if (service.agent === 'local-llm') {
    assert(
      typeof service.model === 'string' && service.model.trim().length > 0,
      'local-llm services require --model.',
    );
  }

  if (service.agent === 'command') {
    assert(
      typeof service.command === 'string' && service.command.trim().length > 0,
      'command services require --command.',
    );
  }
}

function getRequiredString(value, fieldName) {
  assert(
    typeof value === 'string' && value.trim().length > 0,
    `${fieldName} is required.`,
  );
  return value.trim();
}

function sortObjectKeys(value) {
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [
        key,
        isPlainObject(entryValue) ? sortObjectKeys(entryValue) : entryValue,
      ]),
  );
}

export function resolveProjectPath(projectRoot, maybeRelativePath) {
  return path.resolve(projectRoot, maybeRelativePath);
}
