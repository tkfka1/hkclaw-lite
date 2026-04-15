import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_CLAUDE_PERMISSION_MODE,
  DEFAULT_CODEX_SANDBOX,
  DEFAULT_LOCAL_LLM_BASE_URL,
} from './constants.js';
import {
  loadConfig,
  resolveLocalLlmConnectionConfig,
  resolveProjectPath,
} from './store.js';
import {
  assert,
  resolveExecutable,
  resolveBundledNodeCli,
  toErrorMessage,
  trimTrailingWhitespace,
} from './utils.js';

const moduleRequire = createRequire(import.meta.url);

const MANAGED_AGENT_RUNTIMES = {
  codex: {
    kind: 'cli',
    binaryName: 'codex',
    packageName: '@openai/codex',
    packageJsonEnv: 'HKCLAW_LITE_CODEX_CLI_PACKAGE_JSON',
  },
  'claude-code': {
    kind: 'sdk',
    binaryName: 'claude',
    packageName: '@anthropic-ai/claude-agent-sdk',
    packageJsonEnv: 'HKCLAW_LITE_CLAUDE_AGENT_SDK_PACKAGE_JSON',
  },
  'gemini-cli': {
    kind: 'cli',
    binaryName: 'gemini',
    packageName: '@google/gemini-cli',
    packageJsonEnv: 'HKCLAW_LITE_GEMINI_CLI_PACKAGE_JSON',
  },
};

const CODEX_PLATFORM_BUNDLES = {
  'linux:x64': {
    packageName: '@openai/codex-linux-x64',
    targetTriple: 'x86_64-unknown-linux-musl',
  },
  'linux:arm64': {
    packageName: '@openai/codex-linux-arm64',
    targetTriple: 'aarch64-unknown-linux-musl',
  },
  'darwin:x64': {
    packageName: '@openai/codex-darwin-x64',
    targetTriple: 'x86_64-apple-darwin',
  },
  'darwin:arm64': {
    packageName: '@openai/codex-darwin-arm64',
    targetTriple: 'aarch64-apple-darwin',
  },
  'win32:x64': {
    packageName: '@openai/codex-win32-x64',
    targetTriple: 'x86_64-pc-windows-msvc',
  },
  'win32:arm64': {
    packageName: '@openai/codex-win32-arm64',
    targetTriple: 'aarch64-pc-windows-msvc',
  },
};
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
const GEMINI_DEFAULT_SANDBOX_POLICY_TOML = `# hkclaw-lite fallback for missing bundled Gemini sandbox policy
[modes.plan]
network = false
readonly = true
approvedTools = []
allowOverrides = false

[modes.default]
network = false
readonly = true
approvedTools = []
allowOverrides = true

[modes.accepting_edits]
network = false
readonly = false
approvedTools = ["sed", "grep", "awk", "perl", "cat", "echo"]
allowOverrides = true
`;

export async function runAgentTurn({
  projectRoot,
  agent,
  prompt,
  rawPrompt,
  workdir,
  sharedEnv = {},
  channel = null,
  role = null,
  runtimeSession = null,
  captureRuntimeMetadata = false,
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
        sharedEnv,
      });
      break;
    case 'claude-code':
      result = await runClaude({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        sharedEnv,
        channel,
        role,
        runtimeSession,
      });
      break;
    case 'gemini-cli':
      result = await runGeminiCli({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        sharedEnv,
      });
      break;
    case 'local-llm':
      result = await runLocalLlm({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        sharedEnv,
      });
      break;
    case 'command':
      result = await runCommand({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        sharedEnv,
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
  sharedEnv,
}) {
  const cli = requireManagedAgentCli('codex');
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
      sharedEnv,
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
    });
    const finalText = fs.existsSync(lastMessageFile)
      ? fs.readFileSync(lastMessageFile, 'utf8')
      : result.stdout;
    return trimTrailingWhitespace(finalText).trim();
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
  sharedEnv,
  channel,
  role,
  runtimeSession,
}) {
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const env = stripClaudeAcpEnv(buildChildEnv({
    projectRoot,
    workdir: executionWorkdir,
    service,
    rawPrompt,
    fullPrompt: prompt,
    sharedEnv,
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

  const result = await runChildProcess({
    command: cli.command,
    args,
    cwd: executionWorkdir,
    env: applyEnvPatch(env, cli.envPatch),
    input: prompt,
    timeoutMs: service.timeoutMs,
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
  sharedEnv,
}) {
  const cli = requireManagedAgentCli('gemini-cli');
  ensureGeminiCliRuntimeFiles(cli);
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const args = [...cli.argsPrefix, '-p', prompt, '--output-format', 'json'];
  if (service.model) {
    args.push('-m', service.model);
  }

  const geminiEnv = stripGeminiCliEnv(buildChildEnv({
    projectRoot,
    workdir: executionWorkdir,
    service,
    rawPrompt,
    fullPrompt: prompt,
    sharedEnv,
  }));
  geminiEnv.GOOGLE_GENAI_USE_GCA = 'true';

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
}

async function runLocalLlm({
  projectRoot,
  service,
  prompt,
  rawPrompt,
  workdir,
  sharedEnv,
}) {
  void rawPrompt;
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const config = loadConfig(projectRoot);
  const resolvedConnection = resolveLocalLlmConnectionConfig(config, service, {
    sharedEnv,
    processEnv: process.env,
  });
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
  sharedEnv,
}) {
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const env = buildChildEnv({
    projectRoot,
    workdir: executionWorkdir,
    service,
    rawPrompt,
    fullPrompt: prompt,
    sharedEnv,
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
  sharedEnv,
}) {
  return {
    ...process.env,
    ...sharedEnv,
    ...service.env,
    HKCLAW_LITE_PROJECT_ROOT: projectRoot,
    HKCLAW_LITE_AGENT_NAME: service.name,
    HKCLAW_LITE_SERVICE_NAME: service.name,
    HKCLAW_LITE_AGENT: service.agent,
    HKCLAW_LITE_WORKDIR: workdir,
    HKCLAW_LITE_RAW_PROMPT: rawPrompt,
    HKCLAW_LITE_FULL_PROMPT: fullPrompt,
    HKCLAW_LITE_SKILLS: (service.skills || []).join(','),
    HKCLAW_LITE_CONTEXT_FILES: (service.contextFiles || []).join(','),
  };
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
}) {
  return new Promise((resolve, reject) => {
    const child = spawnResolved(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout = null;

    if (timeoutMs) {
      timeout = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
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
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
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
      message = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid Claude stream-json output: ${toErrorMessage(error)}`);
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
  if (!spec || spec.kind !== 'cli') {
    return null;
  }

  if (agentType === 'codex') {
    const nativeBundle = resolveCodexNativeBundle(spec, env);
    if (nativeBundle) {
      return nativeBundle;
    }
  }

  const packageJsonOverride = String(env[spec.packageJsonEnv] || '').trim();
  const bundled = resolveBundledNodeCli(spec.packageName, spec.binaryName, {
    resolvePackageJson: packageJsonOverride
      ? () => packageJsonOverride
      : undefined,
  });
  if (!bundled) {
    return null;
  }

  return {
    source: 'bundled',
    command: process.execPath,
    argsPrefix: [bundled.scriptPath],
    scriptPath: bundled.scriptPath,
    detail: `${spec.packageName} (${bundled.scriptPath})`,
    envPatch: {},
  };
}

function ensureGeminiCliRuntimeFiles(cli) {
  const scriptPath = String(cli?.scriptPath || cli?.argsPrefix?.[0] || '').trim();
  if (!scriptPath) {
    return;
  }

  const bundleDir = path.dirname(scriptPath);
  const policyPath = path.join(bundleDir, 'policies', 'sandbox-default.toml');
  if (fs.existsSync(policyPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, GEMINI_DEFAULT_SANDBOX_POLICY_TOML, 'utf8');
}

function requireManagedAgentCli(agentType, env = process.env) {
  const spec = MANAGED_AGENT_RUNTIMES[agentType];
  const cli = resolveManagedAgentCli(agentType, env);
  assert(
    cli,
    `${spec.binaryName} is unavailable. Bundled dependency ${spec.packageName} is required; reinstall hkclaw-lite without omitting optional dependencies.`,
  );
  return cli;
}

function resolveClaudeCli(env = process.env) {
  const spec = MANAGED_AGENT_RUNTIMES['claude-code'];
  const packageJsonOverride = String(env[spec.packageJsonEnv] || '').trim();
  let packageJsonPath = packageJsonOverride;
  if (!packageJsonPath) {
    try {
      packageJsonPath = moduleRequire.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    } catch {
      try {
        const entryPath = moduleRequire.resolve('@anthropic-ai/claude-agent-sdk');
        const candidate = path.join(path.dirname(entryPath), 'package.json');
        if (!fs.existsSync(candidate)) {
          return null;
        }
        packageJsonPath = candidate;
      } catch {
        return null;
      }
    }
  }

  const cliPath = path.resolve(path.dirname(packageJsonPath), 'cli.js');
  if (!fs.existsSync(cliPath)) {
    return null;
  }

  return {
    source: 'bundled',
    command: process.execPath,
    argsPrefix: [cliPath],
    detail: `@anthropic-ai/claude-agent-sdk (${cliPath})`,
    envPatch: {},
  };
}

function requireClaudeCli(env = process.env) {
  const spec = MANAGED_AGENT_RUNTIMES['claude-code'];
  const cli = resolveClaudeCli(env);
  assert(
    cli,
    `${spec.binaryName} is unavailable. Bundled dependency ${spec.packageName} is required; reinstall hkclaw-lite without omitting optional dependencies.`,
  );
  return cli;
}

function buildManagedAgentRuntimeStatus(agentType, workdir) {
  const runtime = resolveManagedAgentRuntime(agentType);
  const spec = MANAGED_AGENT_RUNTIMES[agentType];
  return {
    ready: Boolean(runtime),
    detail:
      runtime?.detail ||
      `bundled dependency ${spec.packageName} is not installed`,
    workdir,
  };
}

function resolveManagedAgentRuntime(agentType, env = process.env) {
  if (agentType === 'claude-code') {
    return resolveClaudeAgentSdk(env);
  }
  return resolveManagedAgentCli(agentType, env);
}

function resolveClaudeAgentSdk(env = process.env) {
  const spec = MANAGED_AGENT_RUNTIMES['claude-code'];
  const packageJsonOverride = String(env[spec.packageJsonEnv] || '').trim();
  if (packageJsonOverride) {
    return resolveClaudeAgentSdkFromPackageJson(packageJsonOverride);
  }

  try {
    const modulePath = moduleRequire.resolve(spec.packageName);
    return {
      source: 'bundled',
      importPath: pathToFileURL(modulePath).href,
      detail: `${spec.packageName} (${modulePath})`,
    };
  } catch {
    return null;
  }
}

export async function loadClaudeAgentSdk(env = process.env) {
  const spec = MANAGED_AGENT_RUNTIMES['claude-code'];
  const runtime = resolveClaudeAgentSdk(env);
  assert(
    runtime,
    `${spec.binaryName} is unavailable. Bundled dependency ${spec.packageName} is required; reinstall hkclaw-lite without omitting optional dependencies.`,
  );

  const module = await import(runtime.importPath);
  assert(
    typeof module.query === 'function',
    `${spec.packageName} is missing the query() export.`,
  );
  return module;
}

function resolveClaudeAgentSdkFromPackageJson(packageJsonPath) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const relativeModulePath = resolvePackageModulePath(packageJson);
    if (!relativeModulePath) {
      return null;
    }

    const modulePath = path.resolve(path.dirname(packageJsonPath), relativeModulePath);
    if (!fs.statSync(modulePath).isFile()) {
      return null;
    }

    return {
      source: 'bundled',
      importPath: pathToFileURL(modulePath).href,
      detail: `${packageJson.name || '@anthropic-ai/claude-agent-sdk'} (${modulePath})`,
    };
  } catch {
    return null;
  }
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

function resolveCodexNativeBundle(spec, env = process.env) {
  const bundleSpec = CODEX_PLATFORM_BUNDLES[`${process.platform}:${process.arch}`];
  if (!bundleSpec) {
    return null;
  }

  const codexPackageJsonPath = resolveManagedPackageJson(
    spec.packageName,
    env[spec.packageJsonEnv],
  );
  if (!codexPackageJsonPath) {
    return null;
  }

  const codexPackageDir = path.dirname(codexPackageJsonPath);
  const bundleDirCandidates = [
    path.join(path.dirname(codexPackageDir), bundleSpec.packageName.split('/')[1]),
    codexPackageDir,
  ];
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';

  for (const bundleDir of bundleDirCandidates) {
    const vendorRoot = path.join(bundleDir, 'vendor');
    const binaryPath = path.join(
      vendorRoot,
      bundleSpec.targetTriple,
      'codex',
      executableName,
    );
    if (!isRegularFile(binaryPath)) {
      continue;
    }

    const rgDir = path.join(vendorRoot, bundleSpec.targetTriple, 'path');
    return {
      source: 'bundled',
      command: binaryPath,
      argsPrefix: [],
      detail: `${bundleSpec.packageName} (${binaryPath})`,
      envPatch: {
        CODEX_MANAGED_BY_NPM: '1',
        PATH: prependPathSegment(env.PATH || process.env.PATH || '', rgDir),
      },
    };
  }

  return null;
}

function resolveManagedPackageJson(packageName, overridePath) {
  const candidate = String(overridePath || '').trim();
  if (candidate) {
    return isRegularFile(candidate) ? candidate : null;
  }

  try {
    return moduleRequire.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }
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

function prependPathSegment(pathValue, segment) {
  if (!segment || !isDirectory(segment)) {
    return pathValue;
  }

  const entries = String(pathValue || '')
    .split(path.delimiter)
    .filter(Boolean);
  if (entries.includes(segment)) {
    return entries.join(path.delimiter);
  }
  return [segment, ...entries].join(path.delimiter);
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}
