import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware';
import * as AiController from './ai.controller';

const router = Router();

router.use(isAuthenticated);

router.get('/config', AiController.getConfig);
router.put('/config', AiController.saveConfig);
router.post('/config/profiles', AiController.createProfile);
router.delete('/config/profiles/:profileId', AiController.deleteProfile);
router.put('/config/active-profile', AiController.activateProfile);
router.post('/config/test', AiController.testConfig);
router.post('/config/models', AiController.listModels);
router.post('/config/test-streaming', AiController.testStreaming);
router.post('/config/test-tools', AiController.testToolCalling);
router.post('/chat', AiController.chat);

export default router;
