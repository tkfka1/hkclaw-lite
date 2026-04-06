import { sleep, toErrorMessage } from './utils.js';

const DEFAULT_GITHUB_BASE_URL = 'https://api.github.com';
const DEFAULT_GITLAB_BASE_URL = 'https://gitlab.com';
export const DEFAULT_CI_WATCH_INTERVAL_MS = 15_000;
export const DEFAULT_CI_WATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CI_REQUEST_TIMEOUT_MS = 30_000;

function normalizeBaseUrl(value, fallbackValue) {
  return (value || fallbackValue).replace(/\/+$/u, '');
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function pickGitHubToken(explicitToken) {
  return (
    explicitToken ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_PAT ||
    ''
  );
}

function pickGitLabToken(explicitToken) {
  return (
    explicitToken ||
    process.env.GITLAB_TOKEN ||
    process.env.GITLAB_PAT ||
    process.env.GITLAB_PRIVATE_TOKEN ||
    process.env.CI_JOB_TOKEN ||
    ''
  );
}

async function fetchJson(url, headers, requestTimeoutMs = DEFAULT_CI_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, requestTimeoutMs);

  let response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`API request timed out after ${requestTimeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();

  if (!response.ok) {
    const detail = text.trim() || `HTTP ${response.status}`;
    throw new Error(`API request failed: ${detail}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API request failed: invalid JSON from ${url}`);
  }
}

function formatGitHubConclusion(conclusion) {
  switch (conclusion) {
    case 'success':
      return '성공';
    case 'failure':
    case 'startup_failure':
      return '실패';
    case 'cancelled':
      return '취소됨';
    case 'timed_out':
      return '시간 초과';
    case 'action_required':
      return '조치 필요';
    case 'neutral':
      return '중립';
    case 'skipped':
      return '건너뜀';
    case 'stale':
      return '오래됨';
    default:
      return conclusion || '완료';
  }
}

function formatGitLabStatus(status) {
  switch (status) {
    case 'success':
      return '성공';
    case 'failed':
      return '실패';
    case 'canceled':
    case 'cancelled':
      return '취소됨';
    case 'skipped':
      return '건너뜀';
    case 'manual':
      return '수동 대기';
    default:
      return status || '완료';
  }
}

function isGitLabTerminalStatus(status) {
  return [
    'success',
    'failed',
    'canceled',
    'cancelled',
    'skipped',
    'manual',
  ].includes(status || '');
}

async function fetchGitHubJson(baseUrl, apiPath, token, requestTimeoutMs) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hkclaw-lite',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetchJson(`${baseUrl}${apiPath}`, headers, requestTimeoutMs);
}

async function fetchGitLabJson(baseUrl, apiPath, token, requestTimeoutMs) {
  const headers = {
    Accept: 'application/json',
  };
  if (token) {
    if (process.env.CI_JOB_TOKEN && token === process.env.CI_JOB_TOKEN) {
      headers['JOB-TOKEN'] = token;
    } else {
      headers['PRIVATE-TOKEN'] = token;
    }
  }
  return fetchJson(`${baseUrl}/api/v4${apiPath}`, headers, requestTimeoutMs);
}

async function fetchFailedGitHubJobs(baseUrl, repo, runId, token, requestTimeoutMs) {
  const payload = await fetchGitHubJson(
    baseUrl,
    `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    token,
    requestTimeoutMs,
  );
  return (payload.jobs || [])
    .filter((job) =>
      ['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(
        job.conclusion,
      ),
    )
    .map((job) => String(job.name || '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

async function fetchFailedGitLabJobs(
  baseUrl,
  project,
  pipelineId,
  token,
  requestTimeoutMs,
) {
  const payload = await fetchGitLabJson(
    baseUrl,
    `/projects/${encodeURIComponent(project)}/pipelines/${pipelineId}/jobs?per_page=100`,
    token,
    requestTimeoutMs,
  );
  return payload
    .filter((job) => ['failed', 'canceled', 'cancelled'].includes(job.status || ''))
    .map((job) => String(job.name || '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

export async function checkGitHubActionsRun(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl, DEFAULT_GITHUB_BASE_URL);
  const token = pickGitHubToken(options.token);
  const requestTimeoutMs =
    options.requestTimeoutMs || DEFAULT_CI_REQUEST_TIMEOUT_MS;
  const run = await fetchGitHubJson(
    baseUrl,
    `/repos/${options.repo}/actions/runs/${options.runId}`,
    token,
    requestTimeoutMs,
  );
  const status = run.status || 'unknown';

  if (status !== 'completed') {
    return {
      terminal: false,
      resultSummary: `GitHub Actions run ${options.runId} is ${status}`,
    };
  }

  let failedJobs = [];
  try {
    failedJobs = await fetchFailedGitHubJobs(
      baseUrl,
      options.repo,
      options.runId,
      token,
      requestTimeoutMs,
    );
  } catch {
    failedJobs = [];
  }

  const target = options.target || `GitHub Actions run ${options.runId}`;
  const conclusionLabel = formatGitHubConclusion(run.conclusion);
  const lines = [
    `CI 완료: ${target}`,
    `판정: ${conclusionLabel}`,
    `- 저장소: ${options.repo}`,
  ];

  if (run.name) {
    lines.push(`- 워크플로: ${run.name}`);
  }
  if (run.head_branch) {
    lines.push(`- 브랜치: ${run.head_branch}`);
  }
  if (failedJobs.length > 0) {
    lines.push(`- 실패 job: ${failedJobs.join(', ')}`);
  }
  if (run.html_url) {
    lines.push(`- 링크: ${run.html_url}`);
  }

  return {
    terminal: true,
    resultSummary: `${conclusionLabel}: ${options.repo} run ${options.runId}`,
    completionMessage: lines.join('\n'),
  };
}

export async function checkGitLabCiStatus(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl, DEFAULT_GITLAB_BASE_URL);
  const token = pickGitLabToken(options.token);
  const requestTimeoutMs =
    options.requestTimeoutMs || DEFAULT_CI_REQUEST_TIMEOUT_MS;

  if (options.jobId) {
    const job = await fetchGitLabJson(
      baseUrl,
      `/projects/${encodeURIComponent(options.project)}/jobs/${options.jobId}`,
      token,
      requestTimeoutMs,
    );
    const status = job.status || 'unknown';

    if (!isGitLabTerminalStatus(status)) {
      return {
        terminal: false,
        resultSummary: `GitLab job ${options.jobId} is ${status}`,
      };
    }

    const target = options.target || `GitLab job ${options.jobId}`;
    const lines = [
      `CI 완료: ${target}`,
      `판정: ${formatGitLabStatus(status)}`,
      `- 프로젝트: ${options.project}`,
    ];

    if (job.name) {
      lines.push(`- Job: ${job.name}`);
    }
    if (job.stage) {
      lines.push(`- Stage: ${job.stage}`);
    }
    if (job.ref) {
      lines.push(`- 브랜치: ${job.ref}`);
    }
    if (job.web_url) {
      lines.push(`- 링크: ${job.web_url}`);
    }

    return {
      terminal: true,
      resultSummary: `${formatGitLabStatus(status)}: ${options.project} job ${options.jobId}`,
      completionMessage: lines.join('\n'),
    };
  }

  const pipeline = await fetchGitLabJson(
    baseUrl,
    `/projects/${encodeURIComponent(options.project)}/pipelines/${options.pipelineId}`,
    token,
    requestTimeoutMs,
  );
  const status = pipeline.status || 'unknown';

  if (!isGitLabTerminalStatus(status)) {
    return {
      terminal: false,
      resultSummary: `GitLab pipeline ${options.pipelineId} is ${status}`,
    };
  }

  let failedJobs = [];
  try {
    failedJobs = await fetchFailedGitLabJobs(
      baseUrl,
      options.project,
      options.pipelineId,
      token,
      requestTimeoutMs,
    );
  } catch {
    failedJobs = [];
  }

  const target = options.target || `GitLab pipeline ${options.pipelineId}`;
  const lines = [
    `CI 완료: ${target}`,
    `판정: ${formatGitLabStatus(status)}`,
    `- 프로젝트: ${options.project}`,
  ];

  if (pipeline.name) {
    lines.push(`- 파이프라인: ${pipeline.name}`);
  }
  if (pipeline.ref) {
    lines.push(`- 브랜치: ${pipeline.ref}`);
  }
  if (failedJobs.length > 0) {
    lines.push(`- 실패 job: ${failedJobs.join(', ')}`);
  }
  if (pipeline.web_url) {
    lines.push(`- 링크: ${pipeline.web_url}`);
  }

  return {
    terminal: true,
    resultSummary: `${formatGitLabStatus(status)}: ${options.project} pipeline ${options.pipelineId}`,
    completionMessage: lines.join('\n'),
  };
}

export async function watchCi(options) {
  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    attempt += 1;
    const result = await options.check();
    options.onProgress?.(result, attempt);

    if (result.terminal) {
      return result;
    }

    if (Date.now() - startedAt >= options.timeoutMs) {
      throw new Error(
        `${options.label} watch timed out after ${options.timeoutMs}ms.`,
      );
    }

    await sleep(options.intervalMs);
  }
}

export function buildCiRequest(provider, flags, helpers) {
  const baseUrl = helpers.getFlagValue(flags, 'base-url');
  const token = helpers.getFlagValue(flags, 'token');
  const target = helpers.getFlagValue(flags, 'target');
  const requestTimeoutMs = helpers.parseOptionalInteger(
    helpers.getFlagValue(flags, 'request-timeout-ms'),
    'request-timeout-ms',
  );
  helpers.assert(
    requestTimeoutMs === undefined || requestTimeoutMs > 0,
    'request-timeout-ms must be a positive integer.',
  );

  if (provider === 'github') {
    const repo = helpers.getFlagValue(flags, 'repo');
    const runId = helpers.parseInteger(
      helpers.getFlagValue(flags, 'run-id'),
      'run-id',
    );
    helpers.assert(repo, 'GitHub CI requires --repo.');
    helpers.assert(isPositiveInteger(runId), 'run-id must be a positive integer.');
    return {
      provider,
      label: 'GitHub Actions',
      request: {
        repo,
        runId,
        baseUrl,
        token,
        target,
        requestTimeoutMs,
      },
    };
  }

  helpers.assert(provider === 'gitlab', 'Unsupported CI provider.');
  const project = helpers.getFlagValue(flags, 'project');
  const pipelineId = helpers.parseOptionalInteger(
    helpers.getFlagValue(flags, 'pipeline-id'),
    'pipeline-id',
  );
  const jobId = helpers.parseOptionalInteger(
    helpers.getFlagValue(flags, 'job-id'),
    'job-id',
  );

  helpers.assert(project, 'GitLab CI requires --project.');
  helpers.assert(
    Number(Boolean(pipelineId)) + Number(Boolean(jobId)) === 1,
    'GitLab CI requires exactly one of --pipeline-id or --job-id.',
  );

  return {
    provider,
    label: 'GitLab',
    request: {
      project,
      pipelineId,
      jobId,
      baseUrl,
      token,
      target,
      requestTimeoutMs,
    },
  };
}

export function formatCiResult(result) {
  return result.completionMessage || result.resultSummary;
}

export function formatCiError(error) {
  return toErrorMessage(error);
}
