import fs from 'node:fs';
import path from 'node:path';

import { TOOL_DIRNAME } from './constants.js';

export function getProjectEnvFilePaths(projectRoot) {
  const root = String(projectRoot || '').trim();
  if (!root) {
    return [];
  }

  return [
    path.join(root, '.env'),
    path.join(root, TOOL_DIRNAME, '.env'),
  ].filter((filePath) => fs.existsSync(filePath));
}

export function buildProjectEnv(projectRoot, baseEnv = process.env) {
  const mergedFromFiles = {};
  for (const filePath of getProjectEnvFilePaths(projectRoot)) {
    Object.assign(mergedFromFiles, parseDotEnv(fs.readFileSync(filePath, 'utf8')));
  }
  return {
    ...mergedFromFiles,
    ...(baseEnv || {}),
  };
}

export function parseDotEnv(source) {
  const text = String(source || '').replace(/^\uFEFF/u, '');
  const env = {};

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalizedLine = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equalsIndex = normalizedLine.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }

    const rawValue = normalizedLine.slice(equalsIndex + 1).trimStart();
    env[key] = parseDotEnvValue(rawValue);
  }

  return env;
}

function parseDotEnvValue(rawValue) {
  if (!rawValue) {
    return '';
  }

  if (rawValue.startsWith('"')) {
    const quoted = stripMatchingQuote(rawValue, '"');
    return quoted.replace(/\\n/gu, '\n').replace(/\\r/gu, '\r').replace(/\\t/gu, '\t').replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
  }

  if (rawValue.startsWith("'")) {
    return stripMatchingQuote(rawValue, "'");
  }

  return stripInlineComment(rawValue).trimEnd();
}

function stripMatchingQuote(value, quote) {
  if (value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value.slice(1);
}

function stripInlineComment(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '#') {
      continue;
    }
    if (index === 0 || /\s/u.test(value[index - 1])) {
      return value.slice(0, index);
    }
  }
  return value;
}
