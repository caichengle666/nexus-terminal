import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware';
import * as AiController from './ai.controller';

const router = Router();

router.use(isAuthenticated);

router.post('/chat', AiController.chat);

export default router;
