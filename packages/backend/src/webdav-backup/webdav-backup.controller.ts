import { Request, Response } from 'express';
import {
  getWebDavConfig,
  saveWebDavConfig,
  deleteWebDavConfig,
  createBackup,
  listBackups,
  deleteBackup,
  restoreFromBackup,
  testConnection,
  createWebDavClient,
  WebDavBackupConfig,
} from './webdav-backup.service';

export const webdavBackupController = {
  async getConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = await getWebDavConfig();
      if (config) {
        // Never return the password
        res.json({ url: config.url, username: config.username, proxyId: config.proxyId ?? null, configured: true });
      } else {
        res.json({ url: '', username: '', configured: false });
      }
    } catch (error: any) {
      console.error('[WebDAV] 获取配置失败:', error);
      res.status(500).json({ message: '获取 WebDAV 配置失败', error: error.message });
    }
  },

  async saveConfig(req: Request, res: Response): Promise<void> {
    try {
      const { url, username, password, proxyId } = req.body;
      if (!url || !username || !password) {
        res.status(400).json({ message: 'url、username、password 均为必填项' });
        return;
      }
      const config: WebDavBackupConfig = { url, username, password, proxyId: normalizeProxyId(proxyId) };

      // Test the submitted configuration before it replaces the saved one.
      await testConnection(await createWebDavClient(config));

      await saveWebDavConfig(config);
      res.json({ message: 'WebDAV 配置已保存', configured: true });
    } catch (error: any) {
      console.error('[WebDAV] 保存配置失败:', error);
      res.status(400).json({ message: error.message || '保存 WebDAV 配置失败' });
    }
  },

  async deleteConfig(req: Request, res: Response): Promise<void> {
    try {
      await deleteWebDavConfig();
      res.json({ message: 'WebDAV 配置已删除', configured: false });
    } catch (error: any) {
      console.error('[WebDAV] 删除配置失败:', error);
      res.status(500).json({ message: '删除 WebDAV 配置失败', error: error.message });
    }
  },

  async testConn(req: Request, res: Response): Promise<void> {
    try {
      const { url, username, password, proxyId } = req.body ?? {};
      const suppliedValues = [url, username, password];
      const suppliedCount = suppliedValues.filter(value => typeof value === 'string' && value.length > 0).length;

      if (suppliedCount > 0 && suppliedCount < suppliedValues.length) {
        res.status(400).json({ message: '测试当前填写的配置时，url、username、password 均为必填项。', connected: false });
        return;
      }

      if (suppliedCount === suppliedValues.length) {
        await testConnection(await createWebDavClient({ url, username, password, proxyId: normalizeProxyId(proxyId) }));
      } else {
        const savedConfig = await getWebDavConfig();
        if (!savedConfig) {
          throw new Error('WebDAV 备份未配置。');
        }
        const hasProxyOverride = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'proxyId');
        const config = hasProxyOverride
          ? { ...savedConfig, proxyId: normalizeProxyId(proxyId) }
          : savedConfig;
        await testConnection(await createWebDavClient(config));
      }
      res.json({ message: 'WebDAV 连接测试成功', connected: true });
    } catch (error: any) {
      console.error('[WebDAV] 连接测试失败:', error);
      res.status(400).json({ message: error.message || '连接测试失败', connected: false });
    }
  },

  async runBackup(req: Request, res: Response): Promise<void> {
    try {
      const proxyId = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'proxyId')
        ? normalizeProxyId(req.body.proxyId)
        : undefined;
      const result = await createBackup(proxyId);
      res.json({ message: '备份成功', ...result });
    } catch (error: any) {
      console.error('[WebDAV] 备份执行失败:', error);
      res.status(500).json({ message: error.message || '备份执行失败' });
    }
  },

  async listAllBackups(req: Request, res: Response): Promise<void> {
    try {
      const proxyId = Object.prototype.hasOwnProperty.call(req.query, 'proxyId')
        ? normalizeProxyId(req.query.proxyId)
        : undefined;
      const files = await listBackups(proxyId);
      res.json({ files });
    } catch (error: any) {
      console.error('[WebDAV] 获取备份列表失败:', error);
      res.status(500).json({ message: error.message || '获取备份列表失败' });
    }
  },

  async removeBackup(req: Request, res: Response): Promise<void> {
    try {
      const { fileName } = req.params;
      if (!fileName) {
        res.status(400).json({ message: '缺少文件名参数' });
        return;
      }
      const proxyId = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'proxyId')
        ? normalizeProxyId(req.body.proxyId)
        : undefined;
      await deleteBackup(fileName, proxyId);
      res.json({ message: '备份文件已删除' });
    } catch (error: any) {
      console.error('[WebDAV] 删除备份失败:', error);
      res.status(500).json({ message: error.message || '删除备份失败' });
    }
  },

  async restoreBackup(req: Request, res: Response): Promise<void> {
    try {
      const { fileName } = req.body;
      if (!fileName) {
        res.status(400).json({ message: '缺少文件名' });
        return;
      }
      const proxyId = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'proxyId')
        ? normalizeProxyId(req.body.proxyId)
        : undefined;
      const result = await restoreFromBackup(fileName, proxyId);
      res.json({ message: result.message, tables: result.tables });
    } catch (error: any) {
      console.error('[WebDAV] 恢复备份失败:', error);
      res.status(500).json({ message: error.message || '恢复备份失败' });
    }
  },
};

function normalizeProxyId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const proxyId = Number(value);
  if (!Number.isInteger(proxyId) || proxyId <= 0) {
    throw new Error('无效的 WebDAV 代理。');
  }
  return proxyId;
}
