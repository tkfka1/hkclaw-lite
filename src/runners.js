import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  DEFAULT_CLAUDE_PERMISSION_MODE,
  DEFAULT_CODEX_SANDBOX,
  DEFAULT_LOCAL_LLM_BASE_URL,
} from './constants.js';
import { resolveProjectPath } from './store.js';
import {
  assert,
  resolveExecutable,
  resolvePreferredCli,
  toErrorMessage,
  trimTrailingWhitespace,
} from './utils.js';

const MANAGED_AGENT_CLIS = {
  codex: {
    binaryName: 'codex',
    packageName: '@openai/codex',
  },
  'claude-code': {
    binaryName: 'claude',
    packageName: '@anthropic-ai/claude-code',
  },
  'gemini-cli': {
    binaryName: 'gemini',
    packageName: '@google/gemini-cli',
  },
};

export async function runAgentTurn({
  projectRoot,
  agent,
  prompt,
  rawPrompt,
  workdir,
  sharedEnv = {},
}) {
  switch (agent.agent) {
    case 'codex':
      return runCodex({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        sharedEnv,
      });
    case 'claude-code':
      return runClaude({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        sharedEnv,
      });
    case 'gemini-cli':
      return runGeminiCli({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        sharedEnv,
      });
    case 'local-llm':
      return runLocalLlm({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        sharedEnv,
      });
    case 'command':
      return runCommand({
        projectRoot,
        service: agent,
        prompt,
        rawPrompt,
        workdir,
        sharedEnv,
      });
    default:
      throw new Error(`Unsupported agent "${agent.agent}".`);
  }
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
      return {
        ready: true,
        detail: agent.baseUrl || DEFAULT_LOCAL_LLM_BASE_URL,
        workdir,
      };
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

  const env = buildChildEnv({
    projectRoot,
    workdir: executionWorkdir,
    service,
    rawPrompt,
    fullPrompt: prompt,
    sharedEnv,
  });
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
}) {
  const cli = requireManagedAgentCli('claude-code');
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const args = [...cli.argsPrefix, '-p', '--output-format', 'text'];

  if (service.model) {
    args.push('--model', service.model);
  }
  if (service.effort) {
    args.push('--effort', service.effort);
  }
  if (service.dangerous) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push(
      '--permission-mode',
      service.permissionMode || DEFAULT_CLAUDE_PERMISSION_MODE,
    );
  }
  args.push(prompt);

  const result = await runChildProcess({
    command: cli.command,
    args,
    cwd: executionWorkdir,
    env: buildChildEnv({
      projectRoot,
      workdir: executionWorkdir,
      service,
      rawPrompt,
      fullPrompt: prompt,
      sharedEnv,
    }),
    timeoutMs: service.timeoutMs,
  });
  return trimTrailingWhitespace(result.stdout).trim();
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
  const executionWorkdir = requireExecutionWorkdir(projectRoot, service, workdir);
  const args = [...cli.argsPrefix, '-p', prompt, '--output-format', 'json'];
  if (service.model) {
    args.push('-m', service.model);
  }

  const result = await runChildProcess({
    command: cli.command,
    args,
    cwd: executionWorkdir,
    env: buildChildEnv({
      projectRoot,
      workdir: executionWorkdir,
      service,
      rawPrompt,
      fullPrompt: prompt,
      sharedEnv,
    }),
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
    return trimTrailingWhitespace(text || result.stdout).trim();
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
  const effectiveEnv = {
    ...sharedEnv,
    ...service.env,
  };
  const baseUrl = (service.baseUrl || DEFAULT_LOCAL_LLM_BASE_URL).replace(/\/$/, '');
  const headers = {
    'content-type': 'application/json',
  };
  if (effectiveEnv.LOCAL_LLM_API_KEY) {
    headers.authorization = `Bearer ${effectiveEnv.LOCAL_LLM_API_KEY}`;
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
  return trimTrailingWhitespace(content).trim();
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

export function resolveManagedAgentCli(agentType, env = process.env) {
  const spec = MANAGED_AGENT_CLIS[agentType];
  if (!spec) {
    return null;
  }

  return (
    resolvePreferredCli(spec.binaryName, {
      packageName: spec.packageName,
      pathValue: env.PATH || process.env.PATH || '',
      pathext: env.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    }) || null
  );
}

function requireManagedAgentCli(agentType, env = process.env) {
  const spec = MANAGED_AGENT_CLIS[agentType];
  const cli = resolveManagedAgentCli(agentType, env);
  assert(
    cli,
    `${spec.binaryName} is unavailable. Install bundled dependency ${spec.packageName} or place ${spec.binaryName} on PATH.`,
  );
  return cli;
}

function buildManagedAgentRuntimeStatus(agentType, workdir) {
  const cli = resolveManagedAgentCli(agentType);
  const spec = MANAGED_AGENT_CLIS[agentType];
  return {
    ready: Boolean(cli),
    detail:
      cli?.detail ||
      `${spec.packageName} not installed and ${spec.binaryName} not found in PATH`,
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
