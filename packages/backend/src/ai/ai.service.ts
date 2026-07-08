import axios from 'axios';

export interface AiChatRequest {
  apiBaseUrl: unknown;
  apiKey: unknown;
  model: unknown;
  messages: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  temperature?: unknown;
}

const normalizeApiBaseUrl = (value: unknown): string => {
  const apiBaseUrl = String(value || '').trim().replace(/\/+$/, '');
  if (!apiBaseUrl) {
    throw new Error('AI API Base URL is required.');
  }
  return apiBaseUrl;
};

export const forwardChatCompletion = async (payload: AiChatRequest) => {
  const {
    apiBaseUrl,
    apiKey,
    model,
    messages,
    tools,
    toolChoice,
    temperature,
  } = payload;

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
