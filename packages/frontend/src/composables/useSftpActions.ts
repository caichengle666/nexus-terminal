import { ref, reactive, computed, markRaw, type Ref, type ComputedRef } from 'vue';
import type { FileListItem, FileAttributes, EditorFileContent, SftpReadFileSuccessPayload, SftpReadFileRequestPayload } from '../types/sftp.types';
import type { WebSocketMessage, MessagePayload, MessageHandler } from '../types/websocket.types';

import { useUiNotificationsStore } from '../stores/uiNotifications.store'; 
import { resolveRemotePath, parentOfRemotePath } from '../utils/pathUtils';

/**
 * @interface WebSocketDependencies
 * @description Defines the necessary functions and state required from a WebSocket manager instance.
 */
export interface WebSocketDependencies {
    sendMessage: (message: WebSocketMessage) => void;
    onMessage: (type: string, handler: MessageHandler) => () => void;
    isConnected: ComputedRef<boolean>;
    isSftpReady: Readonly<Ref<boolean>>;
}

/**
* @interface SftpManagerInstance
* @description Defines the shape of the object returned by createSftpActionsManager.
*/
export interface SftpManagerInstance {
   // State
   fileList: Readonly<ComputedRef<FileListItem[]>>;
   /** A directory request is in flight (also during a silent background refresh); use it as the "busy" guard. */
   isLoading: Readonly<Ref<boolean>>;
   /** Show the loading placeholder: true only for visible loads, never for a silent background refresh. */
   isLoadingVisible: Readonly<ComputedRef<boolean>>;
   fileTree: Readonly<FileTreeNode>;
   initialLoadDone: Readonly<Ref<boolean>>;
   currentPath: Readonly<Ref<string>>;

   // Methods
   /** 返回的 Promise 在目录成功加载时 resolve(true)，失败（含重试耗尽）时 resolve(false)；从不 reject。 */
   /**
    * `options.background`: silent refresh (periodic / on tab focus). The current list stays
    * visible (no loading placeholder), and a failure neither retries nor shows a toast.
    */
   loadDirectory: (path: string, forceRefresh?: boolean, options?: { background?: boolean }) => Promise<boolean>;
   createDirectory: (newDirName: string) => void;
   /** 按完整路径创建目录；已存在等错误静默忽略（用于上传文件夹时补建空目录）。 */
   ensureDirectory: (fullPath: string) => void;
   createFile: (newFileName: string) => void;
   deleteItems: (items: FileListItem[]) => void;
   renameItem: (item: FileListItem, newName: string) => void;
   changePermissions: (item: FileListItem, mode: number, targets?: { owner?: string; group?: string }) => void;
   readFile: (path: string, encoding?: string) => Promise<SftpReadFileSuccessPayload>;
   writeFile: (path: string, content: string, encoding?: string) => Promise<void>;
   copyItems: (sourcePaths: string[], destinationDir: string) => void;
   moveItems: (sourcePaths: string[], destinationDir: string) => void;
   compressItems: (items: FileListItem[], format: 'zip' | 'targz' | 'tarbz2') => Promise<void>; // Assume async
   decompressItem: (item: FileListItem) => Promise<void>; // Assume async
   joinPath: (base: string, name: string) => string;
   setInitialLoadDone: (value: boolean) => void;

   // Cleanup function
   cleanup: () => void;
}

// Helper function
const generateRequestId = (): string => `req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
const DIRECTORY_LOAD_TIMEOUT_MS = 75000;
const DIRECTORY_REQUEST_COALESCE_MS = 250;
const DIRECTORY_RETRY_BACKOFFS_MS = [0, 1500, 4000, 9000];
const MAX_DIRECTORY_RETRY_ATTEMPTS = DIRECTORY_RETRY_BACKOFFS_MS.length;
// 由 ensureDirectory 发出的 mkdir 请求：失败时不弹错误（多个实例共享同一 WebSocket，所以放在模块级）
const silentMkdirRequestIds = new Set<string>();

// Helper function
const joinPath = (base: string, name: string): string => {
    if (base === '/') return `/${name}`;
    return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
};

// Helper function
const sortFiles = (a: FileListItem, b: FileListItem): number => {
    if (a.attrs.isDirectory && !b.attrs.isDirectory) return -1;
    if (!a.attrs.isDirectory && b.attrs.isDirectory) return 1;
    return a.filename.localeCompare(b.filename);
};

// *** 文件树节点接口 ***
export interface FileTreeNode {
    filename: string;
    longname: string; // 保留 longname 以便显示
    attrs: FileAttributes; // 使用正确的类型 FileAttributes
    children: FileTreeNode[] | null; // 子节点数组，null 表示未加载
    childrenLoaded: boolean; // 标记子节点是否已加载
    // 可以添加其他需要的状态，例如 isLoadingChildren
}

const isSameFileAttrs = (a: FileAttributes, b: FileAttributes): boolean =>
    a.size === b.size && a.mtime === b.mtime && a.mode === b.mode
    && a.uid === b.uid && a.gid === b.gid
    && a.isDirectory === b.isDirectory && a.isFile === b.isFile && a.isSymbolicLink === b.isSymbolicLink;

/**
 * 创建并管理单个 SFTP 会话的操作。
 * 每个实例对应一个会话 (Session) 并依赖于一个 WebSocket 管理器实例。
 *
 * @param {string} sessionId - 此 SFTP 管理器关联的会话 ID (用于日志记录)。
 * @param {Ref<string>} currentPathRef - 一个外部 ref，用于跟踪和更新当前目录路径。
 * @param {WebSocketDependencies} wsDeps - 从对应的 WebSocket 管理器实例注入的依赖项。
 * @param {Function} t - i18n 翻译函数，从父组件传入
 * @returns 一个包含状态、方法和清理函数的 SFTP 操作管理器对象。
 */
export function createSftpActionsManager(
    sessionId: string,
    currentPathRef: Ref<string>,
    wsDeps: WebSocketDependencies,
    t: Function
): SftpManagerInstance { // Add explicit return type
    const { sendMessage, onMessage, isConnected, isSftpReady } = wsDeps; // 使用注入的依赖

    const isLoading = ref<boolean>(false);
    // The in-flight request is a silent background refresh (see loadDirectory options).
    const activeLoadSilent = ref<boolean>(false);
    const isLoadingVisible = computed(() => isLoading.value && !activeLoadSilent.value);
    const loadingRequestId = ref<string | null>(null); // 跟踪当前加载请求 ID
    const lastDirectoryRequestAt = { current: 0 };
    const lastDirectoryRequestPath = { current: '' };
    const pendingDirectoryPath = { current: '/' };
    const pendingDirectoryRequest = { current: null as { path: string; forceRefresh: boolean; background: boolean } | null };
    const directoryRetryCount = { current: 0 };
    // 等待某个目录加载结果的调用方（loadDirectory 返回的 Promise）
    const directoryWaiters: Array<{ path: string; resolve: (ok: boolean) => void }> = [];
    const settleDirectoryWaiters = (path: string | null, ok: boolean) => {
        for (let i = directoryWaiters.length - 1; i >= 0; i -= 1) {
            if (path === null || directoryWaiters[i].path === path) {
                directoryWaiters[i].resolve(ok);
                directoryWaiters.splice(i, 1);
            }
        }
    };
    let directoryLoadTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const instanceSessionId = sessionId; // 保存会话 ID 用于日志
    const uiNotificationsStore = useUiNotificationsStore(); // 初始化 UI 通知 store
    const initialLoadDone = ref<boolean>(false); // +++ 跟踪此实例是否已完成初始加载 +++
    const fileOperationTaskIds = new Map<string, string>();

    const beginFileOperationTask = (title: string, message: string, requestId: string) => {
        const taskId = uiNotificationsStore.addTaskNotification({
            id: `sftp-operation:${instanceSessionId}:${requestId}`,
            kind: 'file-operation',
            title,
            message,
            status: 'running',
            progress: 0,
        });
        fileOperationTaskIds.set(requestId, taskId);
        return taskId;
    };

    const finishFileOperationTask = (requestId: string, status: 'success' | 'error' | 'cancelled', message: string) => {
        const taskId = fileOperationTaskIds.get(requestId);
        if (!taskId) return;
        fileOperationTaskIds.delete(requestId);
        uiNotificationsStore.updateTaskNotification(taskId, { status, progress: 100, message });
    };

    // 用于存储注销函数的数组
    const unregisterCallbacks: (() => void)[] = [];

    const clearDirectoryLoadTimeout = () => {
        if (directoryLoadTimeoutId) clearTimeout(directoryLoadTimeoutId);
        directoryLoadTimeoutId = null;
    };

    const resetDirectoryLoading = () => {
        clearDirectoryLoadTimeout();
        isLoading.value = false;
        activeLoadSilent.value = false;
        loadingRequestId.value = null;
    };

    // *** 响应式文件树 ***
    const fileTree = reactive<FileTreeNode>({
        filename: '/', // 根节点代表根目录
        longname: '/',
        attrs: { // 模拟根目录的属性
            isDirectory: true,
            isFile: false,
            isSymbolicLink: false,
            size: 0,
            mtime: 0,
            atime: 0,
            uid: 0,
            gid: 0,
            mode: 0o755 // 典型目录权限
            // 移除不存在的 permissions 属性
        },
        children: null, // 初始时子节点未加载
        childrenLoaded: false,
    });

    // 清理函数，用于注销所有消息处理器
    const cleanup = () => {
        console.log(`[SFTP ${instanceSessionId}] Cleaning up message handlers.`);
        resetDirectoryLoading();
        pendingDirectoryRequest.current = null;
        settleDirectoryWaiters(null, false);
        fileOperationTaskIds.clear();
        unregisterCallbacks.forEach(cb => cb());
        unregisterCallbacks.length = 0; // 清空数组
    };

    // --- Action Methods ---

    // *** 修改：辅助函数 - 在文件树中查找节点，可选创建占位符 ***
    const findNodeByPath = (root: FileTreeNode, path: string, createIfMissing: boolean = false): FileTreeNode | null => {
        if (path === '/') return root;
        const parts = path.split('/').filter(p => p);
        let currentNode: FileTreeNode = root; // Start from root

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            let nextNode: FileTreeNode | undefined = undefined;

            // Check if children array exists and try to find the node
            if (currentNode.children) {
                nextNode = currentNode.children.find(child => child.filename === part);
                // If node not found in existing (potentially partial) children list
                if (!nextNode) {
                    if (!currentNode.childrenLoaded && !createIfMissing) {
                        // Parent not fully loaded, node not found in partial list, and not creating -> Fail
                        console.log(`[SFTP ${instanceSessionId}] findNodeByPath: Node ${part} not found in partially loaded children of ${currentNode.filename}.`);
                        return null;
                    }
                    if (currentNode.childrenLoaded && !createIfMissing) {
                         // Parent fully loaded, node definitively not found, and not creating -> Fail
                         console.log(`[SFTP ${instanceSessionId}] findNodeByPath: Node ${part} not found in fully loaded children of ${currentNode.filename}.`);
                         return null;
                    }
                    // If createIfMissing is true, we proceed to the creation block below.
                }
                // If nextNode was found, we will proceed with it after the 'if (!nextNode)' block.

            } else if (currentNode.children === null) {
                 // Children is null (definitely not loaded)
                 if (!createIfMissing) {
                     console.log(`[SFTP ${instanceSessionId}] findNodeByPath: Children of ${currentNode.filename} are null, cannot find ${part}.`);
                     return null; // Cannot proceed without creating
                 }
                 // If creating is allowed, initialize children array for the placeholder
                 console.log(`[SFTP ${instanceSessionId}] findNodeByPath: Children of ${currentNode.filename} are null, will create placeholder for ${part}.`);
                 currentNode.children = [];
                 // nextNode remains undefined here, so the creation block below will execute.

            } else if (!currentNode.attrs.isDirectory) { // currentNode.children might be [] for a file
                 // It's a file, cannot have children
                 console.warn(`[SFTP ${instanceSessionId}] findNodeByPath: Attempted to find child '${part}' under a file node '${currentNode.filename}'.`);
                 return null;
            }


            if (!nextNode) {
                // Node not found among loaded children, or children were null
                if (createIfMissing) {
                    // Create a placeholder node
                    const currentPath = '/' + parts.slice(0, i).join('/');
                    const placeholderAttrs: FileAttributes = { // Basic directory attributes
                        isDirectory: true, isFile: false, isSymbolicLink: false,
                        size: 0, mtime: 0, atime: 0, uid: 0, gid: 0, mode: 0o755
                    };
                    nextNode = reactive({ // Use reactive for placeholders too
                        filename: part,
                        longname: part, // Placeholder longname
                        attrs: placeholderAttrs,
                        children: null, // Placeholder children are null initially
                        childrenLoaded: false,
                    });
                    // Add the placeholder to the parent's children array
                    if (!currentNode.children) { // Should have been initialized above if null
                         currentNode.children = [];
                    }
                    // Add and sort (optional, but good practice)
                    currentNode.children.push(nextNode);
                    currentNode.children.sort((a, b) => sortFiles(a as any, b as any));
                    console.log(`[SFTP ${instanceSessionId}] findNodeByPath: Created placeholder node for ${part} under ${currentNode.filename}`);
                } else {
                    // Not creating, and node not found
                    console.log(`[SFTP ${instanceSessionId}] findNodeByPath: Node ${part} not found under ${currentNode.filename} and createIfMissing is false.`);
                    return null;
                }
            }
             // Move to the next node (found or created)
             if (!nextNode) {
                 // Should not happen if createIfMissing is true and placeholder creation worked
                 console.error(`[SFTP ${instanceSessionId}] findNodeByPath: Logic error - nextNode is still undefined for part '${part}'.`);
                 return null;
             }
            currentNode = nextNode;
        }

        return currentNode; // Return the final node found or created
    };

    const scheduleDirectoryRetry = (path: string, reason: string) => {
        const silent = activeLoadSilent.value;
        resetDirectoryLoading();
        if (silent) {
            // A failed background refresh keeps the list as it is: no retry storm, no toast.
            pendingDirectoryPath.current = currentPathRef.value;
            directoryRetryCount.current = 0;
            settleDirectoryWaiters(path, false);
            console.warn(`[SFTP ${instanceSessionId}] 后台刷新目录 ${path} 失败（已忽略）：${reason}`);
            runQueuedDirectoryRequest(null);
            return;
        }
        pendingDirectoryPath.current = path;
        if (!isConnected.value) {
            resetDirectoryLoading();
            settleDirectoryWaiters(path, false);
            return;
        }
        if (directoryRetryCount.current >= MAX_DIRECTORY_RETRY_ATTEMPTS) {
            resetDirectoryLoading();
            // 重试耗尽：不要让 sftp_ready 再次请求这个失败的路径
            pendingDirectoryPath.current = currentPathRef.value;
            settleDirectoryWaiters(path, false);
            console.error(`[SFTP ${instanceSessionId}] 加载目录 ${path} 已重试 ${MAX_DIRECTORY_RETRY_ATTEMPTS} 次，停止重试。`);
            uiNotificationsStore.showError(`${t('fileManager.errors.loadDirectoryFailed')}: ${reason}`);
            directoryRetryCount.current = 0;
            return;
        }
        const delayMs = DIRECTORY_RETRY_BACKOFFS_MS[Math.min(directoryRetryCount.current, DIRECTORY_RETRY_BACKOFFS_MS.length - 1)];
        directoryRetryCount.current += 1;
        console.warn(`[SFTP ${instanceSessionId}] 目录操作将于 ${delayMs}ms 后重试 (第 ${directoryRetryCount.current}/${MAX_DIRECTORY_RETRY_ATTEMPTS} 次)。原因: ${reason}`);
        directoryLoadTimeoutId = setTimeout(() => {
            directoryLoadTimeoutId = null;
            if (loadingRequestId.value) return;
            if (!isConnected.value) { resetDirectoryLoading(); return; }
            if (!isSftpReady.value) {
                return;
            }
            loadDirectoryInternal(path, false);
        }, delayMs);
    };

    // Runs a request that was queued while another one was in flight.
    const runQueuedDirectoryRequest = (completedPath: string | null) => {
        const queuedRequest = pendingDirectoryRequest.current;
        pendingDirectoryRequest.current = null;
        if (queuedRequest && isConnected.value
            && (queuedRequest.path !== completedPath || queuedRequest.forceRefresh)) {
            loadDirectoryInternal(queuedRequest.path, queuedRequest.forceRefresh, queuedRequest.background);
        }
    };

    const loadDirectoryInternal = (path: string, forceRefresh: boolean, background = false) => {
        if (background && isLoading.value) return; // something is already loading; a silent refresh is redundant
        if (!background) pendingDirectoryPath.current = path;
        const targetNode = findNodeByPath(fileTree, path);

        if (targetNode && targetNode.childrenLoaded && !forceRefresh) {
            console.log(`[SFTP ${instanceSessionId}] 使用文件树缓存加载目录: ${path}`);
            isLoading.value = false;
            currentPathRef.value = path;
            directoryRetryCount.current = 0;
            settleDirectoryWaiters(path, true);
            return;
        }

        if (!isSftpReady.value) {
            resetDirectoryLoading();
            if (isConnected.value) {
                console.warn(`[SFTP ${instanceSessionId}] SFTP 未就绪，正在请求重新初始化。`);
                sendMessage({ type: 'sftp:initialize', payload: {} });
            } else {
                if (!background) uiNotificationsStore.showError(t('fileManager.errors.sftpNotReady'));
                settleDirectoryWaiters(path, false);
            }
            return;
        }
        if (isLoading.value) {
            const replacedRequest = pendingDirectoryRequest.current;
            if (replacedRequest && replacedRequest.path !== path) {
                // 被新的排队请求替换掉的路径不会再加载
                settleDirectoryWaiters(replacedRequest.path, false);
            }
            pendingDirectoryRequest.current = { path, forceRefresh, background: false };
            // A user action waits behind a silent refresh: show the loading state from now on.
            activeLoadSilent.value = false;
            console.warn(`[SFTP ${instanceSessionId}] 当前目录请求仍在进行，${forceRefresh ? '刷新' : '目录切换'}将排队等待。`);
            return;
        }

        console.log(`[SFTP ${instanceSessionId}] ${forceRefresh ? '强制' : ''}加载目录: ${path}`);
        isLoading.value = true;
        activeLoadSilent.value = background;
        const requestId = generateRequestId();
        loadingRequestId.value = requestId;
        lastDirectoryRequestAt.current = Date.now();
        lastDirectoryRequestPath.current = path;
        sendMessage({ type: 'sftp:readdir', requestId: requestId, payload: { path } });
        directoryLoadTimeoutId = setTimeout(() => {
            if (loadingRequestId.value !== requestId) return;
            console.error(`[SFTP ${instanceSessionId}] 加载目录 ${path} 超时。`);
            scheduleDirectoryRetry(path, '请求超时'); // resets the loading state itself (and reads activeLoadSilent first)
        }, DIRECTORY_LOAD_TIMEOUT_MS);
    };

    const loadDirectory = (path: string, forceRefresh: boolean = false, options: { background?: boolean } = {}): Promise<boolean> => {
        const background = options.background === true;
        if (background && loadingRequestId.value) return Promise.resolve(false);
        const now = Date.now();
        if (!forceRefresh && !loadingRequestId.value
            && lastDirectoryRequestPath.current === path
            && (now - lastDirectoryRequestAt.current) < DIRECTORY_REQUEST_COALESCE_MS) {
            console.warn(`[SFTP ${instanceSessionId}] 目录 ${path} 请求过快，已合并。`);
            return Promise.resolve(currentPathRef.value === path);
        }
        const result = new Promise<boolean>(resolve => {
            directoryWaiters.push({ path, resolve });
        });
        if (!loadingRequestId.value) directoryRetryCount.current = 0;
        loadDirectoryInternal(path, forceRefresh, background);
        return result;
    };

    /**
     * 新建目录。`target` 既可以是名字，也可以是路径（`./a/b`、`../c`、`/etc/d`）：
     * 先按当前目录解析成绝对路径，再让后端逐级补齐缺失的父目录（移植自上游 cb310dc7）。
     */
    const createDirectory = (target: string) => {
        if (!isSftpReady.value) {
            uiNotificationsStore.showError(t('fileManager.errors.sftpNotReady'));
            console.warn(`[SFTP ${instanceSessionId}] 尝试创建目录 ${target} 但 SFTP 未就绪。`);
            return;
        }
        const newFolderPath = resolveRemotePath(currentPathRef.value, target);
        if (newFolderPath === '/') {
            uiNotificationsStore.showError(t('fileManager.errors.invalidName', '名称无效'));
            return;
        }
        const requestId = generateRequestId();
        trackCreateFeedback(requestId, newFolderPath);
        sendMessage({ type: 'sftp:mkdir', requestId: requestId, payload: { path: newFolderPath, createParents: true } });
    };

    const ensureDirectory = (fullPath: string) => {
        if (!isSftpReady.value) {
            console.warn(`[SFTP ${instanceSessionId}] 尝试创建目录 ${fullPath} 但 SFTP 未就绪。`);
            return;
        }
        const requestId = generateRequestId();
        silentMkdirRequestIds.add(requestId);
        // 兜底清理，避免请求无响应时 Set 无限增长
        setTimeout(() => silentMkdirRequestIds.delete(requestId), 120000);
        sendMessage({ type: 'sftp:mkdir', requestId, payload: { path: fullPath } });
    };

    /** 新建文件。同 `createDirectory`：支持相对 / 绝对路径，缺失的父目录由后端补建 */
    const createFile = (target: string) => {
        if (!isSftpReady.value) {
            uiNotificationsStore.showError(t('fileManager.errors.sftpNotReady'));
            console.warn(`[SFTP ${instanceSessionId}] 尝试创建文件 ${target} 但 SFTP 未就绪。`);
            return;
        }
        const newFilePath = resolveRemotePath(currentPathRef.value, target);
        if (newFilePath === '/' || /\/$/.test(target.trim())) {
            uiNotificationsStore.showError(t('fileManager.errors.invalidName', '名称无效'));
            return;
        }
        const requestId = generateRequestId();
        trackCreateFeedback(requestId, newFilePath);
        sendMessage({
            type: 'sftp:writefile',
            requestId: requestId,
            payload: { path: newFilePath, content: '', encoding: 'utf8', createParents: true }
        });
    };

    /**
     * 新建文件 / 文件夹的收尾反馈：建在当前目录里时列表会自己冒出来，不提示；
     * 建在 `./a/b/x`、`../y`、`/etc/z` 这种当前视图看不见的地方时，提示「已创建 <路径>」，
     * 并静默刷新当前目录（中间层级可能是这次才建出来的）。
     */
    const pendingCreateFeedback = new Map<string, string>();
    const trackCreateFeedback = (requestId: string, fullPath: string) => {
        pendingCreateFeedback.set(requestId, fullPath);
        // 兜底清理，避免请求无响应时 Map 无限增长
        setTimeout(() => pendingCreateFeedback.delete(requestId), 120000);
    };
    const notifyNestedCreate = (requestId: string | undefined) => {
        if (!requestId) return;
        const createdPath = pendingCreateFeedback.get(requestId);
        if (!createdPath) return; // 不是本实例发起的新建（如编辑器保存）
        pendingCreateFeedback.delete(requestId);
        if (parentOfRemotePath(createdPath) === currentPathRef.value) return;
        uiNotificationsStore.showSuccess(t('fileManager.notifications.createdAt', { path: createdPath }));
        loadDirectory(currentPathRef.value, true);
    };

    const deleteItems = (items: FileListItem[]) => {
        if (!isSftpReady.value) {
            uiNotificationsStore.showError(t('fileManager.errors.sftpNotReady'));
            console.warn(`[SFTP ${instanceSessionId}] 尝试删除项目但 SFTP 未就绪。`); // 日志改为中文
            return;
        }
        if (items.length === 0) return;
        items.forEach(item => {
            const targetPath = joinPath(currentPathRef.value, item.filename);
            const actionType = item.attrs.isDirectory ? 'sftp:rmdir' : 'sftp:unlink';
            const requestId = generateRequestId();
            sendMessage({ type: actionType, requestId: requestId, payload: { path: targetPath } });
        });
    };

    const renameItem = (item: FileListItem, newName: string) => {
        if (!isSftpReady.value) {
            uiNotificationsStore.showError(t('fileManager.errors.sftpNotReady'));
            console.warn(`[SFTP ${instanceSessionId}] 尝试重命名项目 ${item.filename} 但 SFTP 未就绪。`); // 日志改为中文
            return;
        }
        if (!newName || item.filename === newName) return;
        const oldPath = joinPath(currentPathRef.value, item.filename);
        // 检查 newName 是否已经是绝对路径 (来自拖拽移动)
        const newPath = newName.startsWith('/')
            ? newName // 如果是绝对路径，直接使用
            : joinPath(currentPathRef.value, newName); // 否则，视为相对路径并拼接
        const requestId = generateRequestId();
        sendMessage({ type: 'sftp:rename', requestId: requestId, payload: { oldPath, newPath } });
    };

    /**
     * 修改权限，可选顺带修改所有者 / 所属组。
     *
     * chmod 走 SFTP 原生（不经 shell）；chown 由后端执行 `chown` 命令（SFTP 的 chown 只认数字 uid/gid）。
     * 顺序是「chmod 成功后再发 chown」：权限没改成就丢弃待发的 chown，不留「所有者变了、权限没变」的半截状态。
     * 多个共享同一连接的文件管理器实例都会收到结果消息，只有发起方（pendingChownTargets / pendingChownRequestIds）处理。
     */
    const pendingChownTargets = new Map<string, { path: string; owner?: string; group?: string }>();
    const pendingChownRequestIds = new Set<string>();
    let chownSuccessCount = 0;
    let chownToastTimer: ReturnType<typeof setTimeout> | null = null;

    const changePermissions = (item: FileListItem, mode: number, targets?: { owner?: string; group?: string }) => {
        if (!isSftpReady.value) {
            uiNotificationsStore.showError(t('fileManager.errors.sftpNotReady'));
            console.warn(`[SFTP ${instanceSessionId}] 尝试修改 ${item.filename} 的权限但 SFTP 未就绪。`); // 日志改为中文
            return;
        }
        const targetPath = joinPath(currentPathRef.value, item.filename);
        const requestId = generateRequestId();
        const owner = (targets?.owner || '').trim();
        const group = (targets?.group || '').trim();
        if (owner || group) {
            pendingChownTargets.set(requestId, { path: targetPath, owner, group });
        }
        sendMessage({ type: 'sftp:chmod', requestId: requestId, payload: { path: targetPath, mode: mode } });
    };

    // readFile 和 writeFile 仍然返回 Promise，并在内部处理自己的消息监听器注销
    // --- 修改：接受可选 encoding 参数，返回包含 content 和 encodingUsed 的 Payload ---
    const readFile = (path: string, encoding?: string): Promise<SftpReadFileSuccessPayload> => {
        return new Promise((resolve, reject) => {
            if (!isSftpReady.value) {
                const errMsg = t('fileManager.errors.sftpNotReady');
                console.warn(`[SFTP ${instanceSessionId}] 尝试读取文件 ${path} 但 SFTP 未就绪。`);
                uiNotificationsStore.showError(errMsg);
                return reject(new Error(errMsg));
            }
            const requestId = generateRequestId();
            let unregisterSuccess: (() => void) | null = null;
            let unregisterError: (() => void) | null = null;

            const timeoutId = setTimeout(() => {
                unregisterSuccess?.();
                unregisterError?.();
                const errMsg = t('fileManager.errors.readFileTimeout');
                uiNotificationsStore.showError(errMsg);
                reject(new Error(errMsg));
            }, 20000); // 20 秒超时

            unregisterSuccess = onMessage('sftp:readfile:success', (payload: MessagePayload, message: WebSocketMessage) => {
                // +++ 修改：处理包含 rawContentBase64 和 encodingUsed 的新 payload +++
                const successPayload = payload as SftpReadFileSuccessPayload; // Type assertion remains valid
                if (message.requestId === requestId && message.path === path) {
                    clearTimeout(timeoutId);
                    unregisterSuccess?.();
                    unregisterError?.();
                    // Resolve with the new payload structure
                    resolve({ rawContentBase64: successPayload.rawContentBase64, encodingUsed: successPayload.encodingUsed });
                }
            });

            unregisterError = onMessage('sftp:readfile:error', (payload: MessagePayload, message: WebSocketMessage) => {
                 const errorPayload = payload as string;
                if (message.requestId === requestId && message.path === path) {
                    clearTimeout(timeoutId);
                    unregisterSuccess?.();
                    unregisterError?.();
                    const errorMsg = errorPayload || t('fileManager.errors.readFileFailed');
                    uiNotificationsStore.showError(`${t('fileManager.errors.readFileError')}: ${errorMsg}`);
                    reject(new Error(errorMsg));
                }
            });

            // --- 修改：在 payload 中包含可选的 encoding ---
            const requestPayload: SftpReadFileRequestPayload = { path };
            if (encoding) {
                requestPayload.encoding = encoding;
            }
            sendMessage({ type: 'sftp:readfile', requestId: requestId, payload: requestPayload });
        });
    };

     // --- 修改：接受可选 encoding 参数 ---
     const writeFile = (path: string, content: string, encoding?: string): Promise<void> => {
        return new Promise((resolve, reject) => {
            if (!isSftpReady.value) {
                 const errMsg = t('fileManager.errors.sftpNotReady');
                 console.warn(`[SFTP ${instanceSessionId}] 尝试写入文件 ${path} 但 SFTP 未就绪。`); // 日志改为中文
                 uiNotificationsStore.showError(errMsg);
                return reject(new Error(errMsg));
            }
            const requestId = generateRequestId();
            // --- 修改：使用传入的 encoding，默认为 utf8 ---
            const finalEncoding = encoding || 'utf8';
            let unregisterSuccess: (() => void) | null = null;
            let unregisterError: (() => void) | null = null;

            const timeoutId = setTimeout(() => {
                unregisterSuccess?.();
                unregisterError?.();
                const errMsg = t('fileManager.errors.saveTimeout');
                uiNotificationsStore.showError(errMsg);
                reject(new Error(errMsg));
            }, 20000); // 20 秒超时

            unregisterSuccess = onMessage('sftp:writefile:success', (payload: MessagePayload, message: WebSocketMessage) => {
                if (message.requestId === requestId && message.path === path) {
                    clearTimeout(timeoutId);
                    unregisterSuccess?.();
                    unregisterError?.();
                    resolve();
                }
            });

            unregisterError = onMessage('sftp:writefile:error', (payload: MessagePayload, message: WebSocketMessage) => {
                // 确保 payload 是期望的类型 (string)
                const errorPayload = payload as string;
                if (message.requestId === requestId && message.path === path) {
                    clearTimeout(timeoutId);
                    unregisterSuccess?.();
                    unregisterError?.();
                    const errorMsg = errorPayload || t('fileManager.errors.saveFailed'); // 使用 i18n
                    uiNotificationsStore.showError(errorMsg);
                    reject(new Error(errorMsg));
                }
            });

            sendMessage({
                type: 'sftp:writefile',
                requestId: requestId,
                // --- 修改：在 payload 中包含最终的编码 ---
                payload: { path, content, encoding: finalEncoding }
            });
        });
    };

    // +++ 复制项目 +++
    const copyItems = (sourcePaths: string[], destinationDir: string) => {
        if (!isSftpReady.value) {
            uiNotificationsStore.showError(t('fileManager.errors.sftpNotReady'));
            console.warn(`[SFTP ${instanceSessionId}] 尝试复制项目但 SFTP 未就绪。`);
            return;
        }
        if (sourcePaths.length === 0) return;
        const requestId = generateRequestId();
        beginFileOperationTask('文件复制', `正在复制 ${sourcePaths.length} 个项目到 ${destinationDir}`, requestId);
        sendMessage({
            type: 'sftp:copy',
            requestId: requestId,
            payload: { sources: sourcePaths, destination: destinationDir }
        });
        console.log(`[SFTP ${instanceSessionId}] 发送 sftp:copy 请求 (ID: ${requestId}) Sources: ${sourcePaths.join(', ')}, Dest: ${destinationDir}`);
        // 可选：显示一个“正在复制...”的通知
    };

    // +++ 移动项目 +++
    const moveItems = (sourcePaths: string[], destinationDir: string) => {
        if (!isSftpReady.value) {
            uiNotificationsStore.showError(t('fileManager.errors.sftpNotReady'));
            console.warn(`[SFTP ${instanceSessionId}] 尝试移动项目但 SFTP 未就绪。`);
            return;
        }
        if (sourcePaths.length === 0) return;
        // 可以在这里再次检查源目录和目标目录是否相同，虽然 FileManager.vue 也检查了
        // const sourceDir = sourcePaths[0].substring(0, sourcePaths[0].lastIndexOf('/')) || '/';
        // if (sourceDir === destinationDir) {
        //     uiNotificationsStore.showWarning(t('fileManager.warnings.moveSameDirectory'), { timeout: 3000 });
        //     return;
        // }
        const requestId = generateRequestId();
        beginFileOperationTask('文件移动', `正在移动 ${sourcePaths.length} 个项目到 ${destinationDir}`, requestId);
        sendMessage({
            type: 'sftp:move', // 使用 'sftp:move' 类型
            requestId: requestId,
            payload: { sources: sourcePaths, destination: destinationDir }
        });
         console.log(`[SFTP ${instanceSessionId}] 发送 sftp:move 请求 (ID: ${requestId}) Sources: ${sourcePaths.join(', ')}, Dest: ${destinationDir}`);
        // 可选：显示一个“正在移动...”的通知
   };

   const compressItems = (items: FileListItem[], format: 'zip' | 'targz' | 'tarbz2'): Promise<void> => {
       return new Promise((resolve, reject) => {
           if (!isSftpReady.value) {
               const errMsg = t('fileManager.errors.sftpNotReady');
               uiNotificationsStore.showError(errMsg);
               console.warn(`[SFTP ${instanceSessionId}] 尝试压缩项目但 SFTP 未就绪。`);
               return reject(new Error(errMsg));
           }
           const sourcePaths = items.map(item => joinPath(currentPathRef.value, item.filename));
           const requestId = generateRequestId();
           beginFileOperationTask('文件压缩', `正在压缩 ${items.length} 个项目`, requestId);
           const parentDir = currentPathRef.value;
           // --- 修改：使用更智能的压缩包命名 ---
           let archiveBaseName = 'archive';
           if (items.length === 1) {
               archiveBaseName = items[0].filename.split('.')[0]; // 使用第一个项目的文件名（不含扩展名）
           } else if (items.length > 1) {
               // 如果有多个项目，尝试使用共同的父目录名，或者保持 'archive'
               const parentFolderName = parentDir.split('/').pop();
               if (parentFolderName && parentFolderName !== 'root' && parentFolderName !== '') {
                    archiveBaseName = parentFolderName;
               }
           }
           const archiveName = `${archiveBaseName}.${format === 'targz' ? 'tar.gz' : (format === 'tarbz2' ? 'tar.bz2' : format)}`;
           
           const destinationPath = joinPath(parentDir, archiveName);

           let unregisterSuccess: (() => void) | null = null;
           let unregisterError: (() => void) | null = null;

           unregisterSuccess = onMessage('sftp:compress:success', (payload: MessagePayload, message: WebSocketMessage) => {
               if (message.requestId === requestId) {
                   unregisterSuccess?.();
                   unregisterError?.();
                   uiNotificationsStore.showSuccess(t('fileManager.notifications.compressSuccess', { name: archiveName })); // 使用 i18n
                   finishFileOperationTask(requestId, 'success', t('fileManager.notifications.compressSuccess', { name: archiveName }));
                   loadDirectory(currentPathRef.value, true); // 强制刷新当前目录
                   resolve();
               }
           });

           unregisterError = onMessage('sftp:compress:error', (payload: MessagePayload, message: WebSocketMessage) => {
               const errorPayload = payload as { error: string, details?: string };
               if (message.requestId === requestId) {
                   unregisterSuccess?.();
                   unregisterError?.();
                   const errorMsg = errorPayload.details || errorPayload.error || t('fileManager.errors.compressFailed'); // 基础错误信息
                   uiNotificationsStore.showError(t('fileManager.errors.compressErrorDetailed', { error: errorMsg })); // 使用 i18n 包装详细错误
                   finishFileOperationTask(requestId, 'error', errorMsg);
                   reject(new Error(errorMsg));
               }
           });

           console.log(`[SFTP ${instanceSessionId}] 发送 sftp:compress 请求 (ID: ${requestId}) Sources: ${sourcePaths.join(', ')}, Dest: ${destinationPath}, Format: ${format}`);
           sendMessage({
               type: 'sftp:compress',
               requestId: requestId,
               payload: { sources: sourcePaths, destination: destinationPath, format: format }
           });
       });
   };

   const decompressItem = (item: FileListItem): Promise<void> => {
       return new Promise((resolve, reject) => {
           if (!isSftpReady.value) {
               const errMsg = t('fileManager.errors.sftpNotReady');
               uiNotificationsStore.showError(errMsg);
               console.warn(`[SFTP ${instanceSessionId}] 尝试解压项目 ${item.filename} 但 SFTP 未就绪。`);
               return reject(new Error(errMsg));
           }
           const sourcePath = joinPath(currentPathRef.value, item.filename);
           const destinationDir = currentPathRef.value; // 默认解压到当前目录
           const requestId = generateRequestId();
           beginFileOperationTask('文件解压', `正在解压 ${item.filename}`, requestId);

           let unregisterSuccess: (() => void) | null = null;
           let unregisterError: (() => void) | null = null;

           unregisterSuccess = onMessage('sftp:decompress:success', (payload: MessagePayload, message: WebSocketMessage) => {
               if (message.requestId === requestId) {
                   unregisterSuccess?.();
                   unregisterError?.();
                   uiNotificationsStore.showSuccess(t('fileManager.notifications.decompressSuccess', { name: item.filename })); // 使用 i18n
                   finishFileOperationTask(requestId, 'success', t('fileManager.notifications.decompressSuccess', { name: item.filename }));
                   loadDirectory(currentPathRef.value, true); // 强制刷新当前目录
                   resolve();
               }
           });

           unregisterError = onMessage('sftp:decompress:error', (payload: MessagePayload, message: WebSocketMessage) => {
                const errorPayload = payload as { error: string, details?: string };
               if (message.requestId === requestId) {
                   unregisterSuccess?.();
                   unregisterError?.();
                   const errorMsg = errorPayload.details || errorPayload.error || t('fileManager.errors.decompressFailed'); // 基础错误信息
                   uiNotificationsStore.showError(t('fileManager.errors.decompressErrorDetailed', { error: errorMsg })); // 使用 i18n 包装详细错误
                   finishFileOperationTask(requestId, 'error', errorMsg);
                   reject(new Error(errorMsg));
               }
           });

           console.log(`[SFTP ${instanceSessionId}] 发送 sftp:decompress 请求 (ID: ${requestId}) Source: ${sourcePath}, Dest: ${destinationDir}`);
           sendMessage({
               type: 'sftp:decompress',
               requestId: requestId,
               payload: { source: sourcePath, destination: destinationDir }
           });
       });
   };


   // --- Message Handlers ---

    const onSftpReaddirSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        const fileListPayload = (payload as FileListItem[]).filter(item => !/^\.nexus-upload-[a-z0-9_-]+\.part$/i.test(item.filename) && !/\.part-upload-\d+-[a-z0-9]+$/i.test(item.filename));
        const path = message.path; // e.g., /root

        if (!path) {
            console.error(`[SFTP ${instanceSessionId}] Received readdir success without path!`);
            // 如果收到的消息没有路径，但请求 ID 匹配，仍然需要重置加载状态
            if (message.requestId === loadingRequestId.value) {
                resetDirectoryLoading();
            }
            return;
        }

        // 检查请求 ID 是否匹配当前加载请求
        if (message.requestId !== loadingRequestId.value) {
            console.log(`[SFTP ${instanceSessionId}] Received stale readdir success for ${path} (ID: ${message.requestId}, expected: ${loadingRequestId.value}). Ignoring.`);
            return; // 忽略过时的响应
        }

        console.log(`[SFTP ${instanceSessionId}] Received file list for directory ${path}`);

        // Find or create the node for the directory itself (e.g., /root)
        // Pass `true` to create placeholder nodes if the path doesn't fully exist yet.
        const targetNode = findNodeByPath(fileTree, path, true);

        // If findNodeByPath failed even with createIfMissing=true, something is wrong.
        if (!targetNode) {
            console.error(`[SFTP ${instanceSessionId}] Failed to find or create node for path ${path}. Cannot update tree.`);
            // Ensure loading state is reset if the current path failed
            if (path === currentPathRef.value) {
                 isLoading.value = false;
            }
            return;
        }

        // --- Merge Logic ---
        const existingChildren = targetNode.children || [];
        const mergedChildren: FileTreeNode[] = [];
        const existingChildrenMap = new Map(existingChildren.map(node => [node.filename, node]));

        // Process items from the server payload
        for (const newItemData of fileListPayload) {
            const existingNode = existingChildrenMap.get(newItemData.filename);

            if (existingNode && existingNode.childrenLoaded && existingNode.attrs.isDirectory) {
                // Keep the existing node if it's a directory and its children are already loaded
                mergedChildren.push(existingNode);
            } else if (existingNode && existingNode.childrenLoaded && !newItemData.attrs.isDirectory
                && !existingNode.attrs.isDirectory && isSameFileAttrs(existingNode.attrs, newItemData.attrs)) {
                // 未变化的文件直接复用旧节点，避免后台刷新时整表重建、重新渲染
                mergedChildren.push(existingNode);
            } else {
                // Otherwise, create/update node based on new data
                 const newNode: FileTreeNode = reactive({ // Ensure new nodes are reactive
                    filename: newItemData.filename,
                    longname: newItemData.longname,
                    // attrs 只做整体替换，不需要深层响应式；markRaw 可大幅减少大目录的代理开销
                    attrs: markRaw(newItemData.attrs),
                    // Preserve children if existingNode was a placeholder but somehow had children (edge case)
                    children: (existingNode && !existingNode.childrenLoaded && existingNode.children)
                              ? existingNode.children
                              : (newItemData.attrs.isDirectory ? null : []),
                    childrenLoaded: (existingNode && !existingNode.childrenLoaded && existingNode.children)
                                   ? existingNode.childrenLoaded // Preserve loaded status if reusing placeholder children
                                   : !newItemData.attrs.isDirectory,
                });
                mergedChildren.push(newNode);
                // 注意：不要在这里逐项 console.log —— 上万条目录项会让浏览器主线程卡死数秒
            }
        }

         // Add existing nodes that were not in the new payload ONLY if they were previously loaded placeholders
         // (This handles cases where a placeholder was created but the parent load didn't list it - might indicate an issue)
         // Typically, if an item is not in the new list, it means it was deleted on the server.
         // We rely on the server list as the source of truth for existence.

        // Sort the merged children
        mergedChildren.sort((a, b) => sortFiles(a as any, b as any));

        // Update the target node's children and mark as loaded
        targetNode.children = mergedChildren;
        targetNode.childrenLoaded = true;
        console.log(`[SFTP ${instanceSessionId}] File tree node ${path}'s children updated after merge.`);

        // *** 在成功加载并更新树之后，才更新当前路径 ***
        currentPathRef.value = path;
        console.log(`[SFTP ${instanceSessionId}] currentPathRef updated to ${path} after successful readdir.`);

        // 重置加载状态，因为这是匹配的响应
        resetDirectoryLoading();
        settleDirectoryWaiters(path, true);
        console.log(`[SFTP ${instanceSessionId}] isLoading reset after successful readdir for ${path}.`);
        runQueuedDirectoryRequest(path);
    };

    const onSftpReaddirError = (payload: MessagePayload, message: WebSocketMessage) => {
        const errorPayload = typeof payload === 'string'
            ? payload
            : (typeof payload?.message === 'string' ? payload.message : String(payload ?? '未知错误'));
        const errorPath = message.path;

        if (message.requestId !== loadingRequestId.value) {
             console.log(`[SFTP ${instanceSessionId}] Received stale readdir error for ${errorPath} (ID: ${message.requestId}, expected: ${loadingRequestId.value}). Ignoring.`);
             return;
        }

        console.error(`[SFTP ${instanceSessionId}] 加载目录 ${errorPath} 出错:`, errorPayload);
        const transientKeywords = ['超时', 'timeout', 'ECONNRESET', 'reset', 'timed out', 'unavailable', '未就绪'];
        const isTransient = transientKeywords.some(k => errorPayload.toLowerCase().includes(k.toLowerCase()));
        if (isConnected.value && (isTransient || activeLoadSilent.value)) {
            console.warn(`[SFTP ${instanceSessionId}] readdir 返回瞬时错误，将触发重试。`);
            scheduleDirectoryRetry(errorPath || pendingDirectoryPath.current || currentPathRef.value || '/', errorPayload);
        } else {
            const silent = activeLoadSilent.value;
            resetDirectoryLoading();
            const droppedRequest = pendingDirectoryRequest.current;
            pendingDirectoryRequest.current = null;
            // 失败的路径不能留作待加载路径，否则 sftp_ready 会再次请求它
            pendingDirectoryPath.current = currentPathRef.value;
            settleDirectoryWaiters(errorPath || lastDirectoryRequestPath.current, false);
            if (droppedRequest) settleDirectoryWaiters(droppedRequest.path, false);
            if (!silent) uiNotificationsStore.showError(`${t('fileManager.errors.loadDirectoryFailed')}: ${errorPayload}`);
            console.log(`[SFTP ${instanceSessionId}] isLoading reset after failed readdir for ${errorPath}.`);
        }
    };
    const onSftpUnavailable = (payload: MessagePayload) => {
        const message = typeof payload?.message === 'string' ? payload.message : 'SFTP 会话已断开';
        if (isLoading.value) resetDirectoryLoading();
        console.warn(`[SFTP ${instanceSessionId}] ${message}`);
    };
    const onSftpReady = () => {
        if (!isConnected.value || loadingRequestId.value) return;
        const pendingPath = pendingDirectoryPath.current || currentPathRef.value || '/';
        directoryRetryCount.current = 0;
        loadDirectoryInternal(pendingPath, false);
    };
    const onSftpGenericError = (payload: MessagePayload) => {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null;
        if (isLoading.value && (!requestId || requestId === loadingRequestId.value)) {
            resetDirectoryLoading();
        }
    };

    const onConnectionClosed = () => {
        if (isLoading.value) resetDirectoryLoading();
        settleDirectoryWaiters(null, false);
    };

    // *** 具体操作成功后的处理函数 ***

    // *** 辅助函数 - 从文件树中移除节点 ***
    const removeNodeFromTree = (parentPath: string, filename: string): boolean => {
        const parentNode = findNodeByPath(fileTree, parentPath);
        if (parentNode && parentNode.children) {
            const index = parentNode.children.findIndex(node => node.filename === filename);
            if (index !== -1) {
                parentNode.children.splice(index, 1);
                console.log(`[SFTP ${instanceSessionId}] 从文件树 ${parentPath} 中移除节点: ${filename}`);
                return true;
            }
        }
        console.warn(`[SFTP ${instanceSessionId}] 尝试从文件树 ${parentPath} 移除节点 ${filename} 失败`);
        return false;
    };

    // *** 修改：辅助函数 - 向文件树添加或更新节点 (允许创建父节点占位符) ***
    const addOrUpdateNodeInTree = (parentPath: string, item: FileListItem): boolean => {
        // --- 修改：调用 findNodeByPath 时允许创建缺失的父节点 ---
        const parentNode = findNodeByPath(fileTree, parentPath, true);
        

        // 如果父节点被成功找到或创建
        if (parentNode) {
             // 如果父节点的 children 为 null (可能刚被创建为占位符)，则初始化为空数组
             if (parentNode.children === null) {
                 parentNode.children = [];
                 // 注意：此时 childrenLoaded 应该仍然是 false，除非它是叶子节点
                 // findNodeByPath 创建占位符时 childrenLoaded 设为 false
             }

             // 确保 children 是一个数组再继续
             if (!Array.isArray(parentNode.children)) {
                  console.error(`[SFTP ${instanceSessionId}] Logic error: parentNode.children is not an array after findNodeByPath in addOrUpdateNodeInTree for path ${parentPath}`);
                  return false; // 无法继续
             }

             // --- 现有逻辑：添加或更新子节点 ---
             const newNode: FileTreeNode = reactive({ // 确保新节点也是响应式的
                filename: item.filename,
                longname: item.longname,
                attrs: item.attrs,
                children: item.attrs.isDirectory ? null : [],
                childrenLoaded: !item.attrs.isDirectory,
            });

            const existingIndex = parentNode.children.findIndex(node => node.filename === item.filename);
            if (existingIndex !== -1) {
                // 更新现有节点
                parentNode.children.splice(existingIndex, 1, newNode);
                console.log(`[SFTP ${instanceSessionId}] 更新文件树节点: ${parentPath}/${item.filename}`);
            } else {
                // 添加新节点并保持排序
                let insertIndex = 0;
                while (insertIndex < parentNode.children.length && sortFiles(newNode as any, parentNode.children[insertIndex] as any) > 0) {
                    insertIndex++;
                }
                parentNode.children.splice(insertIndex, 0, newNode);
                console.log(`[SFTP ${instanceSessionId}] 添加文件树节点: ${parentPath}/${item.filename}`);
            }
            // --- 结束现有逻辑 ---
            return true; // 添加/更新成功

        } else {
             // 如果 findNodeByPath 即使在 createIfMissing=true 时也失败了，说明有更深层的问题
             console.error(`[SFTP ${instanceSessionId}] Failed to find or create parent node ${parentPath} in addOrUpdateNodeInTree for item ${item.filename}.`);
             return false; // 添加/更新失败
        }
    };


    // 处理创建目录成功
    const onMkdirSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        const newItem = payload as FileListItem | null; // 后端现在会发送 FileListItem 或 null
        const parentPath = message.path?.substring(0, message.path.lastIndexOf('/')) || '/';

        console.log(`[SFTP ${instanceSessionId}] 创建目录成功: ${message.path}`);
        notifyNestedCreate(message.requestId);

        // *** 修改：直接修改文件树 ***
        if (newItem) {
            addOrUpdateNodeInTree(parentPath, newItem);
        } else {
            // 如果后端未能提供新项信息，标记父节点需要重新加载
            const parentNode = findNodeByPath(fileTree, parentPath);
            if (parentNode) {
                parentNode.childrenLoaded = false; // 下次访问时会重新加载
                console.warn(`[SFTP ${instanceSessionId}] Mkdir success for ${message.path} but no item details received. Marking parent ${parentPath} for reload.`);
                // 如果创建发生在当前目录，可以触发一次刷新
                if (parentPath === currentPathRef.value) {
                    loadDirectory(currentPathRef.value);
                }
            }
        }
    };

    // 处理删除目录/文件成功
    const onRemoveSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        const removedPath = message.path;
        const parentPath = removedPath?.substring(0, removedPath.lastIndexOf('/')) || '/';
        const removedFilename = removedPath?.substring(removedPath.lastIndexOf('/') + 1);

        console.log(`[SFTP ${instanceSessionId}] 删除成功: ${removedPath}`);
        // *** 修改：直接修改文件树 ***
        removeNodeFromTree(parentPath, removedFilename || '');
        // 如果删除的是一个目录，也需要考虑移除其在树中的子节点缓存（如果已加载）
        const removedNode = findNodeByPath(fileTree, removedPath || '');
        if (removedNode && removedNode.attrs.isDirectory) {
            // 理论上 removeNodeFromTree 已经移除了它，这里可以加日志或额外清理
            console.log(`[SFTP ${instanceSessionId}] 目录 ${removedPath} 已从树中移除`);
        }
    };

    // 处理重命名成功
    const onRenameSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        // 后端现在发送 { oldPath: string, newPath: string, newItem: FileListItem | null }
        const renamePayload = payload as { oldPath: string, newPath: string, newItem: FileListItem | null };
        const oldParentPath = renamePayload.oldPath.substring(0, renamePayload.oldPath.lastIndexOf('/')) || '/';
        const newParentPath = renamePayload.newPath.substring(0, renamePayload.newPath.lastIndexOf('/')) || '/';
        const oldFilename = renamePayload.oldPath.substring(renamePayload.oldPath.lastIndexOf('/') + 1);
        const newItem = renamePayload.newItem;

        console.log(`[SFTP ${instanceSessionId}] 重命名成功: ${renamePayload.oldPath} -> ${renamePayload.newPath}`);

        // *** 修改：直接修改文件树 ***
        const removed = removeNodeFromTree(oldParentPath, oldFilename);

        if (newItem) {
            addOrUpdateNodeInTree(newParentPath, newItem);
        } else {
            // 如果后端没提供新项信息，且移动到了新目录，标记新父目录需要刷新
            if (oldParentPath !== newParentPath) {
                const newParentNode = findNodeByPath(fileTree, newParentPath);
                if (newParentNode) {
                    newParentNode.childrenLoaded = false;
                    console.warn(`[SFTP ${instanceSessionId}] Rename/Move success to ${renamePayload.newPath} but no item details. Marking parent ${newParentPath} for reload.`);
                    // 如果移入的是当前目录，触发刷新
                    if (newParentPath === currentPathRef.value) {
                         loadDirectory(currentPathRef.value);
                    }
                }
            } else if (removed) {
                 // 如果只是在同目录下重命名但没收到新项，也标记父目录刷新
                 const parentNode = findNodeByPath(fileTree, oldParentPath);
                 if (parentNode) {
                     parentNode.childrenLoaded = false;
                     console.warn(`[SFTP ${instanceSessionId}] Rename success in ${oldParentPath} but no item details. Marking parent for reload.`);
                     if (oldParentPath === currentPathRef.value) {
                         loadDirectory(currentPathRef.value);
                     }
                 }
            }
        }
    };

     // 处理修改权限成功
    const onChmodSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        const updatedItem = payload as FileListItem | null; // 后端现在会发送 FileListItem 或 null
        const targetPath = message.path;
        const parentPath = targetPath?.substring(0, targetPath.lastIndexOf('/')) || '/';
        const filename = targetPath?.substring(targetPath.lastIndexOf('/') + 1);

        console.log(`[SFTP ${instanceSessionId}] 修改权限成功: ${targetPath}`);

        // *** 修改：直接修改文件树 ***
        if (updatedItem) {
            addOrUpdateNodeInTree(parentPath, updatedItem);
        } else {
            // 如果后端未能提供更新信息，标记父节点需要重新加载
            const parentNode = findNodeByPath(fileTree, parentPath);
            if (parentNode) {
                parentNode.childrenLoaded = false;
                console.warn(`[SFTP ${instanceSessionId}] Chmod success for ${targetPath} but no item details received. Marking parent ${parentPath} for reload.`);
                if (parentPath === currentPathRef.value) {
                    loadDirectory(currentPathRef.value);
                }
            }
        }

        // 权限改完了：这次还要求改所有者的话，接着发 chown
        const pendingChown = message.requestId ? pendingChownTargets.get(message.requestId) : undefined;
        if (pendingChown && message.requestId) {
            pendingChownTargets.delete(message.requestId);
            const chownRequestId = generateRequestId();
            pendingChownRequestIds.add(chownRequestId);
            sendMessage({
                type: 'sftp:chown',
                requestId: chownRequestId,
                payload: { path: pendingChown.path, owner: pendingChown.owner, group: pendingChown.group },
            });
        }
    };

    // 处理修改所有者成功（批量时合并成一条提示）
    const onChownSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        if (!message.requestId || !pendingChownRequestIds.has(message.requestId)) return;
        pendingChownRequestIds.delete(message.requestId);
        const updatedItem = payload as FileListItem | null;
        const targetPath = message.path;
        const parentPath = targetPath?.substring(0, targetPath.lastIndexOf('/')) || '/';
        if (updatedItem) {
            addOrUpdateNodeInTree(parentPath, updatedItem);
        } else if (parentPath === currentPathRef.value) {
            loadDirectory(currentPathRef.value);
        }
        chownSuccessCount++;
        if (chownToastTimer) clearTimeout(chownToastTimer);
        chownToastTimer = setTimeout(() => {
            const count = chownSuccessCount;
            chownSuccessCount = 0;
            chownToastTimer = null;
            uiNotificationsStore.showSuccess(count > 1
                ? t('fileManager.notifications.ownerChangedMultiple', { count })
                : t('fileManager.notifications.ownerChanged'));
        }, 300);
    };

    // 处理写入文件成功 (新建或修改)
    const onWriteFileSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        const updatedItem = payload as FileListItem | null; // 后端现在会发送 FileListItem 或 null
        const filePath = message.path;
        const parentPath = filePath?.substring(0, filePath.lastIndexOf('/')) || '/';
        const filename = filePath?.substring(filePath.lastIndexOf('/') + 1);

        console.log(`[SFTP ${instanceSessionId}] 写入文件成功: ${filePath}`);
        notifyNestedCreate(message.requestId);

        // *** 修改：直接修改文件树 ***
        if (updatedItem) {
            addOrUpdateNodeInTree(parentPath, updatedItem);
        } else {
            // 如果后端未能提供更新信息，标记父节点需要重新加载
            const parentNode = findNodeByPath(fileTree, parentPath);
            if (parentNode) {
                parentNode.childrenLoaded = false;
                console.warn(`[SFTP ${instanceSessionId}] WriteFile success for ${filePath} but no item details received. Marking parent ${parentPath} for reload.`);
                if (parentPath === currentPathRef.value) {
                    loadDirectory(currentPathRef.value);
                }
            }
        }
    };

    // +++ 处理复制成功 +++
    const onCopySuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        // 后端应发送 { destination: string, items: FileListItem[] | null }
        const copyPayload = payload as { destination: string, items: FileListItem[] | null };
        const destinationDir = copyPayload.destination;
        const newItems = copyPayload.items;

        console.log(`[SFTP ${instanceSessionId}] 复制成功到: ${destinationDir}`);
        uiNotificationsStore.showSuccess(t('fileManager.notifications.copySuccess')); // 添加成功通知
        finishFileOperationTask(message.requestId || '', 'success', t('fileManager.notifications.copySuccess'));

        // 更新文件树
        const destNode = findNodeByPath(fileTree, destinationDir);
        if (destNode && newItems) {
            // 如果目标节点已加载，直接添加新项目
            if (destNode.childrenLoaded && destNode.children) {
                 newItems.forEach(item => addOrUpdateNodeInTree(destinationDir, item));
            } else {
                // 如果目标节点未加载，标记为需要刷新
                destNode.childrenLoaded = false;
                console.log(`[SFTP ${instanceSessionId}] 复制成功，但目标目录 ${destinationDir} 未加载，标记为需要刷新`);
                // 如果复制发生在当前目录，触发刷新
                if (destinationDir === currentPathRef.value) {
                    loadDirectory(currentPathRef.value);
                }
            }
        } else if (destNode && !newItems) {
            // 成功但没有收到项目详情，标记目标目录需要刷新
            destNode.childrenLoaded = false;
            console.warn(`[SFTP ${instanceSessionId}] Copy success to ${destinationDir} but no item details received. Marking parent for reload.`);
            if (destinationDir === currentPathRef.value) {
                loadDirectory(currentPathRef.value);
            }
        } else {
             console.warn(`[SFTP ${instanceSessionId}] Copy success, but destination node ${destinationDir} not found in tree.`);
             // 可能需要刷新根目录或采取其他措施
        }
    };

    // +++ 处理移动成功 +++
    const onMoveSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
         // 后端应发送 { sources: string[], destination: string, items: FileListItem[] | null }
        const movePayload = payload as { sources: string[], destination: string, items: FileListItem[] | null };
        const sourcePaths = movePayload.sources;
        const destinationDir = movePayload.destination;
        const newItems = movePayload.items;

        console.log(`[SFTP ${instanceSessionId}] 移动成功到: ${destinationDir}`);
        uiNotificationsStore.showSuccess(t('fileManager.notifications.moveSuccess')); // 添加成功通知
        finishFileOperationTask(message.requestId || '', 'success', t('fileManager.notifications.moveSuccess'));

        // 1. 从旧位置移除
        sourcePaths.forEach(oldPath => {
            const oldParentPath = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
            const oldFilename = oldPath.substring(oldPath.lastIndexOf('/') + 1);
            removeNodeFromTree(oldParentPath, oldFilename);
        });

        // 2. 添加到新位置
        const destNode = findNodeByPath(fileTree, destinationDir);
        if (destNode && newItems) {
            if (destNode.childrenLoaded && destNode.children) {
                newItems.forEach(item => addOrUpdateNodeInTree(destinationDir, item));
            } else {
                destNode.childrenLoaded = false; // 标记需要刷新
                console.log(`[SFTP ${instanceSessionId}] 移动成功，但目标目录 ${destinationDir} 未加载，标记为需要刷新`);
                if (destinationDir === currentPathRef.value) {
                    loadDirectory(currentPathRef.value);
                }
            }
        } else if (destNode && !newItems) {
            destNode.childrenLoaded = false;
            console.warn(`[SFTP ${instanceSessionId}] Move success to ${destinationDir} but no item details received. Marking parent for reload.`);
             if (destinationDir === currentPathRef.value) {
                loadDirectory(currentPathRef.value);
            }
        } else {
             console.warn(`[SFTP ${instanceSessionId}] Move success, but destination node ${destinationDir} not found in tree.`);
        }
    };


    // *** 处理上传成功 ***
    const onUploadSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        const newItem = payload as FileListItem | null; // 后端应发送 FileListItem 或 null
        const fullPath = message.path; // 后端现在应该在 message 中包含完整的上传路径

        if (!fullPath) {
            console.error(`[SFTP ${instanceSessionId}] Received upload success but message is missing 'path'. Payload:`, payload);
            // 尝试从 newItem 获取文件名，但无法确定父路径，只能刷新当前目录
            const filename = newItem?.filename;
            console.warn(`[SFTP ${instanceSessionId}] Upload success for ${filename || '(unknown file)'} but cannot determine parent path. Reloading current directory.`);
            loadDirectory(currentPathRef.value); // Fallback to reloading current dir
            return;
        }

        // --- 修正：从完整路径推断父路径和文件名 ---
        const parentPath = fullPath.substring(0, fullPath.lastIndexOf('/')) || '/';
        const filename = fullPath.substring(fullPath.lastIndexOf('/') + 1);
        // --- 结束修正 ---

        console.log(`[SFTP ${instanceSessionId}] 上传文件成功: ${fullPath}`);

        // *** 修改：使用推断出的 parentPath 更新文件树 ***
        if (newItem) {
            // 确保 newItem 的 filename 与从路径中提取的一致
            if (newItem.filename !== filename) {
                 console.warn(`[SFTP ${instanceSessionId}] Upload success: filename mismatch between message.path ('${filename}') and payload.filename ('${newItem.filename}'). Using filename from path.`);
                 // 可以选择信任哪个，这里信任从路径提取的
                 newItem.filename = filename;
            }
            addOrUpdateNodeInTree(parentPath, newItem);
        } else {
            // 如果后端未能提供更新信息，标记推断出的父节点需要重新加载
            const parentNode = findNodeByPath(fileTree, parentPath);
            if (parentNode) {
                parentNode.childrenLoaded = false;
                console.warn(`[SFTP ${instanceSessionId}] Upload success for ${fullPath} but no item details received. Marking parent ${parentPath} for reload.`);
                // 如果上传发生在当前目录或其子目录，触发当前目录刷新可能有用
                if (parentPath === currentPathRef.value || parentPath.startsWith(currentPathRef.value + '/')) {
                    loadDirectory(currentPathRef.value);
                }
            } else {
                 console.warn(`[SFTP ${instanceSessionId}] Upload success for ${fullPath}, no item details, and parent node ${parentPath} not found in tree.`);
                 // 可能需要刷新根目录或当前目录
                 loadDirectory(currentPathRef.value);
            }
        }
    };

    const onActionError = (payload: MessagePayload, message: WebSocketMessage) => {
        // 类型断言，因为我们知道这些错误的 payload 是 string
        const errorPayload = payload as string;
        if (message.type === 'sftp:chmod:error' && message.requestId) {
            // 权限没改成 → 不再跟 chown
            pendingChownTargets.delete(message.requestId);
        } else if (message.type === 'sftp:chown:error') {
            // 只有发起方提示，避免共享连接的多个文件管理器重复弹错
            if (!message.requestId || !pendingChownRequestIds.has(message.requestId)) return;
            pendingChownRequestIds.delete(message.requestId);
        }
        if (message.type === 'sftp:mkdir:error' && message.requestId && silentMkdirRequestIds.has(message.requestId)) {
            // ensureDirectory 发出的 mkdir（目录已存在等）不提示；不删除 ID，其他共享连接的实例也要能识别
            console.log(`[SFTP ${instanceSessionId}] ensureDirectory ${message.path} skipped: ${errorPayload}`);
            return;
        }
        console.error(`[SFTP ${instanceSessionId}] Action ${message.type} failed:`, errorPayload);
        const actionTypeMap: Record<string, string> = {
            'sftp:mkdir:error': t('fileManager.errors.createFolderFailed'),
            'sftp:rmdir:error': t('fileManager.errors.deleteFailed'),
            'sftp:unlink:error': t('fileManager.errors.deleteFailed'),
            'sftp:rename:error': t('fileManager.errors.renameFailed'),
            'sftp:chmod:error': t('fileManager.errors.chmodFailed'),
            'sftp:chown:error': t('fileManager.errors.chownFailed'),
            'sftp:writefile:error': t('fileManager.errors.saveFailed'),
            'sftp:copy:error': t('fileManager.errors.copyFailed'), // +++
            'sftp:move:error': t('fileManager.errors.moveFailed'), // +++
        };
        const prefix = actionTypeMap[message.type] || t('fileManager.errors.generic');
        // error.value = `${prefix}: ${errorPayload}`; // 使用通知
        uiNotificationsStore.showError(`${prefix}: ${errorPayload}`);
        if (message.requestId) finishFileOperationTask(message.requestId, 'error', `${prefix}: ${errorPayload}`);
    };

    // --- Register Handlers & Store Unregister Callbacks ---
    unregisterCallbacks.push(onMessage('sftp:readdir:success', onSftpReaddirSuccess));
    unregisterCallbacks.push(onMessage('sftp:readdir:error', onSftpReaddirError));
    unregisterCallbacks.push(onMessage('sftp_ready', onSftpReady));
    unregisterCallbacks.push(onMessage('sftp_unavailable', onSftpUnavailable));
    unregisterCallbacks.push(onMessage('sftp_error', onSftpGenericError));
    unregisterCallbacks.push(onMessage('internal:closed', onConnectionClosed));
    // *** 修改：绑定到新的具体处理函数 ***
    unregisterCallbacks.push(onMessage('sftp:mkdir:success', onMkdirSuccess));
    unregisterCallbacks.push(onMessage('sftp:rmdir:success', onRemoveSuccess)); // 使用 onRemoveSuccess
    unregisterCallbacks.push(onMessage('sftp:unlink:success', onRemoveSuccess)); // 使用 onRemoveSuccess
    unregisterCallbacks.push(onMessage('sftp:rename:success', onRenameSuccess));
    unregisterCallbacks.push(onMessage('sftp:chmod:success', onChmodSuccess));
    unregisterCallbacks.push(onMessage('sftp:chown:success', onChownSuccess));
    unregisterCallbacks.push(onMessage('sftp:writefile:success', onWriteFileSuccess)); // 使用 onWriteFileSuccess
    unregisterCallbacks.push(onMessage('sftp:upload:success', onUploadSuccess)); // *** 监听上传成功 ***
    unregisterCallbacks.push(onMessage('sftp:mkdir:error', onActionError));
    unregisterCallbacks.push(onMessage('sftp:rmdir:error', onActionError));
    unregisterCallbacks.push(onMessage('sftp:unlink:error', onActionError));
    unregisterCallbacks.push(onMessage('sftp:rename:error', onActionError));
    unregisterCallbacks.push(onMessage('sftp:chmod:error', onActionError));
    unregisterCallbacks.push(onMessage('sftp:chown:error', onActionError));
    unregisterCallbacks.push(onMessage('sftp:writefile:error', onActionError));
    // +++ 监听复制/移动错误 +++
    unregisterCallbacks.push(onMessage('sftp:copy:success', onCopySuccess));
    unregisterCallbacks.push(onMessage('sftp:copy:error', onActionError));
    unregisterCallbacks.push(onMessage('sftp:move:success', onMoveSuccess));
    unregisterCallbacks.push(onMessage('sftp:move:error', onActionError));

    // +++ 处理命令未找到错误 +++
    const onCommandNotFound = (payload: MessagePayload, message: WebSocketMessage) => {
        const { operation, command, message: details } = payload as { operation: 'compress' | 'decompress', command: string, message?: string };
        console.error(`[SFTP ${instanceSessionId}] Command '${command}' not found on server for ${operation}. Details: ${details}`);
        let errorMsgKey = '';
        if (operation === 'compress') {
            errorMsgKey = 'fileManager.errors.commandNotFoundCompress';
        } else if (operation === 'decompress') {
            errorMsgKey = 'fileManager.errors.commandNotFoundDecompress';
        }
        if (errorMsgKey) {
            uiNotificationsStore.showError(t(errorMsgKey, { command }));
        } else {
            uiNotificationsStore.showError(t('fileManager.errors.genericCommandNotFound', { command, operation }));
        }
        if (message.requestId) finishFileOperationTask(message.requestId, 'error', details || `服务器未找到命令 ${command}`);
    };
    unregisterCallbacks.push(onMessage('sftp:command_not_found', onCommandNotFound));
    // --- 结束处理 ---

    // 注意：sftp:compress:success, sftp:compress:error, sftp:decompress:success, sftp:decompress:error
    // 的消息处理器直接在 compressItems 和 decompressItem 方法内部通过 onMessage 临时注册和注销，
    // 因为它们与特定的 Promise 相关联。

    const fileList = computed<FileListItem[]>(() => {
        const node = findNodeByPath(fileTree, currentPathRef.value);
        if (node && node.childrenLoaded && node.children) {
            // 将 FileTreeNode 转换回 FileListItem 供视图使用
            return node.children.map(child => ({
                filename: child.filename,
                longname: child.longname,
                attrs: child.attrs,
            }));
        }
        return []; // 如果节点未找到或子节点未加载，返回空列表
    });


    return {
        // State
       fileList: fileList, // 暴露计算属性 (类型已在接口中定义为 Readonly<ComputedRef>)
       isLoading: isLoading, // (类型已在接口中定义为 Readonly<Ref>)
       isLoadingVisible,
        fileTree: fileTree, // (类型已在接口中定义为 Readonly<FileTreeNode>)
       initialLoadDone: initialLoadDone, // (类型已在接口中定义为 Readonly<Ref>)

        // Methods
        loadDirectory,
        createDirectory,
        ensureDirectory,
        createFile,
        deleteItems,
        renameItem,
        changePermissions,
        readFile,
        writeFile,
        copyItems, // +++ 暴露 copyItems +++
       moveItems, // +++ 暴露 moveItems +++
       compressItems, // +++ 暴露 compressItems +++
       decompressItem, // +++ 暴露 decompressItem +++
       joinPath, // 暴露辅助函数
        currentPath: currentPathRef, // (类型已在接口中定义为 Readonly<Ref>)
        setInitialLoadDone: (value: boolean) => { initialLoadDone.value = value; }, // +++ 暴露设置初始加载状态的方法 +++
         cleanup,
    };
}
