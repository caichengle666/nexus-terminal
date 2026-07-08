import { Request, Response } from 'express';
import * as AiService from './ai.service';

export const chat = async (req: Request, res: Response): Promise<void> => {
  try {
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
