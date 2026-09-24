import { Request, Response } from 'express';
import path from 'path';
import { clientStates, sftpService } from '../websocket/state';
import * as archiver from 'archiver';
import { SFTPWrapper } from 'ssh2';
import { ClientState } from '../websocket/types';
import { buildAttachmentContentDisposition } from '../utils/content-disposition';

const DOWNLOAD_METADATA_TIMEOUT_MS = 60000;
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 120000;

const withTimeout = async <T>(operation: Promise<T>, message: string): Promise<T> => {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), DOWNLOAD_METADATA_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
};
/**
 * 处理文件下载请求 (GET /api/v1/sftp/download)
 */
export const downloadFile = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    const connectionId = req.query.connectionId as string; // 从查询参数获取
    const remotePath = req.query.remotePath as string;   // 从查询参数获取

    // 参数验证
    if (!userId) {
        res.status(401).json({ message: '未授权：需要登录。' });
        return;
    }
    if (!connectionId || !remotePath) {
        res.status(400).json({ message: '缺少必要的查询参数 (connectionId, remotePath)。' });
        return;
    }

    console.log(`SFTP 下载请求：用户 ${userId}, 连接 ${connectionId}, 路径 ${remotePath}`);

    // --- 修改：查找与 userId 和 connectionId 匹配的活动 SFTP 会话 ---
    let targetState: ClientState | null = null;
    const targetDbConnectionId = parseInt(connectionId, 10); // 将查询参数字符串转换为数字

    if (isNaN(targetDbConnectionId)) {
        res.status(400).json({ message: '无效的 connectionId。' });
        return;
    }

    console.log(`SFTP 下载：正在查找用户 ${userId} 且连接 ID 为 ${targetDbConnectionId} 的会话...`);
    for (const [sessionId, state] of clientStates.entries()) {
        // 检查 userId 和 dbConnectionId 是否都匹配，并且 sftp 实例存在
        if (state.ws.userId === userId && state.dbConnectionId === targetDbConnectionId && state.sftp) {
            targetState = state;
            console.log(`SFTP 下载：找到匹配的会话 (Session ID: ${sessionId})。`);
            break;
        }
    }

    if (!targetState || !targetState.sftp) {
        console.warn(`SFTP 下载失败：未找到用户 ${userId} 且连接 ID 为 ${targetDbConnectionId} 的活动 SFTP 会话。`);
        res.status(404).json({ message: '未找到指定的活动 SFTP 会话。请确保目标连接处于活动状态。' });
        return;
    }

    const userSftpSession = targetState.sftp; // 获取正确的 SFTP 实例
    const targetSessionId = Array.from(clientStates.entries()).find(([, state]) => state === targetState)?.[0];
    if (targetSessionId) sftpService.beginSessionActivity(targetSessionId);
    let activityFinished = false;
    const finishActivity = () => {
        if (activityFinished) return;
        activityFinished = true;
        if (targetSessionId) sftpService.endSessionActivity(targetSessionId);
    };
    res.once('finish', finishActivity);
    res.once('close', finishActivity);

    try {
        // 获取文件状态以确定文件大小（可选，但有助于设置 Content-Length）
        const stats = await withTimeout(new Promise<import('ssh2').Stats>((resolve, reject) => {
            // +++ 修正类型注解 +++
            userSftpSession!.lstat(remotePath, (err: Error | undefined, stats: import('ssh2').Stats) => {
                if (err) return reject(err);
                resolve(stats);
            });
        }), '读取远程文件信息超时');

        if (!stats.isFile()) {
            res.status(400).json({ message: '指定的路径不是一个文件。' });
            return;
        }

        // 设置响应头
        res.setHeader('Content-Disposition', buildAttachmentContentDisposition(path.basename(remotePath))); // 建议浏览器下载的文件名
        res.setHeader('Content-Type', 'application/octet-stream'); // 通用二进制类型
        if (stats.size) {
            res.setHeader('Content-Length', stats.size.toString());
        }

        // 创建可读流并 pipe 到响应对象
        const readStream = userSftpSession.createReadStream(remotePath);
        let inactivityTimeout: NodeJS.Timeout;
        const resetInactivityTimeout = () => {
            clearTimeout(inactivityTimeout);
            inactivityTimeout = setTimeout(() => {
                readStream.destroy(new Error('文件下载超过 2 分钟没有收到数据'));
            }, DOWNLOAD_INACTIVITY_TIMEOUT_MS);
        };

        readStream.on('error', (err: Error) => { // 添加 Error 类型注解
            clearTimeout(inactivityTimeout);
            console.error(`SFTP 读取流错误 (用户 ${userId}, 路径 ${remotePath}):`, err);
            // 如果响应头还没发送，可以发送错误状态码
            if (!res.headersSent) {
                res.status(500).json({ message: `读取远程文件失败: ${err.message}` });
            } else {
                // 如果头已发送，只能尝试结束响应
                res.end();
            }
        });
        readStream.on('data', resetInactivityTimeout);
        readStream.on('end', () => clearTimeout(inactivityTimeout));

        resetInactivityTimeout();
        readStream.pipe(res); // 将文件流直接传输给客户端

        // 监听响应对象的 close 事件，确保流被正确关闭 (虽然 pipe 通常会处理)
        res.on('close', () => {
            clearTimeout(inactivityTimeout);
            if (!readStream.destroyed) readStream.destroy();
            console.log(`SFTP 下载流关闭 (用户 ${userId}, 路径 ${remotePath})`);

        });

        console.log(`SFTP 开始下载 (用户 ${userId}, 路径 ${remotePath})`);

    } catch (error: any) {
        console.error(`SFTP 下载处理失败 (用户 ${userId}, 路径 ${remotePath}):`, error);
        if (!res.headersSent) {
            if (error.message?.includes('No such file')) {
                 res.status(404).json({ message: '远程文件未找到。' });
            } else {
                 res.status(500).json({ message: `处理下载请求时出错: ${error.message}` });
            }
        }
    }
};


/**
 * 处理文件夹下载请求 (GET /api/v1/sftp/download-directory)
 */
export const downloadDirectory = async (req: Request, res: Response): Promise<void> => {
    const userId = req.session.userId;
    const connectionId = req.query.connectionId as string; // 从查询参数获取
    const remotePath = req.query.remotePath as string;   // 从查询参数获取

    // 参数验证
    if (!userId) {
        res.status(401).json({ message: '未授权：需要登录。' });
        return;
    }
    if (!connectionId || !remotePath) {
        res.status(400).json({ message: '缺少必要的查询参数 (connectionId, remotePath)。' });
        return;
    }

    console.log(`SFTP 文件夹下载请求：用户 ${userId}, 连接 ${connectionId}, 路径 ${remotePath}`);

    // --- 修改：查找与 userId 和 connectionId 匹配的活动 SFTP 会话 ---
    let targetState: ClientState | null = null;
    const targetDbConnectionId = parseInt(connectionId, 10); // 将查询参数字符串转换为数字

    if (isNaN(targetDbConnectionId)) {
        res.status(400).json({ message: '无效的 connectionId。' });
        return;
    }

    console.log(`SFTP 文件夹下载：正在查找用户 ${userId} 且连接 ID 为 ${targetDbConnectionId} 的会话...`);
    for (const [sessionId, state] of clientStates.entries()) {
        // 检查 userId 和 dbConnectionId 是否都匹配，并且 sftp 实例存在
        if (state.ws.userId === userId && state.dbConnectionId === targetDbConnectionId && state.sftp) {
            targetState = state;
            console.log(`SFTP 文件夹下载：找到匹配的会话 (Session ID: ${sessionId})。`);
            break;
        }
    }

    if (!targetState || !targetState.sftp) {
        console.warn(`SFTP 文件夹下载失败：未找到用户 ${userId} 且连接 ID 为 ${targetDbConnectionId} 的活动 SFTP 会话。`);
        res.status(404).json({ message: '未找到指定的活动 SFTP 会话。请确保目标连接处于活动状态。' });
        return;
    }

    const userSftpSession = targetState.sftp; // 获取正确的 SFTP 实例
    const targetSessionId = Array.from(clientStates.entries()).find(([, state]) => state === targetState)?.[0];
    if (targetSessionId) sftpService.beginSessionActivity(targetSessionId);
    let activityFinished = false;
    const finishActivity = () => {
        if (activityFinished) return;
        activityFinished = true;
        if (targetSessionId) sftpService.endSessionActivity(targetSessionId);
    };
    res.once('finish', finishActivity);
    res.once('close', finishActivity);

    try {
        // 1. 验证路径是否为目录
        const stats = await withTimeout(new Promise<import('ssh2').Stats>((resolve, reject) => {
             // +++ 修正类型注解 +++
            userSftpSession!.lstat(remotePath, (err: Error | undefined, stats: import('ssh2').Stats) => {
                if (err) return reject(err);
                resolve(stats);
            });
        }), '读取远程目录信息超时');

        if (!stats.isDirectory()) {
            res.status(400).json({ message: '指定的路径不是一个目录。' });
            return;
        }

        // 2. 设置响应头
        // --- 修正：更健壮地生成压缩包名称 ---
        let baseName = path.basename(remotePath);
        // 处理根目录或路径以斜杠结尾的特殊情况
        if (!baseName || baseName === '/') {
            baseName = 'download'; // 如果 basename 为空或只是 '/'，使用默认名称
        }
        // 确保 basename 本身不包含尾部斜杠（尽管 path.basename 通常会处理）
        baseName = baseName.replace(/\/$/, '');
        const archiveName = `${baseName}.zip`; // 拼接 .zip 后缀
        // --- 结束修正 ---
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', buildAttachmentContentDisposition(archiveName)); // 使用修正后的名称

        // 3. 创建 Archiver 实例
        const archive = archiver.create('zip', {
            zlib: { level: 9 } // 设置压缩级别 (可选)
        });
        let inactivityTimeout: NodeJS.Timeout;
        const resetInactivityTimeout = () => {
            clearTimeout(inactivityTimeout);
            inactivityTimeout = setTimeout(() => {
                archive.abort();
                if (!res.destroyed) res.destroy(new Error('文件夹下载超过 2 分钟没有产生数据'));
            }, DOWNLOAD_INACTIVITY_TIMEOUT_MS);
        };

        // 监听错误事件
        archive.on('warning', (err: Error) => {
            console.warn(`Archiver warning (用户 ${userId}, 路径 ${remotePath}):`, err);
        });
        archive.on('error', (err: Error) => {
            clearTimeout(inactivityTimeout);
            console.error(`Archiver error (用户 ${userId}, 路径 ${remotePath}):`, err);
            // 尝试发送错误响应，如果头还没发送
            if (!res.headersSent) {
                res.status(500).json({ message: `创建压缩文件时出错: ${err.message}` });
            } else {
                res.end(); // 否则尝试结束响应
            }
        });
        archive.on('data', resetInactivityTimeout);
        res.once('finish', () => clearTimeout(inactivityTimeout));
        res.once('close', () => {
            clearTimeout(inactivityTimeout);
            if (!archive.destroyed) archive.abort();
        });

        // 将 Archiver 输出流 pipe 到 HTTP 响应流
        resetInactivityTimeout();
        archive.pipe(res);

        // 4. 递归添加文件/目录到 archive (核心逻辑)
        //    这部分需要一个辅助函数来处理 SFTP 递归和 Archiver 添加
        const addDirectoryToArchive = async (sftp: SFTPWrapper, dirPath: string, archivePath: string) => { // 使用导入的 SFTPWrapper
            // 移除 list 的显式类型注解 FileEntry[]，让 TypeScript 推断
            const entries = await withTimeout(new Promise<any[]>((resolve, reject) => { // 使用 any[] 作为 Promise 类型，或更具体的推断类型
                sftp.readdir(dirPath, (err: Error | undefined, list) => { // 移除 list 的类型注解
                    if (err) return reject(err);
                    // 可以在这里检查 list 的结构，但暂时依赖推断
                    resolve(list);
                });
            }), `读取远程目录 ${dirPath} 超时`);

            for (const entry of entries) {
                const currentRemotePath = path.posix.join(dirPath, entry.filename); // 使用 posix.join 处理路径
                const currentArchivePath = path.posix.join(archivePath, entry.filename);

                if (entry.attrs.isDirectory()) {
                    // 递归添加子目录
                    // 使用 Buffer.from('') 代替 null
                    archive.append(Buffer.from(''), { name: currentArchivePath + '/' });
                    await addDirectoryToArchive(sftp, currentRemotePath, currentArchivePath);
                } else if (entry.attrs.isFile()) {
                    // 添加文件流
                    const fileStream = sftp.createReadStream(currentRemotePath);
                    archive.append(fileStream, { name: currentArchivePath });
                    // 注意：需要处理 fileStream 的错误事件吗？Archiver 应该会处理？待验证。
                     fileStream.on('error', (streamErr: Error) => { // 添加类型注解
                         console.error(`Error reading file stream ${currentRemotePath}:`, streamErr);
                         // 如何通知 Archiver 或中断？ Archiver 的 error 事件应该会捕获？
                         if (!archive.destroyed) { // 检查 archive 是否已被销毁
                            archive.abort(); // 尝试终止 archive
                         }
                     });
                }
            }
        };

        // 开始添加根目录内容
        await addDirectoryToArchive(userSftpSession, remotePath, ''); // 归档路径从根开始

        // 5. 完成归档
        await archive.finalize();

        console.log(`SFTP 文件夹下载完成 (用户 ${userId}, 路径 ${remotePath})`);

    } catch (error: any) {
        console.error(`SFTP 文件夹下载处理失败 (用户 ${userId}, 路径 ${remotePath}):`, error);
        if (!res.headersSent) {
            if (error.code === 'ENOENT' || error.message?.includes('No such file')) { // 检查 SFTP 错误码或消息
                 res.status(404).json({ message: '远程目录未找到。' });
            } else {
                 res.status(500).json({ message: `处理文件夹下载请求时出错: ${error.message}` });
            }
        } else {
            res.end(); // 如果头已发送，尝试结束响应
        }
    }
};
