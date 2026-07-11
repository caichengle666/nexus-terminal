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

export const testConfig = async (payload: AiConfigRequest) => {
  const saved = await saveConfig(payload);
  const stored = await readStoredConfig();
  const endpoint = `${normalizeApiBaseUrl(stored.apiBaseUrl)}/models`;

  await axios.get(endpoint, {
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${decryptStoredApiKey(stored.encryptedApiKey)}`,
      'Content-Type': 'application/json',
    },
  });

  return saved;
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
