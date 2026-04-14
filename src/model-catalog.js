import { DEFAULT_LOCAL_LLM_BASE_URL } from './constants.js';
import { assert } from './utils.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const CURATED_CODEX_MODELS = [
  {
    value: 'gpt-5.4',
    label: 'GPT-5.4',
  },
  {
    value: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
  },
  {
    value: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
  },
];
const CURATED_CLAUDE_CODE_MODELS = [
  {
    value: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
  },
  {
    value: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
  },
  {
    value: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
  },
];
const CURATED_GEMINI_MODELS = [
  {
    value: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
  },
  {
    value: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
  },
  {
    value: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash Preview',
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
  if (!apiKey) {
    return buildCuratedCatalog('codex', CURATED_CODEX_MODELS, {
      summary: `권장 모델 ${CURATED_CODEX_MODELS.length}개`,
      defaultModel: 'gpt-5.4',
    });
  }
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

  try {
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
      defaultModel: selectRecommendedModel('codex', models),
    };
  } catch {
    return buildCuratedCatalog('codex', CURATED_CODEX_MODELS, {
      summary: `실시간 조회 실패, 권장 모델 ${CURATED_CODEX_MODELS.length}개`,
      defaultModel: 'gpt-5.4',
    });
  }
}

async function listAnthropicModels(env) {
  void env;
  return buildCuratedCatalog('claude-code', CURATED_CLAUDE_CODE_MODELS, {
    summary: `권장 모델 ${CURATED_CLAUDE_CODE_MODELS.length}개`,
    defaultModel: 'claude-sonnet-4-6',
  });
}

async function listGeminiModels(env) {
  void env;
  return buildCuratedCatalog('gemini-cli', CURATED_GEMINI_MODELS, {
    summary: `권장 모델 ${CURATED_GEMINI_MODELS.length}개`,
    defaultModel: 'gemini-2.5-pro',
  });
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
        defaultModel: selectRecommendedModel('local-llm', models),
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

function buildCuratedCatalog(agentType, entries, { summary, defaultModel } = {}) {
  const models = entries.map((entry) => ({
    value: entry.value,
    label: entry.label,
    efforts: resolveAgentEffortChoices(agentType, entry.value),
  }));
  return {
    agentType,
    models,
    source: 'curated',
    summary: summary || `권장 모델 ${models.length}개`,
    defaultModel: defaultModel || selectRecommendedModel(agentType, models),
  };
}

function selectRecommendedModel(agentType, models) {
  const values = (models || []).map((entry) => String(entry?.value || '').trim()).filter(Boolean);
  const preferences =
    agentType === 'codex'
      ? ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.4-mini']
      : agentType === 'claude-code'
        ? ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001']
        : agentType === 'gemini-cli'
          ? ['gemini-2.5-pro', 'gemini-2.5-flash']
          : [];
  for (const candidate of preferences) {
    if (values.includes(candidate)) {
      return candidate;
    }
  }
  return values[0] || '';
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
