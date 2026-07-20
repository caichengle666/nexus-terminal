import { Request, Response } from 'express';
import * as AiService from './ai.service';

export const getConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.status(200).json(await AiService.getConfig());
  } catch (error: any) {
    res.status(500).json({ message: error.message || 'Failed to load AI config.' });
  }
};

export const saveConfig = async (req: Request, res: Response): Promise<void> => {
  try {
    res.status(200).json(await AiService.saveConfig(req.body || {}));
  } catch (error: any) {
    res.status(500).json({ message: error.message || 'Failed to save AI config.' });
  }
};

export const testConfig = async (req: Request, res: Response): Promise<void> => {
  try {
    res.status(200).json(await AiService.testConfig(req.body || {}));
  } catch (error: any) {
    const status = error.status || error.response?.status || 500;
    const message = error.response?.data?.error?.message
      || error.response?.data?.message
      || error.message
      || 'AI config test failed.';
    res.status(status).json({ message });
  }
};

export const listModels = async (req: Request, res: Response): Promise<void> => {
  try {
    res.status(200).json(await AiService.listModels(req.body || {}));
  } catch (error: any) {
    const status = error.status || error.response?.status || 500;
    const message = error.response?.data?.error?.message
      || error.response?.data?.message
      || error.message
      || 'Failed to load AI models.';
    res.status(status).json({ message });
  }
};

export const testStreaming = async (req: Request, res: Response): Promise<void> => {
  try {
    res.status(200).json(await AiService.testStreamingConfig(req.body || {}));
  } catch (error: any) {
    const status = error.status || error.response?.status || 500;
    const message = error.response?.data?.error?.message
      || error.response?.data?.message
      || error.message
      || 'AI streaming test failed.';
    res.status(status).json({ message });
  }
};

export const testToolCalling = async (req: Request, res: Response): Promise<void> => {
  try {
    res.status(200).json(await AiService.testToolCallingConfig(req.body || {}));
  } catch (error: any) {
    const status = error.status || error.response?.status || 500;
    const message = error.response?.data?.error?.message
      || error.response?.data?.message
      || error.message
      || 'AI tool calling test failed.';
    res.status(status).json({ message });
  }
};

export const chat = async (req: Request, res: Response): Promise<void> => {
  try {
    if (req.body?.stream === true) {
      const upstream = await AiService.forwardChatCompletionStream(req.body || {});
      res.status(upstream.status);
      const rawContentType = upstream.headers['content-type'];
      const contentType = typeof rawContentType === 'string' ? rawContentType : 'text/event-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.on('close', () => {
        if (!res.writableEnded) upstream.data.destroy?.();
      });
      upstream.data.on('error', (streamError: Error) => {
        if (!res.destroyed) res.destroy(streamError);
      });
      upstream.data.pipe(res);
      return;
    }
    const response = await AiService.forwardChatCompletion(req.body || {});
    res.status(response.status).json(response.data);
  } catch (error: any) {
    const status = error.status || error.response?.status || 500;
    const message = error.response?.data?.error?.message
      || error.response?.data?.message
      || error.message
      || 'AI request failed.';
    res.status(status).json({ message });
  }
};
