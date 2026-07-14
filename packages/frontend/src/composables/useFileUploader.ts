import { reactive, nextTick, onUnmounted, type Ref, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types';
import type { UploadItem } from '../types/upload.types';
import type { WebSocketMessage, MessagePayload } from '../types/websocket.types';
import type { WebSocketDependencies } from './useSftpActions';

const UPLOAD_CHUNK_SIZE = 262144; // 256KB

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
    void fileListRef;

    const uploads = reactive<Record<string, UploadItem>>({});

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
                currentUpload.status = 'error';
                currentUpload.error = t('fileManager.errors.readFileError');
                return;
            }

            const isLast = offset + slice.size >= currentUpload.file.size;
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
        };

        reader.onerror = () => {
            const failedUpload = uploads[uploadId];
            if (failedUpload) {
                failedUpload.status = 'error';
                failedUpload.error = t('fileManager.errors.readFileError');
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
            progress: 0,
            nextChunkIndex: 0,
            acknowledgedBytes: 0,
            status: 'pending'
        };

        console.log(`[FileUploader ${sessionIdForLog.value}] Starting upload ${uploadId} to ${finalRemotePath}`);
        wsDeps.value.sendMessage({
            type: 'sftp:upload:start',
            payload: { uploadId, remotePath: finalRemotePath, size: file.size, relativePath: relativePath || undefined }
        });
    };

    const cancelUpload = (uploadId: string, notifyBackend = true) => {
        const upload = uploads[uploadId];
        if (upload && ['pending', 'uploading', 'paused'].includes(upload.status)) {
            console.log(`[FileUploader ${sessionIdForLog.value}] Cancelling upload ${uploadId}`);
            upload.status = 'cancelled';

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

    const onUploadReady = (payload: MessagePayload, message: WebSocketMessage) => {
        const uploadId = message.uploadId || payload?.uploadId;
        if (!uploadId) return;

        const upload = uploads[uploadId];
        if (upload && upload.status === 'pending') {
            upload.status = 'uploading';
            upload.nextChunkIndex = 0;
            upload.acknowledgedBytes = 0;
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
            const errorMessage = typeof payload === 'string'
                ? payload
                : (typeof payload?.message === 'string' ? payload.message : t('fileManager.errors.uploadFailed'));
            console.error(`[FileUploader ${sessionIdForLog.value}] Upload ${uploadId} error:`, errorMessage);
            upload.status = 'error';
            upload.error = errorMessage;

            setTimeout(() => {
                if (uploads[uploadId]?.status === 'error') {
                    delete uploads[uploadId];
                }
            }, 8000);
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

        if (typeof payload?.nextChunkIndex === 'number') upload.nextChunkIndex = payload.nextChunkIndex;
        if (typeof payload?.bytesWritten === 'number') upload.acknowledgedBytes = payload.bytesWritten;
        if (typeof payload?.totalSize === 'number') {
            upload.progress = payload.totalSize === 0 ? 100 : Math.min(100, Math.round(((upload.acknowledgedBytes ?? 0) / payload.totalSize) * 100));
        }

        if (!payload?.isComplete) {
            nextTick(() => sendNextChunk(uploadId));
        }
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

        onCleanup(() => {
            unregisterUploadReady?.();
            unregisterUploadSuccess?.();
            unregisterUploadError?.();
            unregisterUploadPause?.();
            unregisterUploadResume?.();
            unregisterUploadCancelled?.();
            unregisterUploadProgress?.();
            unregisterUploadChunkAck?.();
        });
    });

    onUnmounted(() => {
        Object.keys(uploads).forEach(uploadId => {
            cancelUpload(uploadId, true);
        });
    });

    return {
        uploads,
        startFileUpload,
        cancelUpload,
    };
}
