import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware';
import * as AiController from './ai.controller';

const router = Router();

router.use(isAuthenticated);

router.get('/config', AiController.getConfig);
router.put('/config', AiController.saveConfig);
router.post('/config/test', AiController.testConfig);
router.post('/config/models', AiController.listModels);
router.post('/config/test-streaming', AiController.testStreaming);
router.post('/chat', AiController.chat);

export default router;
