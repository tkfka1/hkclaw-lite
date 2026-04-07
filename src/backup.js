import fs from 'node:fs';
import path from 'node:path';

import { getCiWatcherLogPath, listCiWatchers, saveCiWatcher } from './ci-watch-store.js';
import { CURRENT_CONFIG_VERSION } from './constants.js';
import { getProjectLayout, loadConfig, resolveProjectPath } from './store.js';
import { assert, ensureDir, isPlainObject, timestamp, writeJson } from './utils.js';

export const BACKUP_SCHEMA = 'hkclaw-lite-backup';
export const CURRENT_BACKUP_VERSION = 1;

export function createProjectBackup(
  projectRoot,
  { includeWatchers = true, includeLogs = true } = {},
) {
  const config = loadConfig(projectRoot);
  const assets = collectProjectAssets(projectRoot, config);

  return {
    schema: BACKUP_SCHEMA,
    version: CURRENT_BACKUP_VERSION,
    createdAt: timestamp(),
    sourceProjectRoot: projectRoot,
    configVersion: CURRENT_CONFIG_VERSION,
    config,
    directories: assets.directories,
    files: assets.files,
    externalRefs: assets.externalRefs,
    watchers: includeWatchers ? collectWatcherBackup(projectRoot, { includeLogs }) : [],
  };
}

export function writeProjectBackup(filePath, backup) {
  writeJson(path.resolve(filePath), backup);
}

export function restoreProjectBackup(projectRoot, backup, { force = false } = {}) {
  const normalized = normalizeBackup(backup);
  const layout = getProjectLayout(projectRoot);

  assert(
    force || isRestoreTargetEmpty(layout),
    'Project already has hkclaw-lite state. Use --force to overwrite it.',
  );
  if (!force) {
    assertNoBundledFileConflicts(projectRoot, normalized.files);
  }

  assertExternalReferencesExist(projectRoot, normalized.externalRefs);

  ensureDir(layout.toolRoot);
  clearExistingToolState(layout);

  for (const directoryPath of normalized.directories) {
    if (directoryPath === '.') {
      continue;
    }
    ensureDir(path.join(projectRoot, directoryPath));
  }

  for (const file of normalized.files) {
    const destinationPath = path.join(projectRoot, file.path);
    ensureDir(path.dirname(destinationPath));
    fs.writeFileSync(destinationPath, Buffer.from(file.contentBase64, 'base64'));
  }

  writeJson(layout.configPath, normalized.config);

  for (const watcher of normalized.watchers) {
    const watcherLogPath =
      watcher.log !== null ? getCiWatcherLogPath(projectRoot, watcher.state.id) : null;
    saveCiWatcher(projectRoot, {
      ...watcher.state,
      logPath: watcherLogPath,
    });
    if (watcher.log !== null) {
      fs.writeFileSync(watcherLogPath, watcher.log);
    }
  }

  // Validate the restored config before reporting success.
  loadConfig(projectRoot);

  return {
    agents: Object.keys(normalized.config.agents || {}).length,
    channels: Object.keys(normalized.config.channels || {}).length,
    dashboards: Object.keys(normalized.config.dashboards || {}).length,
    watchers: normalized.watchers.length,
    files: normalized.files.length,
    directories: normalized.directories.filter((entry) => entry !== '.').length,
    externalRefs: normalized.externalRefs.length,
  };
}

function collectProjectAssets(projectRoot, config) {
  const directorySet = new Set();
  const fileMap = new Map();
  const externalRefs = [];

  for (const [name, agent] of Object.entries(config.agents || {})) {
    if (agent.systemPromptFile) {
      collectPath(projectRoot, agent.systemPromptFile, `agent.${name}.systemPromptFile`, {
        expectDirectory: false,
        bundleDirectories: true,
        directorySet,
        fileMap,
        externalRefs,
      });
    }

    for (const [index, skillPath] of (agent.skills || []).entries()) {
      collectPath(projectRoot, skillPath, `agent.${name}.skills[${index}]`, {
        bundleDirectories: true,
        directorySet,
        fileMap,
        externalRefs,
      });
    }

    for (const [index, contextFile] of (agent.contextFiles || []).entries()) {
      collectPath(projectRoot, contextFile, `agent.${name}.contextFiles[${index}]`, {
        expectDirectory: false,
        bundleDirectories: true,
        directorySet,
        fileMap,
        externalRefs,
      });
    }
  }

  for (const [name, channel] of Object.entries(config.channels || {})) {
    collectPath(projectRoot, channel.workspace || channel.workdir, `channel.${name}.workspace`, {
      expectDirectory: true,
      bundleDirectoryContents: false,
      bundleDirectories: true,
      directorySet,
      fileMap,
      externalRefs,
    });
  }

  return {
    directories: [...directorySet].sort(comparePathDepth),
    files: [...fileMap.values()].sort((left, right) => left.path.localeCompare(right.path)),
    externalRefs: externalRefs.sort((left, right) => left.field.localeCompare(right.field)),
  };
}

function collectPath(projectRoot, rawPath, field, options) {
  const resolvedPath = resolveProjectPath(projectRoot, rawPath);
  const stats = fs.statSync(resolvedPath);
  const relativePath = toProjectRelativePath(projectRoot, resolvedPath);
  const type = stats.isDirectory() ? 'directory' : 'file';

  if (options.expectDirectory === true) {
    assert(stats.isDirectory(), `${field} must resolve to a directory: ${resolvedPath}`);
  }
  if (options.expectDirectory === false) {
    assert(stats.isFile(), `${field} must resolve to a file: ${resolvedPath}`);
  }

  if (!relativePath) {
    options.externalRefs.push({
      field,
      path: rawPath,
      type,
    });
    return;
  }

  if (stats.isDirectory()) {
    if (options.bundleDirectories) {
      options.directorySet.add(relativePath);
    }
    if (options.bundleDirectoryContents === false) {
      return;
    }
    collectDirectoryFiles(relativePath, resolvedPath, options.directorySet, options.fileMap);
    return;
  }

  collectFile(relativePath, resolvedPath, options.fileMap);
}

function collectDirectoryFiles(relativePath, resolvedPath, directorySet, fileMap) {
  directorySet.add(relativePath);
  for (const entry of fs.readdirSync(resolvedPath, { withFileTypes: true })) {
    const entryRelativePath = path.join(relativePath, entry.name);
    const entryResolvedPath = path.join(resolvedPath, entry.name);
    if (entry.isDirectory()) {
      collectDirectoryFiles(entryRelativePath, entryResolvedPath, directorySet, fileMap);
      continue;
    }
    collectFile(entryRelativePath, entryResolvedPath, fileMap);
  }
}

function collectFile(relativePath, resolvedPath, fileMap) {
  const normalizedPath = normalizeBundledPath(relativePath, 'bundled file path');
  if (fileMap.has(normalizedPath)) {
    return;
  }
  fileMap.set(normalizedPath, {
    path: normalizedPath,
    contentBase64: fs.readFileSync(resolvedPath).toString('base64'),
  });
}

function collectWatcherBackup(projectRoot, { includeLogs }) {
  return listCiWatchers(projectRoot).map((watcher) => {
    const logPath = getCiWatcherLogPath(projectRoot, watcher.id);
    return {
      state: {
        ...watcher,
        logPath: watcher.logPath ? path.join('.hkclaw-lite', 'watchers', `${watcher.id}.log`) : null,
      },
      log:
        includeLogs && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : null,
    };
  });
}

function normalizeBackup(rawBackup) {
  assert(isPlainObject(rawBackup), 'Backup file must be a JSON object.');
  assert(
    rawBackup.schema === BACKUP_SCHEMA,
    `Unsupported backup schema "${rawBackup.schema}".`,
  );
  assert(
    rawBackup.version === CURRENT_BACKUP_VERSION,
    `Unsupported backup version "${rawBackup.version}".`,
  );
  assert(isPlainObject(rawBackup.config), 'Backup config must be an object.');

  const directories = Array.isArray(rawBackup.directories)
    ? rawBackup.directories.map((entry) => normalizeBundledPath(entry, 'backup directory path'))
    : [];
  const files = Array.isArray(rawBackup.files)
    ? rawBackup.files.map((entry, index) => normalizeBackupFile(entry, index))
    : [];
  const watchers = Array.isArray(rawBackup.watchers)
    ? rawBackup.watchers.map((entry, index) => normalizeBackupWatcher(entry, index))
    : [];
  const externalRefs = Array.isArray(rawBackup.externalRefs)
    ? rawBackup.externalRefs.map((entry, index) => normalizeExternalRef(entry, index))
    : [];

  return {
    schema: BACKUP_SCHEMA,
    version: CURRENT_BACKUP_VERSION,
    createdAt: rawBackup.createdAt || timestamp(),
    sourceProjectRoot: rawBackup.sourceProjectRoot || null,
    configVersion: rawBackup.configVersion || null,
    config: rawBackup.config,
    directories: [...new Set(['.', ...directories])].sort(comparePathDepth),
    files,
    watchers,
    externalRefs,
  };
}

function normalizeBackupFile(entry, index) {
  assert(isPlainObject(entry), `Backup file entry ${index} must be an object.`);
  assert(
    typeof entry.contentBase64 === 'string',
    `Backup file entry ${index} is missing contentBase64.`,
  );
  return {
    path: normalizeBundledPath(entry.path, `backup file entry ${index} path`),
    contentBase64: entry.contentBase64,
  };
}

function normalizeBackupWatcher(entry, index) {
  assert(isPlainObject(entry), `Backup watcher entry ${index} must be an object.`);
  assert(isPlainObject(entry.state), `Backup watcher entry ${index} is missing state.`);
  assert(
    entry.log === null || typeof entry.log === 'string' || entry.log === undefined,
    `Backup watcher entry ${index} log must be a string or null.`,
  );
  return {
    state: entry.state,
    log: typeof entry.log === 'string' ? entry.log : null,
  };
}

function normalizeExternalRef(entry, index) {
  assert(isPlainObject(entry), `Backup external ref ${index} must be an object.`);
  assert(typeof entry.field === 'string' && entry.field, `Backup external ref ${index} field is required.`);
  assert(typeof entry.path === 'string' && entry.path, `Backup external ref ${index} path is required.`);
  assert(
    entry.type === 'file' || entry.type === 'directory',
    `Backup external ref ${index} type must be "file" or "directory".`,
  );
  return {
    field: entry.field,
    path: entry.path,
    type: entry.type,
  };
}

function normalizeBundledPath(rawPath, fieldName) {
  assert(typeof rawPath === 'string' && rawPath.trim().length > 0, `${fieldName} is required.`);
  const normalizedPath = path.normalize(rawPath);
  assert(!path.isAbsolute(normalizedPath), `${fieldName} must be relative.`);
  assert(
    normalizedPath !== '..' && !normalizedPath.startsWith(`..${path.sep}`),
    `${fieldName} must stay inside the project root.`,
  );
  return normalizedPath;
}

function assertExternalReferencesExist(projectRoot, externalRefs) {
  for (const ref of externalRefs) {
    const resolvedPath = resolveProjectPath(projectRoot, ref.path);
    assert(
      fs.existsSync(resolvedPath),
      `Backup references ${ref.field} outside the bundled project files, but it does not exist in the destination: ${resolvedPath}`,
    );
    const stats = fs.statSync(resolvedPath);
    if (ref.type === 'file') {
      assert(stats.isFile(), `${ref.field} must resolve to a file in the destination: ${resolvedPath}`);
    } else {
      assert(
        stats.isDirectory(),
        `${ref.field} must resolve to a directory in the destination: ${resolvedPath}`,
      );
    }
  }
}

function assertNoBundledFileConflicts(projectRoot, files) {
  for (const file of files) {
    const destinationPath = path.join(projectRoot, file.path);
    assert(
      !fs.existsSync(destinationPath),
      `Destination already contains ${destinationPath}. Use --force to overwrite bundled files.`,
    );
  }
}

function clearExistingToolState(layout) {
  ensureDir(layout.watchersRoot);

  if (fs.existsSync(layout.configPath)) {
    fs.rmSync(layout.configPath, { force: true });
  }

  for (const entry of fs.readdirSync(layout.watchersRoot)) {
    fs.rmSync(path.join(layout.watchersRoot, entry), { recursive: true, force: true });
  }
}

function isRestoreTargetEmpty(layout) {
  if (fs.existsSync(layout.configPath)) {
    return false;
  }
  if (!fs.existsSync(layout.watchersRoot)) {
    return true;
  }
  return fs.readdirSync(layout.watchersRoot).length === 0;
}

function toProjectRelativePath(projectRoot, resolvedPath) {
  const relativePath = path.relative(projectRoot, resolvedPath);
  if (!relativePath) {
    return '.';
  }
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
    return null;
  }
  if (path.isAbsolute(relativePath)) {
    return null;
  }
  return path.normalize(relativePath);
}

function comparePathDepth(left, right) {
  const depthDifference = pathDepth(left) - pathDepth(right);
  return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
}

function pathDepth(value) {
  if (value === '.') {
    return 0;
  }
  return value.split(path.sep).length;
}
