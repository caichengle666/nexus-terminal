import { Router } from 'express';
import * as CommandHistoryController from './command-history.controller';
import { isAuthenticated } from '../auth/auth.middleware';

const router = Router();

router.use(isAuthenticated);

router.post('/', CommandHistoryController.addCommand); // POST /api/command-history
router.get('/', CommandHistoryController.getAllCommands); // GET /api/command-history
router.delete('/:id', CommandHistoryController.deleteCommand); // DELETE /api/command-history/:id
router.delete('/', CommandHistoryController.clearAllCommands); // DELETE /api/command-history (用于清空)

export default router;
