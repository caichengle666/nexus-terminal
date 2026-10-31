import { safeAxios as axios } from '../utils/safe-http';
import { settingsRepository } from '../settings/settings.repository';
import { decrypt, encrypt } from '../utils/crypto';
import { decideStoredKeyOnSave, resolveAiCredentials, validateApiBaseUrl } from './ai-config.validation';
import {
  addProfile,
  createProfileId,
  DEFAULT_AI_PROFILE_NAME,
  findProfile,
  normalizeProfileName,
  parseStoredAiConfig,
  removeProfile,
  replaceProfile,
  serializeAiConfig,
  setActiveProfile,
  toClientConfig,
  type StoredAiConfig,
  type StoredAiProfile,
} from './ai-profiles';

export interface AiChatRequest {
  profileId?: unknown;
  apiBaseUrl: unknown;
  apiKey: unknown;
  model: unknown;
  messages: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  responseFormat?: unknown;
  temperature?: unknown;
  stream?: unknown;
  maxRequestKb?: unknown;
}

export interface AiConfigRequest {
  profileId?: unknown;
  name?: unknown;
  apiBaseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  customSystemPrompt?: unknown;
}

export interface AiProfileCreateRequest {
  name?: unknown;
  apiBaseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  activate?: unknown;
}

const AI_CONFIG_KEY = 'aiTerminalConfig';

// Validates protocol (http/https only) and rejects embedded credentials.
const normalizeApiBaseUrl = (value: unknown): string => validateApiBaseUrl(value);

// Reads the stored config; the legacy single-config shape is migrated to one "默认" profile.
const readStoredConfig = async (): Promise<StoredAiConfig> => {
  const raw = await settingsRepository.getSetting(AI_CONFIG_KEY);
  return parseStoredAiConfig(raw);
};

const writeStoredConfig = async (config: StoredAiConfig) => {
  await settingsRepository.setSetting(AI_CONFIG_KEY, serializeAiConfig(config));
};

const normalizeCustomSystemPrompt = (value: unknown, fallback = '') => {
  const prompt = typeof value === 'string' ? value.trim() : fallback;
  if (prompt.length > 16384) {
    const error = new Error('自定义系统提示词不能超过 16KB。');
    (error as any).status = 400;
    throw error;
  }
  return prompt;
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

export const getConfig = async () => toClientConfig(await readStoredConfig());

// Applies a settings payload to one profile (the given profileId, or the active one).
const applyProfileUpdate = (current: StoredAiProfile, payload: AiConfigRequest): StoredAiProfile => {
  // The stored key stays bound to its base URL: changing the URL requires a new key.
  const keyDecision = decideStoredKeyOnSave(payload, {
    apiBaseUrl: current.apiBaseUrl,
    hasApiKey: !!current.encryptedApiKey,
  });
  const nextApiKey = keyDecision === 'replace'
    ? encrypt(String(payload.apiKey).trim())
    : current.encryptedApiKey;
  const nextBaseUrl = typeof payload.apiBaseUrl === 'string' ? payload.apiBaseUrl.trim() : current.apiBaseUrl;
  return {
    ...current,
    name: normalizeProfileName(payload.name, current.name),
    apiBaseUrl: nextBaseUrl,
    model: typeof payload.model === 'string' ? payload.model.trim() : current.model,
    encryptedApiKey: nextApiKey,
    // A different endpoint or key may support stream usage again.
    ...(keyDecision === 'replace' || nextBaseUrl !== current.apiBaseUrl ? { streamUsageUnsupported: undefined } : {}),
  };
};

export const saveConfig = async (payload: AiConfigRequest) => {
  const current = await readStoredConfig();
  const profile = findProfile(current, payload.profileId);
  let next = replaceProfile(current, applyProfileUpdate(profile, payload));
  next = {
    ...next,
    customSystemPrompt: normalizeCustomSystemPrompt(payload.customSystemPrompt, current.customSystemPrompt),
  };
  await writeStoredConfig(next);
  return toClientConfig(next);
};

export const createProfile = async (payload: AiProfileCreateRequest) => {
  const current = await readStoredConfig();
  const id = createProfileId();
  const name = normalizeProfileName(payload.name, `${DEFAULT_AI_PROFILE_NAME} ${current.profiles.length + 1}`);
  const apiBaseUrl = typeof payload.apiBaseUrl === 'string' && payload.apiBaseUrl.trim()
    ? validateApiBaseUrl(payload.apiBaseUrl)
    : '';
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  const next = addProfile(current, {
    id,
    name,
    apiBaseUrl,
    model: typeof payload.model === 'string' ? payload.model.trim() : '',
    encryptedApiKey: apiKey ? encrypt(apiKey) : '',
  }, payload.activate === true);
  await writeStoredConfig(next);
  return { ...toClientConfig(next), createdProfileId: id };
};

export const deleteProfile = async (profileId: unknown) => {
  const next = removeProfile(await readStoredConfig(), profileId);
  await writeStoredConfig(next);
  return toClientConfig(next);
};

export const activateProfile = async (profileId: unknown) => {
  const next = setActiveProfile(await readStoredConfig(), profileId);
  await writeStoredConfig(next);
  return toClientConfig(next);
};

const resolveConfig = async (payload: AiChatRequest | AiConfigRequest) => {
  const stored = await readStoredConfig();
  const profile = findProfile(stored, payload.profileId);
  // Never send the stored key to a base URL other than the stored one.
  const credentials = resolveAiCredentials(payload, {
    apiBaseUrl: profile.apiBaseUrl,
    apiKey: decryptStoredApiKey(profile.encryptedApiKey),
  });
  return {
    profileId: profile.id,
    streamUsageUnsupported: profile.streamUsageUnsupported === true,
    apiBaseUrl: credentials.apiBaseUrl,
    apiKey: credentials.apiKey,
    model: payload.model || profile.model,
  };
};

// Remembers (per profile) that the provider rejected stream_options.include_usage.
const markStreamUsageUnsupported = async (profileId: string) => {
  try {
    const current = await readStoredConfig();
    const profile = current.profiles.find(item => item.id === profileId);
    if (!profile || profile.streamUsageUnsupported) return;
    await writeStoredConfig(replaceProfile(current, { ...profile, streamUsageUnsupported: true }));
  } catch (error) {
    console.warn('[AI] Failed to remember stream usage support:', error);
  }
};

export const forwardChatCompletion = async (payload: AiChatRequest) => {
  validateRequestBudget(payload);
  const {
    messages,
    tools,
    toolChoice,
    responseFormat,
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
      ...(Array.isArray(tools) && tools.length > 0 ? { tools, tool_choice: toolChoice || 'auto' } : {}),
      response_format: responseFormat,
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
  const { messages, tools, toolChoice, responseFormat, temperature } = payload;
  const { apiBaseUrl, apiKey, model, profileId, streamUsageUnsupported } = await resolveConfig(payload);

  if (!apiKey || !model || !Array.isArray(messages)) {
    const error = new Error('Missing required AI chat fields.');
    (error as any).status = 400;
    throw error;
  }

  const endpoint = `${normalizeApiBaseUrl(apiBaseUrl)}/chat/completions`;
  const send = (includeUsage: boolean) => axios.post(
    endpoint,
    {
      model,
      messages,
      ...(Array.isArray(tools) && tools.length > 0 ? { tools, tool_choice: toolChoice || 'auto' } : {}),
      response_format: responseFormat,
      temperature: typeof temperature === 'number' ? temperature : 0.2,
      stream: true,
      // Ask for a final usage chunk (token counts shown in the UI only).
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
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

  if (streamUsageUnsupported) return send(false);
  try {
    return await send(true);
  } catch (error: any) {
    // Some OpenAI-compatible providers reject unknown stream_options with 400:
    // retry once without it and remember that for this profile.
    if (error?.response?.status !== 400) throw error;
    error.response?.data?.destroy?.();
    const response = await send(false);
    await markStreamUsageUnsupported(profileId);
    return response;
  }
};

export const testConfig = async (payload: AiConfigRequest) => {
  const { apiBaseUrl, apiKey } = await resolveConfig(payload);
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
  const { apiBaseUrl, apiKey } = await resolveConfig(payload);
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
  const { apiBaseUrl, apiKey, model } = await resolveConfig(payload);
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
  const { apiBaseUrl, apiKey, model } = await resolveConfig(payload);
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
