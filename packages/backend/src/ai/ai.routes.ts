import { Router, Request, Response } from 'express';
import axios from 'axios';
import { isAuthenticated } from '../auth/auth.middleware';

const router = Router();

const normalizeApiBaseUrl = (value: unknown): string => {
  const apiBaseUrl = String(value || '').trim().replace(/\/+$/, '');
  if (!apiBaseUrl) {
    throw new Error('AI API Base URL is required.');
  }
  return apiBaseUrl;
};

router.use(isAuthenticated);

router.post('/chat', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      apiBaseUrl,
      apiKey,
      model,
      messages,
      tools,
      toolChoice,
      temperature,
    } = req.body || {};

    if (!apiKey || !model || !Array.isArray(messages)) {
      res.status(400).json({ message: 'Missing required AI chat fields.' });
      return;
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

    res.status(response.status).json(response.data);
  } catch (error: any) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.response?.data?.message || error.message || 'AI request failed.';
    res.status(status).json({ message });
  }
});

export default router;
