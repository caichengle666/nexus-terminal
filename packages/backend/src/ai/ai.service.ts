import axios from 'axios';
import { settingsRepository } from '../settings/settings.repository';
import { decrypt, encrypt } from '../utils/crypto';

export interface AiChatRequest {
  apiBaseUrl: unknown;
  apiKey: unknown;
  model: unknown;
  messages: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  temperature?: unknown;
  stream?: unknown;
  maxRequestKb?: unknown;
}

export interface AiConfigRequest {
  apiBaseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
}

const AI_CONFIG_KEY = 'aiTerminalConfig';

const normalizeApiBaseUrl = (value: unknown): string => {
  const apiBaseUrl = String(value || '').trim().replace(/\/+$/, '');
  if (!apiBaseUrl) {
    throw new Error('AI API Base URL is required.');
  }
  return apiBaseUrl;
};

const readStoredConfig = async () => {
  const raw = await settingsRepository.getSetting(AI_CONFIG_KEY);
  if (!raw) {
    return { apiBaseUrl: '', model: '', encryptedApiKey: '' };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      apiBaseUrl: typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      encryptedApiKey: typeof parsed.encryptedApiKey === 'string' ? parsed.encryptedApiKey : '',
    };
  } catch {
    return { apiBaseUrl: '', model: '', encryptedApiKey: '' };
  }
};

const decryptStoredApiKey = (encryptedApiKey: string) => {
  if (!encryptedApiKey) return '';
  return decrypt(encryptedApiKey);
};

const validateRequestBudget = (payload: AiChatRequest) => {
  const requestedKb = Number(payload.maxRequestKb) || 256;
  const maxRequestBytes = Math.min(1024 * 1024, Math.max(64 * 1024, requestedKb * 1024));
  const requestBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (requestBytes > maxRequestBytes) {
    const error = new Error(`AI 请求超过当前设置的 ${Math.round(maxRequestBytes / 1024)}KB 上限。`);
    (error as any).status = 413;
    throw error;
  }
};

export const getConfig = async () => {
  const stored = await readStoredConfig();
  return {
    apiBaseUrl: stored.apiBaseUrl,
    model: stored.model,
    hasApiKey: !!stored.encryptedApiKey,
  };
};

export const saveConfig = async (payload: AiConfigRequest) => {
  const current = await readStoredConfig();
  const nextApiKey = typeof payload.apiKey === 'string' && payload.apiKey.trim()
    ? encrypt(payload.apiKey.trim())
    : current.encryptedApiKey;

  const next = {
    apiBaseUrl: typeof payload.apiBaseUrl === 'string' ? payload.apiBaseUrl.trim() : current.apiBaseUrl,
    model: typeof payload.model === 'string' ? payload.model.trim() : current.model,
    encryptedApiKey: nextApiKey,
  };

  await settingsRepository.setSetting(AI_CONFIG_KEY, JSON.stringify(next));
  return {
    apiBaseUrl: next.apiBaseUrl,
    model: next.model,
    hasApiKey: !!next.encryptedApiKey,
  };
};

const resolveConfig = async (payload: AiChatRequest) => {
  const stored = await readStoredConfig();
  return {
    apiBaseUrl: payload.apiBaseUrl || stored.apiBaseUrl,
    apiKey: payload.apiKey || decryptStoredApiKey(stored.encryptedApiKey),
    model: payload.model || stored.model,
  };
};

export const forwardChatCompletion = async (payload: AiChatRequest) => {
  validateRequestBudget(payload);
  const {
    messages,
    tools,
    toolChoice,
    temperature,
  } = payload;
  const { apiBaseUrl, apiKey, model } = await resolveConfig(payload);

  if (!apiKey || !model || !Array.isArray(messages)) {
    const error = new Error('Missing required AI chat fields.');
    (error as any).status = 400;
    throw error;
  }

  const endpoint = `${normalizeApiBaseUrl(apiBaseUrl)}/chat/completions`;
  const response = await axios.post(
    endpoint,
    {
      model,
      messages,
      tools,
      tool_choice: toolChoice || 'auto',
      temperature: typeof temperature === 'number' ? temperature : 0.2,
    },
    {
      timeout: 120000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return {
    status: response.status,
    data: response.data,
  };
};

export const forwardChatCompletionStream = async (payload: AiChatRequest) => {
  validateRequestBudget(payload);
  const { messages, tools, toolChoice, temperature } = payload;
  const { apiBaseUrl, apiKey, model } = await resolveConfig(payload);

  if (!apiKey || !model || !Array.isArray(messages)) {
    const error = new Error('Missing required AI chat fields.');
    (error as any).status = 400;
    throw error;
  }

  const endpoint = `${normalizeApiBaseUrl(apiBaseUrl)}/chat/completions`;
  return axios.post(
    endpoint,
    {
      model,
      messages,
      tools,
      tool_choice: toolChoice || 'auto',
      temperature: typeof temperature === 'number' ? temperature : 0.2,
      stream: true,
    },
    {
      timeout: 120000,
      responseType: 'stream',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
    },
  );
};

export const testConfig = async (payload: AiConfigRequest) => {
  const stored = await readStoredConfig();
  const apiBaseUrl = payload.apiBaseUrl || stored.apiBaseUrl;
  const apiKey = payload.apiKey || decryptStoredApiKey(stored.encryptedApiKey);
  if (!apiKey) {
    const error = new Error('AI API key is required.');
    (error as any).status = 400;
    throw error;
  }
  const endpoint = `${normalizeApiBaseUrl(apiBaseUrl)}/models`;

  await axios.get(endpoint, {
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  return saveConfig(payload);
};

export const listModels = async (payload: AiConfigRequest) => {
  const stored = await readStoredConfig();
  const apiBaseUrl = payload.apiBaseUrl || stored.apiBaseUrl;
  const apiKey = payload.apiKey || decryptStoredApiKey(stored.encryptedApiKey);
  const endpoint = `${normalizeApiBaseUrl(apiBaseUrl)}/models`;

  if (!apiKey) {
    const error = new Error('AI API key is required.');
    (error as any).status = 400;
    throw error;
  }

  const response = await axios.get(endpoint, {
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  const rawModels = Array.isArray(response.data?.data)
    ? response.data.data
    : Array.isArray(response.data?.models)
      ? response.data.models
      : [];
  const modelNames: string[] = rawModels
    .map((item: unknown) => typeof item === 'string' ? item : (item as any)?.id || (item as any)?.name)
    .filter((model: unknown): model is string => typeof model === 'string' && !!model.trim())
    .map((model: string) => model.trim());
  const models = Array.from(new Set<string>(modelNames)).sort((left, right) => left.localeCompare(right));

  return { models };
};

export const testStreamingConfig = async (payload: AiConfigRequest) => {
  const stored = await readStoredConfig();
  const apiBaseUrl = payload.apiBaseUrl || stored.apiBaseUrl;
  const apiKey = payload.apiKey || decryptStoredApiKey(stored.encryptedApiKey);
  const model = payload.model || stored.model;
  if (!apiKey || !model) {
    const error = new Error('AI API key and model are required.');
    (error as any).status = 400;
    throw error;
  }

  const endpoint = `${normalizeApiBaseUrl(apiBaseUrl)}/chat/completions`;
  const response = await axios.post(endpoint, {
    model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    max_tokens: 1,
    stream: true,
  }, {
    timeout: 20000,
    responseType: 'stream',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
  });
  const contentType = String(response.headers['content-type'] || '');
  response.data.destroy?.();
  if (!contentType.includes('text/event-stream')) {
    const error = new Error('服务商没有返回 SSE 流式响应。');
    (error as any).status = 422;
    throw error;
  }
  return { supported: true, message: '流式输出测试通过。' };
};

export const testToolCallingConfig = async (payload: AiConfigRequest) => {
  const stored = await readStoredConfig();
  const apiBaseUrl = payload.apiBaseUrl || stored.apiBaseUrl;
  const apiKey = payload.apiKey || decryptStoredApiKey(stored.encryptedApiKey);
  const model = payload.model || stored.model;
  if (!apiKey || !model) {
    const error = new Error('AI API key and model are required.');
    (error as any).status = 400;
    throw error;
  }

  const endpoint = `${normalizeApiBaseUrl(apiBaseUrl)}/chat/completions`;
  const response = await axios.post(endpoint, {
    model,
    messages: [{ role: 'user', content: 'Call nexus_tool_test with value OK. Do not answer with plain text.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'nexus_tool_test',
        description: 'Validate tool calling support without performing an external action.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'string' } },
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'nexus_tool_test' } },
    temperature: 0,
    max_tokens: 64,
  }, {
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  const toolCall = response.data?.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.name !== 'nexus_tool_test') {
    const error = new Error('模型没有返回标准 tool_calls，可能不支持 OpenAI 兼容工具调用。');
    (error as any).status = 422;
    throw error;
  }
  try {
    const args = JSON.parse(toolCall.function.arguments || '{}');
    if (typeof args?.value !== 'string') throw new Error('missing value');
  } catch {
    const error = new Error('模型返回了工具调用，但 arguments 不是有效 JSON。');
    (error as any).status = 422;
    throw error;
  }

  return { supported: true, message: '工具调用测试通过，模型能返回有效的函数名和 JSON 参数。' };
};
