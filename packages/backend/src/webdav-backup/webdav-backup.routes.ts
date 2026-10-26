import express from 'express';
import { webdavBackupController } from './webdav-backup.controller';
import { isAuthenticated } from '../auth/auth.middleware';

const router = express.Router();

router.use(isAuthenticated);

// GET /api/v1/webdav-backup/config - 获取 WebDAV 配置（不含密码）
router.get('/config', webdavBackupController.getConfig);

// POST /api/v1/webdav-backup/config - 保存 WebDAV 配置并测试连接
router.post('/config', webdavBackupController.saveConfig);

// DELETE /api/v1/webdav-backup/config - 删除 WebDAV 配置
router.delete('/config', webdavBackupController.deleteConfig);

// POST /api/v1/webdav-backup/test - 测试 WebDAV 连接
router.post('/test', webdavBackupController.testConn);

// POST /api/v1/webdav-backup/run - 执行备份
router.post('/run', webdavBackupController.runBackup);

// GET /api/v1/webdav-backup/list - 获取远程备份列表
router.get('/list', webdavBackupController.listAllBackups);

// DELETE /api/v1/webdav-backup/:fileName - 删除指定备份
router.delete('/:fileName', webdavBackupController.removeBackup);

// POST /api/v1/webdav-backup/restore - 启动恢复任务 (202 + jobId)
router.post('/restore', webdavBackupController.restoreBackup);

// GET /api/v1/webdav-backup/restore/status?jobId= - 恢复任务阶段
router.get('/restore/status', webdavBackupController.restoreStatus);

// GET /api/v1/webdav-backup/restore/last-result - 上次重启时应用恢复的结果
router.get('/restore/last-result', webdavBackupController.lastRestoreResult);

export default router;
