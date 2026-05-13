import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  DEFAULT_CLAUDE_PERMISSION_MODE,
  DEFAULT_CODEX_SANDBOX,
  DEFAULT_LOCAL_LLM_BASE_URL,
  MANAGED_AGENT_RUNTIMES,
} from './constants.js';
import {
  loadConfig,
  resolveLocalLlmConnectionConfig,
  resolveProjectPath,
} from './store.js';
import {
  assert,
  resolveExecutable,
  toErrorMessage,
  trimTrailingWhitespace,
} from './utils.js';

const CLAUDE_EXTERNAL_CLI_ENV = 'HKCLAW_LITE_CLAUDE_CLI';
const CODEX_EXTERNAL_CLI_ENV = 'HKCLAW_LITE_CODEX_CLI';
const GEMINI_EXTERNAL_CLI_ENV = 'HKCLAW_LITE_GEMINI_CLI';
export const CLAUDE_ACP_DISABLED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_VERSION',
];
export const GEMINI_CLI_DISABLED_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_BASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GOOGLE_GENAI_USE_GCA',
];

export async function runAgentTurn({
  projectRoot,
  agent,
  prompt,
  rawPrompt,
  workdir,
  channel = null,
  role = null,
  runtimeSession = null,
  captureRuntimeMetadata = false,
  onStreamEvent = null,
}) {
  let result;
  switch (agent.agent) {
    case 'codex':
      result = await runCodex({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        onStreamEvent,
      });
      break;
    case 'claude-code':
      result = await runClaude({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        channel,
        role,
        runtimeSession,
        onStreamEvent,
      });
      break;
    case 'gemini-cli':
      result = await runGeminiCli({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
      });
      break;
    case 'local-llm':
      result = await runLocalLlm({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
      });
      break;
    case 'command':
      result = await runCommand({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
      });
      break;
    default:
      throw new Error(`Unsupported agent "${agent.agent}".`);
  }

  return normalizeAgentTurnResult(result, { captureRuntimeMetadata });
}

export function inspectAgentRuntime(projectRoot, agent, workdirOverride = null) {
  const workdir = resolveExecutionWorkdir(projectRoot, agent, workdirOverride);
  switch (agent.agent) {
    case 'codex':
      return buildManagedAgentRuntimeStatus('codex', workdir);
    case 'claude-code':
      return buildManagedAgentRuntimeStatus('claude-code', workdir);
    case 'gemini-cli':
      return buildManagedAgentRuntimeStatus('gemini-cli', workdir);
    case 'local-llm':
      {
        const config = loadConfig(projectRoot);
        const connection = resolveLocalLlmConnectionConfig(config, agent);
        const detail = connection.connectionName
          ? `${connection.connectionName} (${connection.baseUrl})`
          : connection.baseUrl || DEFAULT_LOCAL_LLM_BASE_URL;
        return {
          ready: true,
          detail,
          workdir,
        };
      }
    case 'command':
      return {
        ready: true,
        detail: agent.command,
        workdir,
      };
    default:
      return {
        ready: false,
        detail: 'unknown agent',
        workdir,
      };
  }
}

export const runServiceTurn = runAgentTurn;
export const inspectServiceRuntime = inspectAgentRuntime;

export function buildCommandExecutionSpec(
  command,
  {
    platform = process.platform,
    env = process.env,
  } = {},
) {
  if (platform === 'win32') {
    return {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }

  return {
    command: resolvePosixShell(env),
    args: ['-lc', command],
  };
}

async function runCodex({
  projectRoot,
  service,
  prompt,
  rawPrompt,
  workdir,
  onStreamEvent,
}) {
  const cli = requireManagedAgentCli('codex', process.env);
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-codex-'));
  const lastMessageFile = path.join(tempDir, 'last-message.txt');
  const sandbox = service.sandbox || DEFAULT_CODEX_SANDBOX;
  const args = [
    ...cli.argsPrefix,
    'exec',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--json',
    '-C',
    executionWorkdir,
    '-o',
    lastMessageFile,
    '-',
  ];

  if (service.model) {
    args.splice(args.length - 1, 0, '--model', service.model);
  }
  if (sandbox === 'danger-full-access' || service.dangerous) {
    args.splice(args.length - 1, 0, '--dangerously-bypass-approvals-and-sandbox');
  } else if (sandbox === 'workspace-write') {
    args.splice(args.length - 1, 0, '--full-auto');
  } else {
    args.splice(args.length - 1, 0, '--sandbox', sandbox);
  }

  const env = applyEnvPatch(
    buildChildEnv({
      projectRoot,
      workdir: executionWorkdir,
      service,
      rawPrompt,
      fullPrompt: prompt,
    }),
    cli.envPatch,
  );
  if (service.effort) {
    env.CODEX_EFFORT = service.effort;
  }

  try {
    const result = await runChildProcess({
      command: cli.command,
      args,
      cwd: executionWorkdir,
      env,
      input: prompt,
      timeoutMs: service.timeoutMs,
      onStdoutLine:
        typeof onStreamEvent === 'function'
          ? async (line) => {
              const event = extractCodexExecStreamEvent(parseCodexExecJsonLine(line));
              if (event) {
                await onStreamEvent(event);
              }
            }
          : null,
    });
    const finalText = fs.existsSync(lastMessageFile)
      ? fs.readFileSync(lastMessageFile, 'utf8')
      : result.stdout;
    const metadata = parseCodexExecJsonOutput(result.stdout);
    return {
      text: trimTrailingWhitespace(finalText || metadata.text).trim(),
      usage: metadata.usage,
      runtimeMeta: metadata.runtimeMeta,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runClaude({
  projectRoot,
  service,
  prompt,
  rawPrompt,
  workdir,
  channel,
  role,
  runtimeSession,
  onStreamEvent,
}) {
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const env = stripClaudeAcpEnv(buildChildEnv({
    projectRoot,
    workdir: executionWorkdir,
    service,
    rawPrompt,
    fullPrompt: prompt,
  }));
  const cli = requireClaudeCli(env);
  const permissionMode = service.dangerous
    ? 'bypassPermissions'
    : (service.permissionMode || DEFAULT_CLAUDE_PERMISSION_MODE);
  const args = [
    ...cli.argsPrefix,
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
  ];

  const sessionSpec = buildClaudeCliSessionSpec({
    channel,
    role,
    runtimeSession,
  });
  if (sessionSpec.resumeSessionId) {
    args.push('--resume', sessionSpec.resumeSessionId);
  } else if (sessionSpec.newSessionId) {
    args.push('--session-id', sessionSpec.newSessionId);
  } else {
    args.push('--no-session-persistence');
  }

  if (permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }

  if (service.model) {
    args.push('--model', service.model);
  }
  if (service.effort) {
    args.push('--effort', service.effort);
  }

  const streamState = createClaudeCliStreamState();
  const result = await runChildProcess({
    command: cli.command,
    args,
    cwd: executionWorkdir,
    env: applyEnvPatch(env, cli.envPatch),
    input: prompt,
    timeoutMs: service.timeoutMs,
    onStdoutLine:
      typeof onStreamEvent === 'function'
        ? async (line) => {
            const message = parseClaudeCliStreamJsonLine(line);
            const event = extractClaudeCliStreamEvent(message, streamState);
            if (event) {
              await onStreamEvent(event);
            }
          }
        : null,
  });
  return parseClaudeCliStreamJson(result.stdout, {
    fallbackSessionId: sessionSpec.newSessionId || sessionSpec.resumeSessionId || null,
  });
}

async function runGeminiCli({
  projectRoot,
  service,
  prompt,
  rawPrompt,
  workdir,
}) {
  const cli = requireManagedAgentCli('gemini-cli', process.env);
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const args = [...cli.argsPrefix, '-p', prompt, '--output-format', 'json'];
  if (service.model) {
    args.push('-m', service.model);
  }
  const accessMode = resolveAgentAccessMode(service);
  if (accessMode === 'danger-full-access') {
    args.push('--approval-mode', 'yolo', '--skip-trust');
  } else if (accessMode === 'workspace-write') {
    args.push('--approval-mode', 'auto_edit', '--skip-trust');
  } else if (accessMode === 'read-only') {
    args.push('--approval-mode', 'plan', '--skip-trust');
  }

  const geminiEnv = stripGeminiCliEnv(buildChildEnv({
    projectRoot,
    workdir: executionWorkdir,
    service,
    rawPrompt,
    fullPrompt: prompt,
  }));
  geminiEnv.GOOGLE_GENAI_USE_GCA = 'true';
  const tempDir = createGeminiEffortSettingsDir(service);
  if (tempDir) {
    geminiEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH = path.join(tempDir, 'settings.json');
  }

  try {
    const result = await runChildProcess({
      command: cli.command,
      args,
      cwd: executionWorkdir,
      env: applyEnvPatch(geminiEnv, cli.envPatch),
      timeoutMs: service.timeoutMs,
    });

    try {
      const parsed = JSON.parse(result.stdout);
      const text =
        parsed.text ||
        parsed.responseJson?.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || '')
          .join('\n')
          .trim();
      return {
        text: trimTrailingWhitespace(text || result.stdout).trim(),
        usage: extractGeminiCliUsage(parsed),
      };
    } catch {
      return trimTrailingWhitespace(result.stdout).trim();
    }
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function createGeminiEffortSettingsDir(service) {
  const thinkingConfig = resolveGeminiThinkingConfig(service.model, service.effort);
  if (!thinkingConfig) {
    return null;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-lite-gemini-'));
  const settingsPath = path.join(tempDir, 'settings.json');
  const override = {
    match: service.model ? { model: service.model } : { overrideScope: 'core' },
    modelConfig: {
      generateContentConfig: {
        thinkingConfig,
      },
    },
  };
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      modelConfigs: {
        customOverrides: [override],
      },
    }),
  );
  return tempDir;
}

function resolveGeminiThinkingConfig(model, effort) {
  const value = String(effort || '').trim().toLowerCase();
  if (!value) {
    return null;
  }

  const id = String(model || '').trim().toLowerCase();
  if (id.startsWith('gemini-3')) {
    if (value === 'minimal' || value === 'low') {
      return { thinkingLevel: 'LOW' };
    }
    if (value === 'medium' || value === 'high') {
      return { thinkingLevel: 'HIGH' };
    }
    return null;
  }

  const thinkingBudgets = {
    none: 0,
    minimal: 512,
    low: 2048,
    medium: 8192,
    high: 24576,
  };
  return Object.hasOwn(thinkingBudgets, value)
    ? { thinkingBudget: thinkingBudgets[value] }
    : null;
}

async function runLocalLlm({
  projectRoot,
  service,
  prompt,
  rawPrompt,
  workdir,
}) {
  void rawPrompt;
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const config = loadConfig(projectRoot);
  const resolvedConnection = resolveLocalLlmConnectionConfig(config, service);
  const baseUrl = (resolvedConnection.baseUrl || DEFAULT_LOCAL_LLM_BASE_URL).replace(/\/$/, '');
  const headers = {
    'content-type': 'application/json',
  };
  if (resolvedConnection.apiKey) {
    headers.authorization = `Bearer ${resolvedConnection.apiKey}`;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: service.model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  const payload = await response
    .json()
    .catch(() => ({ error: `Invalid JSON response from ${baseUrl}` }));

  if (!response.ok) {
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : payload.error?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }

  const content = payload.choices?.[0]?.message?.content;
  assert(content, 'local-llm response did not include assistant content.');
  return {
    text: trimTrailingWhitespace(content).trim(),
    usage: normalizeUsageSnapshot({
      inputTokens: payload?.usage?.prompt_tokens,
      outputTokens: payload?.usage?.completion_tokens,
      totalTokens: payload?.usage?.total_tokens,
    }),
  };
}

async function runCommand({
  projectRoot,
  service,
  prompt,
  rawPrompt,
  workdir,
}) {
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const env = buildChildEnv({
    projectRoot,
    workdir: executionWorkdir,
    service,
    rawPrompt,
    fullPrompt: prompt,
  });
  const execution = buildCommandExecutionSpec(service.command, {
    env,
  });
  const result = await runChildProcess({
    command: execution.command,
    args: execution.args,
    cwd: executionWorkdir,
    env,
    input: prompt,
    timeoutMs: service.timeoutMs,
  });
  return trimTrailingWhitespace(result.stdout).trim();
}

function buildChildEnv({
  projectRoot,
  workdir,
  service,
  rawPrompt,
  fullPrompt,
}) {
  const accessMode = resolveAgentAccessMode(service);
  const dangerous =
    accessMode === 'danger-full-access' ||
    service.permissionMode === 'bypassPermissions' ||
    Boolean(service.dangerous);
  return {
    ...process.env,
    HKCLAW_LITE_PROJECT_ROOT: projectRoot,
    HKCLAW_LITE_AGENT_NAME: service.name,
    HKCLAW_LITE_SERVICE_NAME: service.name,
    HKCLAW_LITE_AGENT: service.agent,
    HKCLAW_LITE_WORKDIR: workdir,
    HKCLAW_LITE_RAW_PROMPT: rawPrompt,
    HKCLAW_LITE_FULL_PROMPT: fullPrompt,
    HKCLAW_LITE_AGENT_ACCESS_MODE: accessMode,
    HKCLAW_LITE_AGENT_PERMISSION_MODE: service.permissionMode || '',
    HKCLAW_LITE_AGENT_DANGEROUS: dangerous ? '1' : '',
    HKCLAW_LITE_SKILLS: (service.skills || []).join(','),
    HKCLAW_LITE_CONTEXT_FILES: (service.contextFiles || []).join(','),
  };
}

function resolveAgentAccessMode(service) {
  if (service.sandbox) {
    return service.sandbox;
  }
  if (service.dangerous) {
    return 'danger-full-access';
  }
  return '';
}

function stripClaudeAcpEnv(env) {
  const nextEnv = { ...(env || {}) };
  for (const key of CLAUDE_ACP_DISABLED_ENV_KEYS) {
    delete nextEnv[key];
  }
  return nextEnv;
}

function stripGeminiCliEnv(env) {
  const nextEnv = { ...(env || {}) };
  for (const key of GEMINI_CLI_DISABLED_ENV_KEYS) {
    delete nextEnv[key];
  }
  return nextEnv;
}

function resolveExecutionWorkdir(projectRoot, service, workdirOverride = null) {
  const selectedWorkdir = workdirOverride || service.workdir;
  if (!selectedWorkdir) {
    return null;
  }
  return resolveProjectPath(projectRoot, selectedWorkdir);
}

function requireExecutionWorkdir(projectRoot, service, workdirOverride = null) {
  const workdir = resolveExecutionWorkdir(projectRoot, service, workdirOverride);
  assert(workdir, 'A workdir must be provided by the channel or agent configuration.');
  return workdir;
}

function runChildProcess({
  command,
  args = [],
  cwd,
  env,
  input,
  timeoutMs,
  onStdoutLine = null,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnResolved(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutLineBuffer = '';
    let settled = false;
    let timeout = null;
    let lineTask = Promise.resolve();
    let lineError = null;

    const enqueueStdoutLine = (line) => {
      if (typeof onStdoutLine !== 'function' || !line) {
        return;
      }
      lineTask = lineTask
        .then(() => onStdoutLine(line))
        .catch((error) => {
          lineError = error;
          child.kill('SIGTERM');
        });
    };

    const flushStdoutLines = ({ flushRemainder = false } = {}) => {
      while (true) {
        const newlineIndex = stdoutLineBuffer.indexOf('\n');
        if (newlineIndex < 0) {
          break;
        }
        const line = stdoutLineBuffer.slice(0, newlineIndex).replace(/\r$/u, '').trim();
        stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
        enqueueStdoutLine(line);
      }

      if (flushRemainder) {
        const remainder = stdoutLineBuffer.trim();
        stdoutLineBuffer = '';
        enqueueStdoutLine(remainder);
      }
    };

    if (timeoutMs) {
      timeout = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutLineBuffer += text;
      flushStdoutLines();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.on('close', (code, signal) => {
      void (async () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        flushStdoutLines({ flushRemainder: true });
        await lineTask;
        if (lineError) {
          reject(new Error(toErrorMessage(lineError)));
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              [
                `${command} exited with code ${code ?? 'unknown'}`,
                signal ? `signal=${signal}` : null,
                stderr.trim() || stdout.trim() || null,
              ]
                .filter(Boolean)
                .join('\n'),
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      })();
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  }).catch((error) => {
    throw new Error(toErrorMessage(error));
  });
}

function resolvePosixShell(env) {
  const configuredShell = String(env.HKCLAW_LITE_SHELL || env.SHELL || '').trim();
  if (configuredShell) {
    return configuredShell;
  }
  if (fs.existsSync('/bin/bash')) {
    return '/bin/bash';
  }
  return '/bin/sh';
}

function normalizeAgentTurnResult(result, { captureRuntimeMetadata = false } = {}) {
  if (result && typeof result === 'object' && 'text' in result) {
    return captureRuntimeMetadata
      ? {
          text: String(result.text || ''),
          runtimeMeta: result.runtimeMeta || null,
          usage: result.usage || null,
        }
      : String(result.text || '');
  }

  return captureRuntimeMetadata
    ? {
        text: String(result || ''),
        runtimeMeta: null,
        usage: null,
      }
    : String(result || '');
}

function parseCodexExecJsonOutput(stdout) {
  const events = String(stdout || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const event = parseCodexExecJsonLine(line);
      return event ? [event] : [];
    });

  let text = '';
  let usage = null;
  let threadId = null;
  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue;
    }
    if (!threadId && typeof event.thread_id === 'string' && event.thread_id.trim()) {
      threadId = event.thread_id.trim();
    }

    const item = event.item && typeof event.item === 'object' ? event.item : null;
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      text = item.text;
    }

    const eventUsage =
      normalizeUsageSnapshot(event.usage) ||
      normalizeUsageSnapshot(item?.usage) ||
      normalizeUsageSnapshot(event.message?.usage);
    if (eventUsage) {
      usage = eventUsage;
    }
  }

  return {
    text,
    usage,
    runtimeMeta: threadId
      ? {
          runtimeBackend: 'codex-cli',
          runtimeSessionId: threadId,
        }
      : null,
  };
}

function parseCodexExecJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractCodexExecStreamEvent(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const item = event.item && typeof event.item === 'object' ? event.item : null;
  const itemType = String(item?.type || '').trim();
  const eventType = String(event.type || '').trim();

  if (itemType === 'reasoning') {
    const text = extractCodexItemText(item);
    return text
      ? {
          source: 'codex-cli',
          kind: 'thinking',
          text,
        }
      : null;
  }

  if (itemType === 'function_call' || itemType === 'tool_call') {
    const toolName =
      String(item.name || item.tool_name || item.toolName || '').trim() ||
      (itemType === 'function_call' ? 'function_call' : 'tool_call');
    const text = formatCodexToolInput(item.arguments ?? item.input ?? item.parameters);
    return {
      source: 'codex-cli',
      kind: 'tool',
      phase: eventType.endsWith('.started') ? 'start' : 'stop',
      toolName,
      toolUseId: String(item.call_id || item.id || '').trim() || null,
      text,
    };
  }

  if (itemType === 'agent_message') {
    const text = extractCodexItemText(item);
    return text
      ? {
          source: 'codex-cli',
          kind: 'text',
          text,
        }
      : null;
  }

  return null;
}

function extractCodexItemText(item) {
  if (typeof item.text === 'string') {
    return item.text;
  }
  if (typeof item.summary === 'string') {
    return item.summary;
  }
  if (Array.isArray(item.summary)) {
    return item.summary
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : typeof entry?.text === 'string'
            ? entry.text
            : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(item.content)) {
    return item.content
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : typeof entry?.text === 'string'
            ? entry.text
            : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function formatCodexToolInput(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildClaudeCliSessionSpec({ channel, role, runtimeSession }) {
  const stickyRole = Boolean(channel?.name) && ['owner', 'reviewer'].includes(role || '');
  const storedSessionId =
    runtimeSession?.runtimeBackend === 'claude-cli'
      ? String(runtimeSession.runtimeSessionId || '').trim()
      : '';

  if (!stickyRole) {
    return {
      sessionPolicy: 'ephemeral',
      newSessionId: null,
      resumeSessionId: null,
    };
  }

  if (storedSessionId) {
    return {
      sessionPolicy: 'sticky',
      newSessionId: null,
      resumeSessionId: storedSessionId,
    };
  }

  return {
    sessionPolicy: 'sticky',
    newSessionId: crypto.randomUUID(),
    resumeSessionId: null,
  };
}

function parseClaudeCliStreamJson(stdout, { fallbackSessionId = null } = {}) {
  const lines = String(stdout || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  let finalText = '';
  let sessionId = String(fallbackSessionId || '').trim() || null;
  let usage = null;

  for (const line of lines) {
    let message;
    try {
      message = parseClaudeCliStreamJsonLine(line);
    } catch (error) {
      throw new Error(toErrorMessage(error));
    }

    if (!sessionId && typeof message?.session_id === 'string' && message.session_id.trim()) {
      sessionId = message.session_id.trim();
    }

    const messageUsage = extractClaudeCliUsage(message);
    if (messageUsage) {
      usage = messageUsage;
    }

    if (message?.type !== 'result') {
      continue;
    }

    if (message.subtype === 'success') {
      finalText = String(message.result || '');
      continue;
    }

    const errors = Array.isArray(message.errors)
      ? message.errors.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    throw new Error(errors.join('\n') || 'claude execution failed.');
  }

  if (!finalText && lines.length > 0) {
    throw new Error('Claude CLI completed without a result message.');
  }

  return {
    text: trimTrailingWhitespace(finalText).trim(),
    usage,
    runtimeMeta: sessionId
      ? {
          runtimeBackend: 'claude-cli',
          runtimeSessionId: sessionId,
        }
      : null,
  };
}

function parseClaudeCliStreamJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid Claude stream-json output: ${toErrorMessage(error)}`);
  }
}

function createClaudeCliStreamState() {
  return {
    blocks: new Map(),
  };
}

function extractClaudeCliStreamEvent(message, state) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const blockIndex = Number.isInteger(message.index) ? message.index : null;
  if (message.type === 'content_block_start') {
    const contentBlock = message.content_block || null;
    if (!contentBlock || typeof contentBlock !== 'object') {
      return null;
    }
    if (blockIndex !== null) {
      state.blocks.set(blockIndex, {
        type: String(contentBlock.type || '').trim() || null,
        id: String(contentBlock.id || '').trim() || null,
        name: String(contentBlock.name || '').trim() || null,
      });
    }
    if (contentBlock.type === 'tool_use') {
      const initialInput = formatClaudeToolInput(contentBlock.input);
      return {
        source: 'claude-cli',
        kind: 'tool',
        phase: 'start',
        toolName: String(contentBlock.name || '').trim() || null,
        toolUseId: String(contentBlock.id || '').trim() || null,
        text: initialInput,
      };
    }
    return null;
  }

  if (message.type === 'content_block_delta') {
    const delta = message.delta || null;
    if (!delta || typeof delta !== 'object') {
      return null;
    }
    if (delta.type === 'thinking_delta') {
      const text = String(delta.thinking || '');
      return text
        ? {
            source: 'claude-cli',
            kind: 'thinking',
            text,
          }
        : null;
    }
    if (delta.type === 'text_delta') {
      const text = String(delta.text || '');
      return text
        ? {
            source: 'claude-cli',
            kind: 'text',
            text,
          }
        : null;
    }
    if (delta.type === 'input_json_delta') {
      const block = blockIndex !== null ? state.blocks.get(blockIndex) : null;
      const text = String(delta.partial_json || '');
      if (!block || block.type !== 'tool_use' || !text) {
        return null;
      }
      return {
        source: 'claude-cli',
        kind: 'tool',
        phase: 'input',
        toolName: block.name,
        toolUseId: block.id,
        text,
      };
    }
    return null;
  }

  if (message.type === 'content_block_stop') {
    const block = blockIndex !== null ? state.blocks.get(blockIndex) : null;
    if (blockIndex !== null) {
      state.blocks.delete(blockIndex);
    }
    if (block?.type === 'tool_use') {
      return {
        source: 'claude-cli',
        kind: 'tool',
        phase: 'stop',
        toolName: block.name,
        toolUseId: block.id,
        text: '',
      };
    }
  }

  return null;
}

function formatClaudeToolInput(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractClaudeCliUsage(message) {
  const currentUsage =
    normalizeUsageSnapshot(message?.usage) ||
    normalizeUsageSnapshot(message?.message?.usage) ||
    normalizeUsageSnapshot(message?.context_window?.current_usage);
  if (currentUsage) {
    return currentUsage;
  }

  const quotaUsage = normalizeUsageSnapshot({
    inputTokens:
      message?._meta?.quota?.token_count?.input_tokens ??
      message?.quota?.token_count?.input_tokens,
    outputTokens:
      message?._meta?.quota?.token_count?.output_tokens ??
      message?.quota?.token_count?.output_tokens,
  });
  if (quotaUsage) {
    return quotaUsage;
  }

  return null;
}

function extractGeminiCliUsage(parsed) {
  return (
    normalizeUsageSnapshot({
      inputTokens:
        parsed?._meta?.quota?.token_count?.input_tokens ??
        parsed?.quota?.token_count?.input_tokens ??
        parsed?.stats?.token_count?.input_tokens,
      outputTokens:
        parsed?._meta?.quota?.token_count?.output_tokens ??
        parsed?.quota?.token_count?.output_tokens ??
        parsed?.stats?.token_count?.output_tokens,
      totalTokens:
        parsed?._meta?.quota?.total_tokens ??
        parsed?.quota?.total_tokens ??
        parsed?.stats?.total_tokens,
    }) ||
    normalizeUsageSnapshot({
      inputTokens:
        parsed?.usageMetadata?.promptTokenCount ??
        parsed?.responseJson?.usageMetadata?.promptTokenCount,
      outputTokens:
        parsed?.usageMetadata?.candidatesTokenCount ??
        parsed?.responseJson?.usageMetadata?.candidatesTokenCount,
      totalTokens:
        parsed?.usageMetadata?.totalTokenCount ??
        parsed?.responseJson?.usageMetadata?.totalTokenCount,
    })
  );
}

function normalizeUsageSnapshot(input) {
  const inputTokens = normalizeUsageNumber(
    input?.inputTokens ?? input?.input_tokens ?? input?.promptTokenCount,
  );
  const outputTokens = normalizeUsageNumber(
    input?.outputTokens ?? input?.output_tokens ?? input?.candidatesTokenCount,
  );
  const totalTokens = normalizeUsageNumber(
    input?.totalTokens ?? input?.total_tokens ?? input?.totalTokenCount,
  );
  const cacheCreationInputTokens = normalizeUsageNumber(
    input?.cacheCreationInputTokens ??
      input?.cache_creation_input_tokens ??
      input?.cacheCreationInputTokenCount,
  );
  const cacheReadInputTokens = normalizeUsageNumber(
    input?.cacheReadInputTokens ??
      input?.cache_read_input_tokens ??
      input?.cached_input_tokens ??
      input?.cacheReadInputTokenCount,
  );

  if (
    inputTokens === null &&
    outputTokens === null &&
    totalTokens === null &&
    cacheCreationInputTokens === null &&
    cacheReadInputTokens === null
  ) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens:
      totalTokens ??
      (inputTokens !== null || outputTokens !== null
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : null),
    cacheCreationInputTokens: cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: cacheReadInputTokens ?? 0,
  };
}

function normalizeUsageNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return Math.round(numeric);
}

export function resolveManagedAgentCli(agentType, env = process.env) {
  const spec = MANAGED_AGENT_RUNTIMES[agentType];
  if (!spec) {
    return null;
  }

  if (agentType === 'codex') {
    const explicit = resolveExplicitCodexCli(env);
    if (explicit) {
      return explicit;
    }
  }
  if (agentType === 'gemini-cli') {
    const explicit = resolveExplicitGeminiCli(env);
    if (explicit) {
      return explicit;
    }
  }
  if (agentType === 'claude-code') {
    const explicit = resolveExplicitClaudeCli(env);
    if (explicit) {
      return explicit;
    }
  }

  const resolvedCommand = resolveExecutable(spec.binaryName, {
    pathValue: env.PATH || process.env.PATH || '',
    pathext: env.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
  });
  if (!resolvedCommand) {
    return null;
  }

  return {
    source: 'system',
    command: resolvedCommand,
    argsPrefix: [],
    packageName: spec.packageName,
    packageVersion: '',
    detail: `${spec.binaryName} (${resolvedCommand})`,
    envPatch: {},
  };
}

function requireManagedAgentCli(agentType, env = process.env) {
  const spec = MANAGED_AGENT_RUNTIMES[agentType];
  const cli = resolveManagedAgentCli(agentType, env);
  assert(
    cli,
    `${spec.binaryName} CLI not found on PATH. Install it first (e.g. \`npm install -g ${spec.packageName}\`) or set HKCLAW_LITE_${spec.binaryName.toUpperCase()}_CLI to an absolute path.`,
  );
  return cli;
}

export function resolveClaudeCli(env = process.env) {
  return resolveManagedAgentCli('claude-code', env);
}

function requireClaudeCli(env = process.env) {
  return requireManagedAgentCli('claude-code', env);
}

function resolveExplicitCliFromEnv(envValue, env, sourceLabel) {
  const configuredCommand = String(envValue || '').trim();
  if (!configuredCommand) {
    return null;
  }

  const resolvedCommand =
    resolveExecutable(configuredCommand, {
      pathValue: env.PATH || process.env.PATH || '',
      pathext: env.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    }) || '';
  if (!resolvedCommand) {
    return null;
  }

  return {
    source: 'external',
    command: resolvedCommand,
    argsPrefix: [],
    packageName: '',
    packageVersion: '',
    detail: `${sourceLabel} (${resolvedCommand})`,
    envPatch: {},
  };
}

function resolveExplicitClaudeCli(env = process.env) {
  return resolveExplicitCliFromEnv(env[CLAUDE_EXTERNAL_CLI_ENV], env, 'external Claude CLI');
}

function resolveExplicitCodexCli(env = process.env) {
  return resolveExplicitCliFromEnv(env[CODEX_EXTERNAL_CLI_ENV], env, 'external Codex CLI');
}

function resolveExplicitGeminiCli(env = process.env) {
  return resolveExplicitCliFromEnv(env[GEMINI_EXTERNAL_CLI_ENV], env, 'external Gemini CLI');
}

function buildManagedAgentRuntimeStatus(agentType, workdir) {
  const runtime = resolveManagedAgentCli(agentType, process.env);
  const spec = MANAGED_AGENT_RUNTIMES[agentType];
  return {
    ready: Boolean(runtime),
    source: runtime?.source || null,
    packageName: runtime?.packageName || spec.packageName,
    packageVersion: runtime?.packageVersion || '',
    detail:
      runtime?.detail ||
      `${spec.binaryName} CLI not found on PATH (install ${spec.packageName})`,
    workdir,
  };
}

function spawnResolved(command, args, options) {
  const env = options?.env || process.env;
  const resolvedCommand =
    resolveExecutable(command, {
      pathValue: env.PATH || process.env.PATH || '',
      pathext: env.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    }) || command;

  return spawn(resolvedCommand, args, {
    ...options,
    shell: shouldUseWindowsCommandShim(resolvedCommand),
  });
}

function shouldUseWindowsCommandShim(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command);
}

function applyEnvPatch(baseEnv, envPatch) {
  if (!envPatch) {
    return baseEnv;
  }
  return {
    ...baseEnv,
    ...envPatch,
  };
}

export async function loadClaudeAgentSdk(env = process.env) {
  const spec = MANAGED_AGENT_RUNTIMES['claude-code'];
  const cli = resolveManagedAgentCli('claude-code', env);
  assert(
    cli,
    `${spec.binaryName} CLI not found on PATH. Install it first (e.g. \`npm install -g ${spec.packageName}\`) or set HKCLAW_LITE_CLAUDE_CLI to an absolute path.`,
  );

  const importPath = resolveClaudeAgentSdkImportPath(cli.command);
  assert(
    importPath,
    `${spec.packageName} is not reachable from the resolved Claude CLI path.`,
  );

  const module = await import(importPath);
  assert(
    typeof module.query === 'function',
    `${spec.packageName} is missing the query() export.`,
  );
  return module;
}

function resolveClaudeAgentSdkImportPath(claudeCommand) {
  let realCommand = claudeCommand;
  try {
    realCommand = fs.realpathSync(claudeCommand);
  } catch {
    // ignore — fall through with the original path
  }

  const candidates = [];
  let directory = path.dirname(realCommand);
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(path.join(directory, 'package.json'));
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  for (const packageJsonPath of candidates) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson?.name !== '@anthropic-ai/claude-agent-sdk') {
        continue;
      }
      const relativeModulePath = resolvePackageModulePath(packageJson);
      if (!relativeModulePath) {
        continue;
      }
      const modulePath = path.resolve(path.dirname(packageJsonPath), relativeModulePath);
      if (!fs.existsSync(modulePath)) {
        continue;
      }
      return new URL(`file://${modulePath}`).href;
    } catch {
      continue;
    }
  }
  return null;
}

function resolvePackageModulePath(packageJson) {
  const exportTarget = packageJson?.exports?.['.'] ?? packageJson?.exports;
  return (
    resolvePackageTargetPath(exportTarget) ||
    (typeof packageJson?.module === 'string' ? packageJson.module : null) ||
    (typeof packageJson?.main === 'string' ? packageJson.main : null)
  );
}

function resolvePackageTargetPath(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (typeof value.default === 'string') {
    return value.default;
  }
  if (typeof value.import === 'string') {
    return value.import;
  }
  if (typeof value.require === 'string') {
    return value.require;
  }
  for (const entry of Object.values(value)) {
    const resolved = resolvePackageTargetPath(entry);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}
