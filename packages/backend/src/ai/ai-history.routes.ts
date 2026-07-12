import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware';
import * as AiHistoryController from './ai-history.controller';

const router = Router();

router.use(isAuthenticated);
router.get('/config', AiHistoryController.getConfig);
router.put('/config', AiHistoryController.saveConfig);
router.put('/session', AiHistoryController.saveSession);
router.post('/directory', AiHistoryController.getSessionDirectory);

export default router;
