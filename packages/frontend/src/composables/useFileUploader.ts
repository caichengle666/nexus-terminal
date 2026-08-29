import { reactive, nextTick, onUnmounted, type Ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types';
import type { UploadItem } from '../types/upload.types';
import type { WebSocketMessage, MessagePayload } from '../types/websocket.types';
import type { WebSocketDependencies } from './useSftpActions';
import { useTransferStore } from '../stores/transfer.store';

const UPLOAD_CHUNK_SIZE = 65536; // 64KB; base64 后仍适合移动网络与代理传输
const UPLOAD_READY_TIMEOUT_MS = 10000;
const UPLOAD_CHUNK_ACK_TIMEOUT_MS = 30000;
const UPLOAD_FINALIZE_TIMEOUT_MS = 60000;
const MAX_UPLOAD_START_ATTEMPTS = 2;

const generateUploadId = (): string => {
    return `upload-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
};

const joinPath = (base: string, name: string): string => {
    if (base === '/') return `/${name}`;
    if (base.endsWith('/')) return `${base}${name}`;
    return `${base}/${name}`;
};

export function useFileUploader(
    sessionIdForLog: Ref<string>,
    currentPathRef: Ref<string>,
    fileListRef: Readonly<Ref<readonly FileListItem[]>>,
    wsDeps: Ref<WebSocketDependencies>
) {
    const { t } = useI18n();
    const transferStore = useTransferStore();
    void fileListRef;

    const uploads = reactive<Record<string, UploadItem>>({});
    const uploadTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
    const uploadStartAttempts = new Map<string, number>();
    const ownedUploadIds = new Set<string>();

    watch(uploads, (currentUploads) => {
        const currentIds = new Set(Object.keys(currentUploads));
        Object.values(currentUploads).forEach(upload => {
            ownedUploadIds.add(upload.id);
            transferStore.upsertLocalUpload(upload, sessionIdForLog.value, () => cancelUpload(upload.id));
        });
        ownedUploadIds.forEach(uploadId => {
            if (!currentIds.has(uploadId)) {
                transferStore.removeLocalUpload(uploadId);
                ownedUploadIds.delete(uploadId);
            }
        });
    }, { deep: true, immediate: true });

    const clearUploadTimeout = (uploadId: string) => {
        const timeoutId = uploadTimeouts.get(uploadId);
        if (timeoutId) clearTimeout(timeoutId);
        uploadTimeouts.delete(uploadId);
    };

    const removeUploadTracking = (uploadId: string) => {
        clearUploadTimeout(uploadId);
        uploadStartAttempts.delete(uploadId);
    };

    const failUpload = (uploadId: string, message: string, notifyBackend = true) => {
        const upload = uploads[uploadId];
        if (!upload || ['success', 'error', 'cancelled'].includes(upload.status)) return;

        clearUploadTimeout(uploadId);
        upload.status = 'error';
        upload.error = message;
        if (notifyBackend && wsDeps.value.isConnected.value) {
            wsDeps.value.sendMessage({ type: 'sftp:upload:cancel', payload: { uploadId } });
        }
        console.error(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} failed: ${message}`);
    };

    const sendUploadStart = (uploadId: string) => {
        const upload = uploads[uploadId];
        if (!upload || upload.status !== 'pending') return;

        const attempt = (uploadStartAttempts.get(uploadId) ?? 0) + 1;
        uploadStartAttempts.set(uploadId, attempt);
        console.log(`[FileUploader ${sessionIdForLog.value}] Sending upload:start for ${uploadId} (attempt ${attempt}/${MAX_UPLOAD_START_ATTEMPTS})`);
        wsDeps.value.sendMessage({
            type: 'sftp:upload:start',
            payload: {
                uploadId,
                remotePath: upload.remotePath,
                size: upload.file.size,
                relativePath: upload.relativePath,
            }
        });

        clearUploadTimeout(uploadId);
        uploadTimeouts.set(uploadId, setTimeout(() => {
            if (uploads[uploadId]?.status !== 'pending') return;
            if (attempt < MAX_UPLOAD_START_ATTEMPTS && wsDeps.value.isConnected.value) {
                sendUploadStart(uploadId);
                return;
            }
            failUpload(uploadId, '等待服务器准备上传超时，请检查网络后重试');
        }, UPLOAD_READY_TIMEOUT_MS));
    };

    const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    };

    const sendNextChunk = (uploadId: string) => {
        const upload = uploads[uploadId];
        if (!wsDeps.value.isConnected.value || !upload || upload.status !== 'uploading') {
            console.warn(`[FileUploader ${sessionIdForLog.value}] Cannot send chunk for ${uploadId}. Connection: ${wsDeps.value.isConnected.value}, Upload status: ${upload?.status}`);
            return;
        }

        const chunkIndex = upload.nextChunkIndex ?? 0;
        const offset = upload.acknowledgedBytes ?? 0;

        if (upload.file.size === 0 && chunkIndex === 0) {
            wsDeps.value.sendMessage({
                type: 'sftp:upload:chunk',
                payload: { uploadId, chunkIndex: 0, data: '', size: 0, isLast: true }
            });
            clearUploadTimeout(uploadId);
            uploadTimeouts.set(uploadId, setTimeout(() => {
                failUpload(uploadId, '等待空文件写入确认超时，请重试上传');
            }, UPLOAD_CHUNK_ACK_TIMEOUT_MS));
            return;
        }

        if (offset >= upload.file.size) return;

        const slice = upload.file.slice(offset, Math.min(offset + UPLOAD_CHUNK_SIZE, upload.file.size));
        const reader = new FileReader();

        reader.onload = (e) => {
            const currentUpload = uploads[uploadId];
            if (!wsDeps.value.isConnected.value || !currentUpload || currentUpload.status !== 'uploading') return;

            const result = e.target?.result;
            if (!(result instanceof ArrayBuffer)) {
                failUpload(uploadId, t('fileManager.errors.readFileError'));
                return;
            }

            const isLast = offset + slice.size >= currentUpload.file.size;
            if (chunkIndex === 0) {
                console.log(`[FileUploader ${sessionIdForLog.value}] Sending first chunk for ${uploadId} (${slice.size} bytes)`);
            }
            wsDeps.value.sendMessage({
                type: 'sftp:upload:chunk',
                payload: {
                    uploadId,
                    chunkIndex,
                    data: arrayBufferToBase64(result),
                    size: slice.size,
                    isLast,
                }
            });
            clearUploadTimeout(uploadId);
            uploadTimeouts.set(uploadId, setTimeout(() => {
                failUpload(uploadId, `等待第 ${chunkIndex + 1} 个分片确认超时，请重试上传`);
            }, UPLOAD_CHUNK_ACK_TIMEOUT_MS));
        };

        reader.onerror = () => {
            const failedUpload = uploads[uploadId];
            if (failedUpload) {
                failUpload(uploadId, t('fileManager.errors.readFileError'));
            }
        };

        reader.readAsArrayBuffer(slice);
    };

    const startFileUpload = (file: File, relativePath?: string) => {
        if (!wsDeps.value.isConnected.value) {
            console.warn(`[FileUploader ${sessionIdForLog.value}] Cannot start upload: WebSocket not connected.`);
            return;
        }

        const uploadId = generateUploadId();

        let finalRemotePath: string;
        if (relativePath) {
            const basePath = currentPathRef.value.endsWith('/') ? currentPathRef.value : `${currentPathRef.value}/`;
            let cleanRelativePath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
            cleanRelativePath = cleanRelativePath.endsWith('/') ? cleanRelativePath.slice(0, -1) : cleanRelativePath;
            finalRemotePath = `${basePath}${cleanRelativePath ? cleanRelativePath + '/' : ''}${file.name}`;
        } else {
            finalRemotePath = joinPath(currentPathRef.value, file.name);
        }
        finalRemotePath = finalRemotePath.replace(/\/+/g, '/');

        uploads[uploadId] = {
            id: uploadId,
            file,
            filename: file.name,
            remotePath: finalRemotePath,
            relativePath: relativePath || undefined,
            progress: 0,
            nextChunkIndex: 0,
            acknowledgedBytes: 0,
            status: 'pending'
        };

        console.log(`[FileUploader ${sessionIdForLog.value}] Starting upload ${uploadId} to ${finalRemotePath}`);
        sendUploadStart(uploadId);
    };

    const cancelUpload = (uploadId: string, notifyBackend = true) => {
        const upload = uploads[uploadId];
        if (upload && ['pending', 'uploading', 'paused'].includes(upload.status)) {
            console.log(`[FileUploader ${sessionIdForLog.value}] Cancelling upload ${uploadId}`);
            upload.status = 'cancelled';
            removeUploadTracking(uploadId);

            if (notifyBackend && wsDeps.value.isConnected.value) {
                wsDeps.value.sendMessage({ type: 'sftp:upload:cancel', payload: { uploadId } });
            }

            setTimeout(() => {
                if (uploads[uploadId]?.status === 'cancelled') {
                    delete uploads[uploadId];
                }
            }, 3000);
        }
    };

    const dismissUpload = (uploadId: string) => {
        const upload = uploads[uploadId];
        if (!upload || ['pending', 'uploading', 'paused'].includes(upload.status)) return;
        delete uploads[uploadId];
        removeUploadTracking(uploadId);
    };

    const onUploadReady = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;

        const upload = uploads[uploadId];
        if (upload && upload.status === 'pending') {
            console.log(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} is ready; sending from byte ${payload?.bytesWritten ?? 0}`);
            clearUploadTimeout(uploadId);
            upload.status = 'uploading';
            upload.nextChunkIndex = typeof payload?.nextChunkIndex === 'number' ? payload.nextChunkIndex : 0;
            upload.acknowledgedBytes = typeof payload?.bytesWritten === 'number' ? payload.bytesWritten : 0;
            sendNextChunk(uploadId);
        } else {
            console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:ready for unknown or non-pending upload ID: ${uploadId}`);
        }
    };

    const onUploadSuccess = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;

        const upload = uploads[uploadId];
        if (upload) {
            removeUploadTracking(uploadId);
            upload.status = 'success';
            upload.progress = 100;
            setTimeout(() => {
                if (uploads[uploadId]?.status === 'success') {
                    delete uploads[uploadId];
                }
            }, 3000);
        } else {
            console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:success for unknown upload ID: ${uploadId}`);
        }
    };

    const onUploadError = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) {
             console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:error with missing uploadId:`, message);
             return;
        }

        const upload = uploads[uploadId];
        if (upload) {
            removeUploadTracking(uploadId);
            const errorMessage = typeof payload === 'string'
                ? payload
                : (typeof payload?.message === 'string' ? payload.message : t('fileManager.errors.uploadFailed'));
            console.error(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} error:`, errorMessage);
            upload.status = 'error';
            upload.error = errorMessage;
        } else {
             console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:error for unknown upload ID: ${uploadId}`);
        }
    };

    const onUploadPause = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;
        const upload = uploads[uploadId];
        if (upload && upload.status === 'uploading') {
            upload.status = 'paused';
        }
    };

    const onUploadResume = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;
        const upload = uploads[uploadId];
        if (upload && upload.status === 'paused') {
            upload.status = 'uploading';
            sendNextChunk(uploadId);
        }
    };

    const onUploadCancelled = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;
        const upload = uploads[uploadId];
        if (upload) {
            removeUploadTracking(uploadId);
            if (upload.status === 'error') return;
            if (upload.status !== 'cancelled') {
                upload.status = 'cancelled';
            }
            setTimeout(() => {
                if (uploads[uploadId]?.status === 'cancelled') {
                    delete uploads[uploadId];
                }
            }, 3000);
        }
    };

    const onUploadProgress = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;

        const upload = uploads[uploadId];
        if (upload && upload.status === 'uploading') {
            if (typeof payload?.bytesWritten === 'number' && typeof payload?.totalSize === 'number') {
                upload.progress = payload.totalSize === 0 ? 100 : Math.min(100, Math.round((payload.bytesWritten / payload.totalSize) * 100));
            } else {
                console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:progress with incorrect payload format:`, payload);
            }
        } else if (!upload) {
            console.warn(`[FileUploader ${sessionIdForLog.value}] Received upload:progress for unknown upload ID: ${uploadId}`);
        }
    };

    const onUploadChunkAck = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;
        const upload = uploads[uploadId];
        if (!upload || upload.status !== 'uploading') return;

        clearUploadTimeout(uploadId);

        if (typeof payload?.nextChunkIndex === 'number') upload.nextChunkIndex = payload.nextChunkIndex;
        if (typeof payload?.bytesWritten === 'number') upload.acknowledgedBytes = payload.bytesWritten;
        if (typeof payload?.totalSize === 'number') {
            upload.progress = payload.totalSize === 0 ? 100 : Math.min(100, Math.round(((upload.acknowledgedBytes ?? 0) / payload.totalSize) * 100));
        }

        if (!payload?.isComplete) {
            nextTick(() => sendNextChunk(uploadId));
        } else {
            uploadTimeouts.set(uploadId, setTimeout(() => {
                failUpload(uploadId, '服务器完成文件写入超时，请检查远端目录后重试');
            }, UPLOAD_FINALIZE_TIMEOUT_MS));
        }
    };

    const onConnectionClosed = () => {
        Object.keys(uploads).forEach(uploadId => {
            failUpload(uploadId, '终端连接已断开，上传未完成', false);
        });
    };

    watchEffect((onCleanup) => {
        if (!wsDeps.value || !wsDeps.value.onMessage) {
            console.warn(`[FileUploader ${sessionIdForLog.value}] wsDeps.value or wsDeps.value.onMessage is not available for registering listeners.`);
            return;
        }

        const unregisterUploadReady = wsDeps.value.onMessage('sftp:upload:ready', onUploadReady);
        const unregisterUploadSuccess = wsDeps.value.onMessage('sftp:upload:success', onUploadSuccess);
        const unregisterUploadError = wsDeps.value.onMessage('sftp:upload:error', onUploadError);
        const unregisterUploadPause = wsDeps.value.onMessage('sftp:upload:pause', onUploadPause);
        const unregisterUploadResume = wsDeps.value.onMessage('sftp:upload:resume', onUploadResume);
        const unregisterUploadCancelled = wsDeps.value.onMessage('sftp:upload:cancelled', onUploadCancelled);
        const unregisterUploadProgress = wsDeps.value.onMessage('sftp:upload:progress', onUploadProgress);
        const unregisterUploadChunkAck = wsDeps.value.onMessage('sftp:upload:chunk:ack', onUploadChunkAck);
        const unregisterConnectionClosed = wsDeps.value.onMessage('internal:closed', onConnectionClosed);

        onCleanup(() => {
            unregisterUploadReady?.();
            unregisterUploadSuccess?.();
            unregisterUploadError?.();
            unregisterUploadPause?.();
            unregisterUploadResume?.();
            unregisterUploadCancelled?.();
            unregisterUploadProgress?.();
            unregisterUploadChunkAck?.();
            unregisterConnectionClosed?.();
        });
    });

    onUnmounted(() => {
        Object.keys(uploads).forEach(uploadId => {
            cancelUpload(uploadId, true);
        });
        uploadTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
        uploadTimeouts.clear();
        uploadStartAttempts.clear();
    });

    return {
        uploads,
        startFileUpload,
        cancelUpload,
        dismissUpload,
    };
}
