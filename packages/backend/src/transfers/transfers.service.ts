import * as path from 'path';
import { createHash } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import { Client, FileEntry, SFTPWrapper, Stats } from 'ssh2';
import { establishSshConnection, getConnectionDetails } from '../services/ssh.service';
import { InitiateTransferPayload, TransferSubTask, TransferTask } from './transfers.types';

interface TransferEntry {
  sourcePath: string;
  targetPath: string;
  type: 'file' | 'directory';
  size: number;
  mode: number;
  mtime: number;
}

interface TransferManifest {
  entries: TransferEntry[];
  totalBytes: number;
  totalFiles: number;
}

interface SftpEndpoint {
  client: Client;
  sftp: SFTPWrapper;
}

export class TransfersService {
  private readonly transferTasks = new Map<string, TransferTask>();
  private readonly taskAbortControllers = new Map<string, AbortController>();
  private readonly maxConcurrentTargets = 2;
  private readonly inactivityTimeoutMs = 2 * 60 * 1000;
  private readonly metadataTimeoutMs = 30 * 1000;
  private readonly maxTaskHistory = 50;

  public async initiateNewTransfer(payload: InitiateTransferPayload, userId: string | number): Promise<TransferTask> {
    const taskId = uuidv4();
    const now = new Date();
    const subTasks: TransferSubTask[] = [];

    for (const connectionId of payload.connectionIds) {
      for (const item of payload.sourceItems) {
        subTasks.push({
          subTaskId: uuidv4(),
          connectionId,
          sourceItemName: item.name,
          sourceItemPath: item.path,
          status: 'queued',
          progress: 0,
          transferredBytes: 0,
          totalBytes: 0,
          filesCompleted: 0,
          totalFiles: 0,
          transferMethodUsed: 'sftp-relay',
          startTime: now,
        });
      }
    }

    const task: TransferTask = {
      taskId,
      status: 'queued',
      userId,
      createdAt: now,
      updatedAt: now,
      subTasks,
      payload: { ...payload, transferMethod: 'sftp-relay' },
      overallProgress: 0,
    };
    const abortController = new AbortController();
    this.transferTasks.set(taskId, task);
    this.taskAbortControllers.set(taskId, abortController);
    this.pruneTaskHistory();

    void this.processTransferTask(taskId, abortController.signal).catch(error => {
      console.error(`[TransfersService] Unhandled transfer task error ${taskId}:`, error);
      if (!this.isAbortError(error)) {
        this.updateOverallTaskStatus(taskId, 'failed');
      }
    });

    return this.cloneTask(task);
  }

  public async cancelTransferTask(taskId: string, userId: string | number): Promise<boolean> {
    const task = this.transferTasks.get(taskId);
    const controller = this.taskAbortControllers.get(taskId);
    if (!task || task.userId !== userId || !controller || this.isFinalTaskStatus(task.status)) {
      return false;
    }

    task.status = 'cancelling';
    task.updatedAt = new Date();
    for (const subTask of task.subTasks) {
      if (!this.isFinalSubTaskStatus(subTask.status)) {
        subTask.status = subTask.status === 'queued' ? 'cancelled' : 'cancelling';
        subTask.message = '正在停止传输...';
      }
    }
    controller.abort();
    return true;
  }

  public async getTransferTaskDetails(taskId: string, userId: string | number): Promise<TransferTask | null> {
    const task = this.transferTasks.get(taskId);
    return task && task.userId === userId ? this.cloneTask(task) : null;
  }

  public async getAllTransferTasks(userId: string | number): Promise<TransferTask[]> {
    return Array.from(this.transferTasks.values())
      .filter(task => task.userId === userId)
      .map(task => this.cloneTask(task));
  }

  private async processTransferTask(taskId: string, signal: AbortSignal): Promise<void> {
    const task = this.requireTask(taskId);
    this.updateOverallTaskStatus(taskId, 'in-progress');
    let sourceEndpoint: SftpEndpoint | null = null;

    try {
      this.throwIfAborted(signal);
      sourceEndpoint = await this.openSftpEndpoint(task.payload.sourceConnectionId, signal);

      const manifests = new Map<string, TransferManifest>();
      for (const item of task.payload.sourceItems) {
        for (const subTask of task.subTasks.filter(candidate => candidate.sourceItemPath === item.path)) {
          this.updateSubTaskStatus(taskId, subTask.subTaskId, 'connecting', 1, '正在扫描源文件...');
        }
        try {
          manifests.set(item.path, await this.buildManifest(sourceEndpoint.sftp, item, signal));
        } catch (error: any) {
          if (this.isAbortError(error) || signal.aborted) throw error;
          for (const subTask of task.subTasks.filter(candidate => candidate.sourceItemPath === item.path)) {
            this.updateSubTaskStatus(taskId, subTask.subTaskId, 'failed', 0, this.formatError(error));
          }
        }
      }

      const subTasksByTarget = new Map<number, TransferSubTask[]>();
      for (const subTask of task.subTasks) {
        const targetTasks = subTasksByTarget.get(subTask.connectionId) ?? [];
        targetTasks.push(subTask);
        subTasksByTarget.set(subTask.connectionId, targetTasks);
      }

      const targetGroups = Array.from(subTasksByTarget.entries());
      let nextTargetIndex = 0;
      const workerCount = Math.min(this.maxConcurrentTargets, targetGroups.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextTargetIndex < targetGroups.length) {
          const groupIndex = nextTargetIndex++;
          const [targetConnectionId, targetSubTasks] = targetGroups[groupIndex];
          await this.processTargetGroup(
            task,
            sourceEndpoint!.sftp,
            targetConnectionId,
            targetSubTasks,
            manifests,
            signal,
          );
        }
      });
      await Promise.all(workers);

      this.throwIfAborted(signal);
      this.updateOverallTaskStatusBasedOnSubTasks(taskId);
    } catch (error: any) {
      if (this.isAbortError(error) || signal.aborted) {
        this.markTaskCancelled(taskId);
      } else {
        console.error(`[TransfersService] Task ${taskId} failed:`, error);
        for (const subTask of task.subTasks) {
          if (!this.isFinalSubTaskStatus(subTask.status)) {
            this.updateSubTaskStatus(taskId, subTask.subTaskId, 'failed', subTask.progress, this.formatError(error));
          }
        }
        this.updateOverallTaskStatus(taskId, 'failed');
      }
    } finally {
      this.closeEndpoint(sourceEndpoint);
      this.taskAbortControllers.delete(taskId);
    }
  }

  private async processTargetGroup(
    task: TransferTask,
    sourceSftp: SFTPWrapper,
    targetConnectionId: number,
    subTasks: TransferSubTask[],
    manifests: Map<string, TransferManifest>,
    signal: AbortSignal,
  ): Promise<void> {
    let targetEndpoint: SftpEndpoint | null = null;

    try {
      const transferableSubTasks = subTasks.filter(subTask => !this.isFinalSubTaskStatus(subTask.status));
      if (transferableSubTasks.length === 0) return;
      for (const subTask of transferableSubTasks) {
        this.updateSubTaskStatus(task.taskId, subTask.subTaskId, 'connecting', 1, '正在连接目标服务器...');
      }
      targetEndpoint = await this.openSftpEndpoint(targetConnectionId, signal);
      const targetBasePath = await this.resolveTargetBasePath(targetEndpoint.sftp, task.payload.remoteTargetPath);
      await this.ensureDirectory(targetEndpoint.sftp, targetBasePath);

      for (const subTask of subTasks) {
        if (this.isFinalSubTaskStatus(subTask.status)) continue;
        this.throwIfAborted(signal);
        const sourceItem = task.payload.sourceItems.find(item => item.path === subTask.sourceItemPath);
        if (!sourceItem) {
          this.updateSubTaskStatus(task.taskId, subTask.subTaskId, 'failed', 0, '找不到源文件信息');
          continue;
        }

        try {
          const sourceManifest = manifests.get(sourceItem.path);
          if (!sourceManifest) throw new Error(`无法生成 ${sourceItem.path} 的传输清单`);
          const manifest = this.mapManifestToTarget(sourceManifest, targetBasePath);
          subTask.totalBytes = manifest.totalBytes;
          subTask.totalFiles = manifest.totalFiles;
          subTask.transferMethodUsed = 'sftp-relay';
          await this.transferManifest(task.taskId, subTask, sourceSftp, targetEndpoint.sftp, manifest, signal);
          this.updateSubTaskStatus(task.taskId, subTask.subTaskId, 'completed', 100, '传输完成');
        } catch (error: any) {
          if (this.isAbortError(error) || signal.aborted) throw error;
          console.error(`[TransfersService] Sub-task ${subTask.subTaskId} failed:`, error);
          this.updateSubTaskStatus(
            task.taskId,
            subTask.subTaskId,
            'failed',
            subTask.progress,
            this.formatError(error),
          );
        }
      }
    } catch (error: any) {
      if (this.isAbortError(error) || signal.aborted) throw error;
      for (const subTask of subTasks) {
        if (!this.isFinalSubTaskStatus(subTask.status)) {
          this.updateSubTaskStatus(task.taskId, subTask.subTaskId, 'failed', subTask.progress, this.formatError(error));
        }
      }
    } finally {
      this.closeEndpoint(targetEndpoint);
    }
  }

  private async transferManifest(
    taskId: string,
    subTask: TransferSubTask,
    sourceSftp: SFTPWrapper,
    targetSftp: SFTPWrapper,
    manifest: TransferManifest,
    signal: AbortSignal,
  ): Promise<void> {
    subTask.transferredBytes = 0;
    subTask.filesCompleted = 0;
    const transferStartedAt = Date.now();
    let lastUiUpdateAt = 0;
    let completedBytes = 0;
    let networkBytes = 0;

    for (const entry of manifest.entries) {
      this.throwIfAborted(signal);
      subTask.currentPath = entry.targetPath;
      if (entry.type === 'directory') {
        await this.ensureDirectory(targetSftp, entry.targetPath);
        continue;
      }

      await this.ensureDirectory(targetSftp, path.posix.dirname(entry.targetPath));
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          await this.transferFile(sourceSftp, targetSftp, entry, signal, (fileBytes, networkDelta) => {
            subTask.transferredBytes = completedBytes + fileBytes;
            networkBytes += networkDelta;
            const elapsedSeconds = Math.max(0.001, (Date.now() - transferStartedAt) / 1000);
            subTask.speedBytesPerSecond = Math.round(networkBytes / elapsedSeconds);
            const now = Date.now();
            if (now - lastUiUpdateAt >= 250) {
              lastUiUpdateAt = now;
              this.updateSubTaskStatus(
                taskId,
                subTask.subTaskId,
                'transferring',
                this.calculateProgress(subTask),
                '正在传输...',
              );
            }
          });
          break;
        } catch (error) {
          if (this.isAbortError(error) || signal.aborted || attempt >= 3) throw error;
          this.updateSubTaskStatus(
            taskId,
            subTask.subTaskId,
            'transferring',
            this.calculateProgress(subTask),
            `连接中断，正在进行第 ${attempt + 1} 次重试...`,
          );
          await this.delay(1000 * attempt, signal);
        }
      }
      completedBytes += entry.size;
      subTask.transferredBytes = completedBytes;
      subTask.filesCompleted = (subTask.filesCompleted ?? 0) + 1;
      this.updateSubTaskStatus(taskId, subTask.subTaskId, 'transferring', this.calculateProgress(subTask), '正在传输...');
    }
  }

  private async transferFile(
    sourceSftp: SFTPWrapper,
    targetSftp: SFTPWrapper,
    entry: TransferEntry,
    signal: AbortSignal,
    onProgress: (fileBytes: number, networkDelta: number) => void,
  ): Promise<void> {
    const fingerprint = createHash('sha256')
      .update(`${entry.sourcePath}\0${entry.size}\0${entry.mtime}`)
      .digest('hex')
      .slice(0, 12);
    const partPath = `${entry.targetPath}.nexus-transfer.${fingerprint}.part`;
    let partStats = await this.getOptionalStats(targetSftp, partPath);
    if (partStats && partStats.size > entry.size) {
      await this.unlinkFile(targetSftp, partPath);
      partStats = null;
    }

    const resumeOffset = partStats?.size ?? 0;
    let currentFileBytes = resumeOffset;
    onProgress(currentFileBytes, 0);

    if (entry.size === 0 && !partStats) {
      await this.withTimeout(new Promise<void>((resolve, reject) => {
        const stream = targetSftp.createWriteStream(partPath, { flags: 'w', mode: entry.mode & 0o777 });
        stream.once('error', reject);
        stream.once('close', resolve);
        stream.end();
      }), `创建空文件 ${entry.targetPath}`);
    } else if (resumeOffset < entry.size) {
      const readStream = sourceSftp.createReadStream(entry.sourcePath, { start: resumeOffset });
      const writeStream = targetSftp.createWriteStream(partPath, resumeOffset > 0
        ? { flags: 'r+', start: resumeOffset, mode: entry.mode & 0o777 }
        : { flags: 'w', mode: entry.mode & 0o777 });
      let inactivityTimer: NodeJS.Timeout | null = null;
      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          readStream.destroy(new Error('传输超过 2 分钟没有收到数据'));
          writeStream.destroy();
        }, this.inactivityTimeoutMs);
      };
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          currentFileBytes += chunk.length;
          onProgress(currentFileBytes, chunk.length);
          resetInactivityTimer();
          callback(null, chunk);
        },
      });

      resetInactivityTimer();
      try {
        await pipeline(readStream, meter, writeStream, { signal });
      } finally {
        if (inactivityTimer) clearTimeout(inactivityTimer);
      }
    }

    const completedStats = await this.getStats(targetSftp, partPath);
    if (completedStats.size !== entry.size) {
      throw new Error(`临时文件大小不一致: ${completedStats.size}/${entry.size}`);
    }
    await this.replaceFile(targetSftp, partPath, entry.targetPath);
    await this.chmodFile(targetSftp, entry.targetPath, entry.mode & 0o777).catch(() => undefined);
  }

  private async buildManifest(
    sourceSftp: SFTPWrapper,
    item: InitiateTransferPayload['sourceItems'][number],
    signal: AbortSignal,
  ): Promise<TransferManifest> {
    const entries: TransferEntry[] = [];
    let totalBytes = 0;
    let totalFiles = 0;
    const rootStats = await this.getStats(sourceSftp, item.path);

    const visit = async (sourcePath: string, relativePath: string, stats: Stats): Promise<void> => {
      this.throwIfAborted(signal);
      if (stats.isSymbolicLink()) {
        throw new Error(`暂不支持符号链接: ${sourcePath}`);
      }
      if (stats.isDirectory()) {
        entries.push({ sourcePath, targetPath: relativePath, type: 'directory', size: 0, mode: stats.mode, mtime: stats.mtime });
        const children = await this.readDirectory(sourceSftp, sourcePath);
        for (const child of children) {
          if (child.filename === '.' || child.filename === '..') continue;
          const childPath = path.posix.join(sourcePath, child.filename);
          await visit(
            childPath,
            path.posix.join(relativePath, child.filename),
            await this.getStats(sourceSftp, childPath),
          );
        }
        return;
      }
      if (!stats.isFile()) throw new Error(`不支持的文件类型: ${sourcePath}`);
      entries.push({ sourcePath, targetPath: relativePath, type: 'file', size: stats.size, mode: stats.mode, mtime: stats.mtime });
      totalBytes += stats.size;
      totalFiles += 1;
    };

    await visit(item.path, path.posix.basename(item.name || item.path), rootStats);
    return { entries, totalBytes, totalFiles };
  }

  private mapManifestToTarget(
    manifest: TransferManifest,
    targetBasePath: string,
  ): TransferManifest {
    return {
      ...manifest,
      entries: manifest.entries.map(entry => ({
        ...entry,
        targetPath: this.safeJoinTargetPath(targetBasePath, entry.targetPath),
      })),
    };
  }

  private safeJoinTargetPath(targetBasePath: string, relativePath: string): string {
    const normalizedBase = path.posix.normalize(targetBasePath);
    const candidate = path.posix.normalize(path.posix.join(normalizedBase, relativePath));
    const basePrefix = normalizedBase === '/' ? '/' : `${normalizedBase}/`;
    if (candidate !== normalizedBase && !candidate.startsWith(basePrefix)) {
      throw new Error(`目标路径超出指定目录: ${relativePath}`);
    }
    return candidate;
  }

  private async openSftpEndpoint(connectionId: number, signal: AbortSignal): Promise<SftpEndpoint> {
    this.throwIfAborted(signal);
    const details = await getConnectionDetails(connectionId);
    const client = await establishSshConnection(details);
    if (signal.aborted) {
      client.end();
      this.throwIfAborted(signal);
    }

    try {
      const sftp = await this.withTimeout(new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, wrapper) => error ? reject(error) : resolve(wrapper));
      }), `打开连接 ${connectionId} 的 SFTP 会话`);
      return { client, sftp };
    } catch (error) {
      client.end();
      throw error;
    }
  }

  private closeEndpoint(endpoint: SftpEndpoint | null): void {
    if (!endpoint) return;
    try { endpoint.sftp.end(); } catch { /* already closed */ }
    try { endpoint.client.end(); } catch { /* already closed */ }
  }

  private async resolveTargetBasePath(sftp: SFTPWrapper, requestedPath: string): Promise<string> {
    const trimmedPath = requestedPath.trim();
    if (trimmedPath.startsWith('/')) return path.posix.normalize(trimmedPath);
    const homePath = await this.realpath(sftp, '.');
    if (trimmedPath === '~') return homePath;
    if (trimmedPath.startsWith('~/')) return path.posix.join(homePath, trimmedPath.slice(2));
    return path.posix.join(homePath, trimmedPath);
  }

  private async ensureDirectory(sftp: SFTPWrapper, directoryPath: string): Promise<void> {
    const normalized = path.posix.normalize(directoryPath);
    if (normalized === '/') return;
    const segments = normalized.split('/').filter(Boolean);
    let current = normalized.startsWith('/') ? '/' : '';
    for (const segment of segments) {
      current = path.posix.join(current, segment);
      const stats = await this.getOptionalStats(sftp, current);
      if (stats) {
        if (!stats.isDirectory()) throw new Error(`目标路径不是目录: ${current}`);
        continue;
      }
      await this.withTimeout(new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, error => error ? reject(error) : resolve());
      }), `创建目录 ${current}`);
    }
  }

  private getStats(sftp: SFTPWrapper, filePath: string): Promise<Stats> {
    return this.withTimeout(new Promise((resolve, reject) => {
      sftp.lstat(filePath, (error, stats) => error ? reject(error) : resolve(stats));
    }), `读取文件状态 ${filePath}`);
  }

  private getOptionalStats(sftp: SFTPWrapper, filePath: string): Promise<Stats | null> {
    return this.getStats(sftp, filePath).catch((error: any) => {
      if (this.isNotFoundError(error)) return null;
      throw error;
    });
  }

  private readDirectory(sftp: SFTPWrapper, directoryPath: string): Promise<FileEntry[]> {
    return this.withTimeout(new Promise((resolve, reject) => {
      sftp.readdir(directoryPath, (error, entries) => error ? reject(error) : resolve(entries));
    }), `读取目录 ${directoryPath}`);
  }

  private realpath(sftp: SFTPWrapper, targetPath: string): Promise<string> {
    return this.withTimeout(new Promise((resolve, reject) => {
      sftp.realpath(targetPath, (error, absolutePath) => error ? reject(error) : resolve(absolutePath));
    }), `解析路径 ${targetPath}`);
  }

  private unlinkFile(sftp: SFTPWrapper, filePath: string): Promise<void> {
    return this.withTimeout(new Promise((resolve, reject) => {
      sftp.unlink(filePath, error => error ? reject(error) : resolve());
    }), `删除文件 ${filePath}`);
  }

  private renameFile(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<void> {
    return this.withTimeout(new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, error => error ? reject(error) : resolve());
    }), `重命名 ${oldPath}`);
  }

  private chmodFile(sftp: SFTPWrapper, filePath: string, mode: number): Promise<void> {
    return this.withTimeout(new Promise((resolve, reject) => {
      sftp.chmod(filePath, mode, error => error ? reject(error) : resolve());
    }), `设置权限 ${filePath}`);
  }

  private async replaceFile(sftp: SFTPWrapper, partPath: string, finalPath: string): Promise<void> {
    const opensshRename = (sftp as SFTPWrapper & {
      ext_openssh_rename?: (oldPath: string, newPath: string, callback: (error?: Error) => void) => void;
    }).ext_openssh_rename;
    if (typeof opensshRename === 'function') {
      try {
        await this.withTimeout(new Promise<void>((resolve, reject) => {
          opensshRename.call(sftp, partPath, finalPath, error => error ? reject(error) : resolve());
        }), `替换目标文件 ${finalPath}`);
        return;
      } catch {
        // Some servers advertise the extension but reject it for specific filesystems.
      }
    }

    const existingTarget = await this.getOptionalStats(sftp, finalPath);
    if (!existingTarget) {
      await this.renameFile(sftp, partPath, finalPath);
      return;
    }
    if (!existingTarget.isFile()) throw new Error(`目标位置已存在且不是文件: ${finalPath}`);

    const backupPath = `${finalPath}.nexus-transfer.backup-${uuidv4()}`;
    await this.renameFile(sftp, finalPath, backupPath);
    try {
      await this.renameFile(sftp, partPath, finalPath);
      await this.unlinkFile(sftp, backupPath).catch(() => undefined);
    } catch (error) {
      await this.renameFile(sftp, backupPath, finalPath).catch(() => undefined);
      throw error;
    }
  }

  private calculateProgress(subTask: TransferSubTask): number {
    if ((subTask.totalBytes ?? 0) > 0) {
      return Math.min(99, Math.floor(((subTask.transferredBytes ?? 0) / subTask.totalBytes!) * 100));
    }
    if ((subTask.totalFiles ?? 0) > 0) {
      return Math.min(99, Math.floor(((subTask.filesCompleted ?? 0) / subTask.totalFiles!) * 100));
    }
    return 99;
  }

  private updateSubTaskStatus(
    taskId: string,
    subTaskId: string,
    status: TransferSubTask['status'],
    progress?: number,
    message?: string,
  ): void {
    const task = this.transferTasks.get(taskId);
    const subTask = task?.subTasks.find(item => item.subTaskId === subTaskId);
    if (!task || !subTask) return;
    if (this.isFinalSubTaskStatus(subTask.status) && !this.isFinalSubTaskStatus(status)) return;

    subTask.status = status;
    if (progress !== undefined) subTask.progress = Math.max(0, Math.min(100, progress));
    if (message !== undefined) subTask.message = message;
    if (this.isFinalSubTaskStatus(status)) subTask.endTime = subTask.endTime ?? new Date();
    task.updatedAt = new Date();
    this.updateOverallTaskStatusBasedOnSubTasks(taskId);
  }

  private updateOverallTaskStatus(taskId: string, status: TransferTask['status']): void {
    const task = this.transferTasks.get(taskId);
    if (!task) return;
    task.status = status;
    task.updatedAt = new Date();
  }

  private updateOverallTaskStatusBasedOnSubTasks(taskId: string): void {
    const task = this.transferTasks.get(taskId);
    if (!task || task.subTasks.length === 0) return;
    task.overallProgress = Math.round(
      task.subTasks.reduce((sum, subTask) => sum + (subTask.progress ?? 0), 0) / task.subTasks.length,
    );

    const completed = task.subTasks.filter(subTask => subTask.status === 'completed').length;
    const failed = task.subTasks.filter(subTask => subTask.status === 'failed').length;
    const cancelled = task.subTasks.filter(subTask => subTask.status === 'cancelled').length;
    if (completed === task.subTasks.length) task.status = 'completed';
    else if (failed === task.subTasks.length) task.status = 'failed';
    else if (cancelled === task.subTasks.length) task.status = 'cancelled';
    else if (completed + failed + cancelled === task.subTasks.length) task.status = 'partially-completed';
    else if (task.status !== 'cancelling') task.status = 'in-progress';
    task.updatedAt = new Date();
  }

  private markTaskCancelled(taskId: string): void {
    const task = this.transferTasks.get(taskId);
    if (!task) return;
    for (const subTask of task.subTasks) {
      if (!this.isFinalSubTaskStatus(subTask.status)) {
        subTask.status = 'cancelled';
        subTask.message = '传输已取消，临时文件保留以便下次续传';
        subTask.endTime = new Date();
      }
    }
    task.status = 'cancelled';
    task.updatedAt = new Date();
  }

  private cloneTask(task: TransferTask): TransferTask {
    return {
      ...task,
      subTasks: task.subTasks.map(subTask => ({ ...subTask })),
      payload: {
        ...task.payload,
        sourceItems: task.payload.sourceItems.map(item => ({ ...item })),
        connectionIds: [...task.payload.connectionIds],
      },
      sourceConnectionId: task.payload.sourceConnectionId,
      remoteTargetPath: task.payload.remoteTargetPath,
    };
  }

  private pruneTaskHistory(): void {
    if (this.transferTasks.size <= this.maxTaskHistory) return;
    const removableTasks = Array.from(this.transferTasks.values())
      .filter(task => this.isFinalTaskStatus(task.status))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    while (this.transferTasks.size > this.maxTaskHistory && removableTasks.length > 0) {
      this.transferTasks.delete(removableTasks.shift()!.taskId);
    }
  }

  private requireTask(taskId: string): TransferTask {
    const task = this.transferTasks.get(taskId);
    if (!task) throw new Error(`传输任务不存在: ${taskId}`);
    return task;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const error = new Error('传输已取消');
    error.name = 'AbortError';
    throw error;
  }

  private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeout);
        const error = new Error('传输已取消');
        error.name = 'AbortError';
        reject(error);
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} 超时`)), this.metadataTimeoutMs);
    });
    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'));
  }

  private isNotFoundError(error: any): boolean {
    return error?.code === 'ENOENT' || error?.code === 2 || String(error?.message).includes('No such file');
  }

  private isFinalTaskStatus(status: TransferTask['status']): boolean {
    return ['completed', 'failed', 'partially-completed', 'cancelled'].includes(status);
  }

  private isFinalSubTaskStatus(status: TransferSubTask['status']): boolean {
    return ['completed', 'failed', 'cancelled'].includes(status);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
