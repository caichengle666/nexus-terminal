import { Request, Response } from 'express';
import * as AiHistoryService from './ai-history.service';

export const getConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await AiHistoryService.getHistoryConfig());
  } catch (error: any) {
    res.status(500).json({ message: error.message || '读取 AI 会话存储配置失败。' });
  }
};

export const saveConfig = async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await AiHistoryService.saveHistoryConfig(req.body || {}));
  } catch (error: any) {
    res.status(400).json({ message: error.message || '保存 AI 会话存储配置失败。' });
  }
};

export const saveSession = async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await AiHistoryService.saveSessionHistory(req.body || {}));
  } catch (error: any) {
    res.status(error.status || 400).json({ message: error.message || '保存 AI 会话记录失败。' });
  }
};

export const getSessionDirectory = async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await AiHistoryService.getHistoryDirectory(req.body || {}));
  } catch (error: any) {
    res.status(400).json({ message: error.message || '获取 AI 会话目录失败。' });
  }
};
