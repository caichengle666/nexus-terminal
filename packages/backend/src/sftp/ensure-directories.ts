/**
 * `mkdir -p` 的 SFTP 实现（移植自上游 cb310dc7）：逐级 mkdir，已存在且确实是目录就跳过。
 *
 * - SFTP 的 mkdir 不递归，`./a/b/1.txt` 这种中间层级不存在的路径必须逐级建。
 * - 不能把「已存在」一律当成功：中间被同名**文件**挡住时必须报错，
 *   否则会出现「目录显示建成、文件写不进去」的半截状态。
 * - 纯 SFTP 协议操作，不拼 shell 命令，路径里有什么字符都不需要转义。
 */
export interface MkdirCapableSftp {
    mkdir(path: string, callback: (err?: Error | null) => void): void;
    stat(path: string, callback: (err: Error | undefined | null, stats: { isDirectory(): boolean }) => void): void;
}

export const ensureRemoteDirectories = (sftp: MkdirCapableSftp, targetDir: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        if (!targetDir.startsWith('/')) {
            reject(new Error(`必须是绝对路径: ${targetDir}`));
            return;
        }
        const segments = targetDir.split('/').filter(Boolean);
        if (segments.some((seg) => seg === '.' || seg === '..' || seg.includes('\0'))) {
            reject(new Error(`路径包含非法片段: ${targetDir}`));
            return;
        }
        const step = (index: number): void => {
            if (index >= segments.length) {
                resolve();
                return;
            }
            const current = '/' + segments.slice(0, index + 1).join('/');
            sftp.mkdir(current, (err) => {
                if (!err) {
                    step(index + 1);
                    return;
                }
                // 已存在（或无权创建）：只有确认它是目录才继续往下
                sftp.stat(current, (statErr, stats) => {
                    if (!statErr && stats && stats.isDirectory()) {
                        step(index + 1);
                        return;
                    }
                    reject(err);
                });
            });
        };
        step(0);
    });

/** 取父目录（`/a/b` → `/a`，`/a` → `/`） */
export const parentRemoteDir = (path: string): string => path.substring(0, path.lastIndexOf('/')) || '/';
