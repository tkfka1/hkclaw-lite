import { DEFAULT_LOCAL_LLM_BASE_URL } from './constants.js';
import { assert } from './utils.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const CURATED_CLAUDE_CODE_MODELS = [
  {
    value: 'claude-opus-4-1-20250805',
    label: 'Claude Opus 4.1',
  },
  {
    value: 'claude-sonnet-4-20250514',
    label: 'Claude Sonnet 4',
  },
];

export function supportsModelCatalogLookup(agentType) {
  return ['codex', 'claude-code', 'gemini-cli', 'local-llm'].includes(agentType);
}

export function resolveAgentEffortChoices(agentType, model) {
  switch (agentType) {
    case 'codex':
      return resolveOpenAiEffortChoices(model);
    case 'claude-code':
      return ['low', 'medium', 'high', 'max'];
    case 'gemini-cli':
      return resolveGeminiEffortChoices(model);
    default:
      return [];
  }
}

export async function listAgentModels(env, payload) {
  const agentType = String(payload?.agentType || '').trim();
  assert(
    supportsModelCatalogLookup(agentType),
    `Model listing is not supported for agent type "${agentType}".`,
  );

  switch (agentType) {
    case 'codex':
      return listOpenAiModels(env);
    case 'claude-code':
      return listAnthropicModels(env);
    case 'gemini-cli':
      return listGeminiModels(env);
    case 'local-llm':
      return listLocalLlmModels(payload, env);
    default:
      throw new Error(`Model listing is not supported for agent type "${agentType}".`);
  }
}

async function listOpenAiModels(env) {
  const apiKey = firstDefined(env.OPENAI_API_KEY);
  assert(apiKey, 'OPENAI_API_KEY is required for codex model listing.');
  const baseUrl = normalizeBaseUrl(env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL);
  const headers = {
    authorization: `Bearer ${apiKey}`,
  };
  if (env.OPENAI_ORG_ID) {
    headers['OpenAI-Organization'] = env.OPENAI_ORG_ID;
  }
  if (env.OPENAI_PROJECT_ID) {
    headers['OpenAI-Project'] = env.OPENAI_PROJECT_ID;
  }

  const payload = await fetchJson(joinApiPath(baseUrl, 'models'), { headers });
  const models = dedupeModelOptions(
    (payload?.data || [])
      .map((entry) => ({
        value: String(entry?.id || '').trim(),
        label: String(entry?.id || '').trim(),
        created: Number(entry?.created || 0),
      }))
      .filter((entry) => isLikelyOpenAiAgentModel(entry.value))
      .sort((left, right) => right.created - left.created),
  ).map((entry) => ({
    value: entry.value,
    label: entry.label,
    efforts: resolveAgentEffortChoices('codex', entry.value),
  }));

  return {
    agentType: 'codex',
    models,
    source: 'live',
    summary: models.length > 0 ? `실제 조회 모델 ${models.length}개` : '조회된 모델이 없습니다.',
  };
}

async function listAnthropicModels(env) {
  void env;
  const models = CURATED_CLAUDE_CODE_MODELS.map((entry) => ({
    value: entry.value,
    label: entry.label,
    efforts: resolveAgentEffortChoices('claude-code', entry.value),
  }));

  return {
    agentType: 'claude-code',
    models,
    source: 'curated',
    summary: `권장 모델 ${models.length}개`,
  };
}

async function listGeminiModels(env) {
  const apiKey = firstDefined(env.GEMINI_API_KEY, env.GOOGLE_API_KEY);
  assert(apiKey, 'GEMINI_API_KEY is required for gemini-cli model listing.');
  const baseUrl = normalizeBaseUrl(env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL);
  const payload = await fetchJson(joinApiPath(baseUrl, 'models'), {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });

  const models = dedupeModelOptions(
    (payload?.data || [])
      .map((entry) => ({
        value: String(entry?.id || '').trim(),
        label: String(entry?.id || '').trim(),
        created: Number(entry?.created || 0),
      }))
      .filter((entry) => isLikelyGeminiAgentModel(entry.value))
      .sort((left, right) => right.created - left.created),
  ).map((entry) => ({
    value: entry.value,
    label: entry.label,
    efforts: resolveAgentEffortChoices('gemini-cli', entry.value),
  }));

  return {
    agentType: 'gemini-cli',
    models,
    source: 'live',
    summary: models.length > 0 ? `실제 조회 모델 ${models.length}개` : '조회된 모델이 없습니다.',
  };
}

async function listLocalLlmModels(payload, env) {
  const baseUrl =
    String(payload?.baseUrl || env.LOCAL_LLM_BASE_URL || DEFAULT_LOCAL_LLM_BASE_URL).trim() ||
    DEFAULT_LOCAL_LLM_BASE_URL;
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const headers = {};
  const apiKey = firstDefined(env.LOCAL_LLM_API_KEY);
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const candidates = [
    {
      url: `${normalizedBaseUrl}/models`,
      parser: parseOpenAiCompatibleModels,
    },
  ];
  if (/\/v\d+$/u.test(normalizedBaseUrl)) {
    candidates.push({
      url: `${normalizedBaseUrl.replace(/\/v\d+$/u, '')}/api/tags`,
      parser: parseOllamaModels,
    });
  } else {
    candidates.push({
      url: `${normalizedBaseUrl}/api/tags`,
      parser: parseOllamaModels,
    });
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const payload = await fetchJson(candidate.url, { headers });
      const models = dedupeModelOptions(candidate.parser(payload));
      return {
        agentType: 'local-llm',
        models,
        source: 'live',
        summary: models.length > 0 ? `실제 조회 모델 ${models.length}개` : '조회된 모델이 없습니다.',
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('로컬 LLM 모델 목록을 불러오지 못했습니다.');
}

function resolveOpenAiEffortChoices(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) {
    return ['low', 'medium', 'high'];
  }
  if (id === 'gpt-5-pro' || id.startsWith('gpt-5-pro-')) {
    return ['high'];
  }
  if (
    id === 'gpt-5.2-pro' ||
    id.startsWith('gpt-5.2-pro-') ||
    id === 'gpt-5.4-pro' ||
    id.startsWith('gpt-5.4-pro-')
  ) {
    return ['medium', 'high', 'xhigh'];
  }
  if (id.includes('codex')) {
    return ['low', 'medium', 'high', 'xhigh'];
  }
  if (
    id.startsWith('gpt-5.2') ||
    id.startsWith('gpt-5.4') ||
    id.startsWith('gpt-5.4-mini') ||
    id.startsWith('gpt-5.4-nano')
  ) {
    return ['none', 'low', 'medium', 'high', 'xhigh'];
  }
  if (id.startsWith('gpt-5.1')) {
    return ['none', 'low', 'medium', 'high'];
  }
  if (
    id === 'gpt-5' ||
    id.startsWith('gpt-5-') ||
    id.startsWith('gpt-5-mini') ||
    id.startsWith('gpt-5-nano')
  ) {
    return ['minimal', 'low', 'medium', 'high'];
  }
  return [];
}

function resolveGeminiEffortChoices(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) {
    return ['minimal', 'low', 'medium', 'high'];
  }
  if (id.startsWith('gemini-2.5-pro')) {
    return ['minimal', 'low', 'medium', 'high'];
  }
  if (id.startsWith('gemini-2.5')) {
    return ['none', 'minimal', 'low', 'medium', 'high'];
  }
  if (id.startsWith('gemini-3')) {
    return ['minimal', 'low', 'medium', 'high'];
  }
  return ['minimal', 'low', 'medium', 'high'];
}

function isLikelyOpenAiAgentModel(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id) {
    return false;
  }
  if (
    [
      'embedding',
      'moderation',
      'image',
      'audio',
      'tts',
      'transcribe',
      'transcription',
      'realtime',
      'whisper',
      'sora',
      'search-preview',
      'omni-moderation',
    ].some((token) => id.includes(token))
  ) {
    return false;
  }
  return (
    id.startsWith('gpt-') ||
    id.startsWith('chatgpt-') ||
    id.startsWith('o') ||
    id.startsWith('computer-use-preview')
  );
}

function isLikelyGeminiAgentModel(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id.startsWith('gemini')) {
    return false;
  }
  return !['image', 'embedding', 'veo', 'tts', 'transcribe'].some((token) =>
    id.includes(token),
  );
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: 'GET',
    headers: options.headers || {},
  });
  const payload = await response
    .json()
    .catch(() => ({ error: `Invalid JSON response from ${url}` }));

  if (!response.ok) {
    throw new Error(
      typeof payload.error === 'string'
        ? payload.error
        : payload.error?.message || `HTTP ${response.status}`,
    );
  }

  return payload;
}

function parseOpenAiCompatibleModels(payload) {
  return (payload?.data || [])
    .map((entry) => String(entry?.id || '').trim())
    .filter(Boolean)
    .map((value) => ({
      value,
      label: value,
    }));
}

function parseOllamaModels(payload) {
  return (payload?.models || [])
    .map((entry) => String(entry?.name || entry?.model || '').trim())
    .filter(Boolean)
    .map((value) => ({
      value,
      label: value,
    }));
}

function dedupeModelOptions(models) {
  const seen = new Set();
  const output = [];
  for (const entry of models || []) {
    const value = String(entry?.value || '').trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push({
      value,
      label: String(entry?.label || value).trim() || value,
      efforts: Array.isArray(entry?.efforts) ? entry.efforts : undefined,
    });
  }
  return output;
}

function normalizeBaseUrl(value) {
  return String(value || '')
    .replace(/\/$/, '')
    .trim();
}

function joinApiPath(baseUrl, pathName) {
  return `${normalizeBaseUrl(baseUrl)}/${String(pathName || '').replace(/^\//u, '')}`;
}

function firstDefined(...values) {
  return values.find((value) => String(value || '').trim()) || '';
}
