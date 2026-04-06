import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readJson(filePath, fallbackValue = undefined) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tempPath, filePath);
}

export function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.name = 'UsageError';
    throw error;
  }
}

export function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex >= 0) {
      const key = token.slice(2, equalsIndex);
      const value = token.slice(equalsIndex + 1);
      pushFlagValue(flags, key, value);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      pushFlagValue(flags, key, next);
      index += 1;
      continue;
    }

    pushFlagValue(flags, key, true);
  }

  return { flags, positionals };
}

function pushFlagValue(target, key, value) {
  const current = target[key];
  if (current === undefined) {
    target[key] = value;
    return;
  }
  if (Array.isArray(current)) {
    current.push(value);
    return;
  }
  target[key] = [current, value];
}

export function getFlagValue(flags, key, fallbackValue = undefined) {
  const value = flags[key];
  if (value === undefined) {
    return fallbackValue;
  }
  if (Array.isArray(value)) {
    return value.at(-1);
  }
  return value;
}

export function getFlagValues(flags, key) {
  const value = flags[key];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function getBooleanFlag(flags, key) {
  const value = getFlagValue(flags, key, false);
  return value === true || value === 'true';
}

export function parseInteger(value, fieldName) {
  const parsed = Number.parseInt(String(value), 10);
  assert(Number.isInteger(parsed), `${fieldName} must be an integer.`);
  return parsed;
}

export function parseOptionalInteger(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  return parseInteger(value, fieldName);
}

export function isSafeIdentifier(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function timestamp() {
  return new Date().toISOString();
}

export function humanDate(isoString) {
  return new Date(isoString).toLocaleString('sv-SE', { hour12: false });
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

export function stdinHasData() {
  return !process.stdin.isTTY;
}

export function resolveExecutable(binary) {
  const pathValue = process.env.PATH || '';
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  for (const segment of segments) {
    const candidate = path.join(segment, binary);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function parseKeyValuePairs(entries, fieldName) {
  const output = {};
  for (const entry of entries) {
    assert(typeof entry === 'string', `${fieldName} entries must be strings.`);
    const equalsIndex = entry.indexOf('=');
    assert(
      equalsIndex > 0,
      `${fieldName} entries must use KEY=VALUE format: received "${entry}".`,
    );
    const key = entry.slice(0, equalsIndex).trim();
    const value = entry.slice(equalsIndex + 1);
    assert(key.length > 0, `${fieldName} key cannot be empty.`);
    output[key] = value;
  }
  return output;
}

export function parseCommaSeparatedList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseCommaSeparatedList(entry));
  }
  if (value === undefined || value === null) {
    return [];
  }
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseKeyValueText(value, fieldName) {
  return parseKeyValuePairs(parseCommaSeparatedList(value), fieldName);
}

export function coerceBoolean(value, fallbackValue = false) {
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

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function trimTrailingWhitespace(text) {
  return text.replace(/\s+$/u, '');
}
