import { Router } from 'express';
import { AuditController } from './audit.controller';
import { isAuthenticated } from '../auth/auth.middleware';

const router = Router();
const auditController = new AuditController();

router.use(isAuthenticated);


router.get('/', auditController.getAuditLogs);

export default router;
