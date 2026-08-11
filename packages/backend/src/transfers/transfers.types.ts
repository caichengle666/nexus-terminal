export interface InitiateTransferPayload {
  sourceConnectionId: number; // ID of the source server (Server A)
  connectionIds: number[];    // IDs of the target servers (Server B, C, etc.)
  sourceItems: { name: string; path: string; type: 'file' | 'directory' }[];
  remoteTargetPath: string;
  transferMethod?: 'auto' | 'rsync' | 'scp' | 'sftp-relay';
}

export interface TransferSubTask {
  subTaskId: string;
  connectionId: number;
  sourceItemName: string;
  sourceItemPath: string;
  status: 'queued' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'cancelling' | 'cancelled'; // +++ 新增状态 +++
  progress?: number; // 0-100
  message?: string; // 例如错误信息
  transferMethodUsed?: 'sftp-relay';
  transferredBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  currentPath?: string;
  filesCompleted?: number;
  totalFiles?: number;
  startTime?: Date;
  endTime?: Date;
}

export interface TransferTask {
  taskId: string;
  status: 'queued' | 'in-progress' | 'completed' | 'failed' | 'partially-completed' | 'cancelling' | 'cancelled'; // +++ 新增状态 +++
  userId: string | number; // 添加用户ID字段
  createdAt: Date;
  updatedAt: Date;
  subTasks: TransferSubTask[];
  overallProgress?: number; // 0-100, 根据子任务计算
  payload: InitiateTransferPayload; // 存储原始请求负载，方便追溯
  sourceConnectionId?: number;
  remoteTargetPath?: string;
}
