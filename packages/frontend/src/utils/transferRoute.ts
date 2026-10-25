/**
 * 服务器间传输任务的「路线」展示模型（移植自上游 b3cdd2dc 的 transfer-task-view，按本分支数据裁剪）。
 *
 * 卡片要回答「哪台服务器上的什么 → 哪台服务器上的哪个路径」，原始数据是
 * sourceConnectionId + targetConnectionIds(或 subTasks[].connectionId) + subTasks[].sourceItemPath + remoteTargetPath
 * 拼起来才够。纯函数，便于单测。
 */
export interface TransferRouteTaskLike {
  sourceConnectionId?: number;
  remoteTargetPath?: string;
  targetConnectionIds?: number[];
  subTasks?: Array<{ connectionId: number; sourceItemName?: string; sourceItemPath?: string }>;
}

export interface TransferRouteView {
  sourceName: string | null;
  /** 已按 maxTargets 截断的目标服务器名 */
  targetNames: string[];
  hiddenTargetCount: number;
  allTargetNames: string[];
  /** 单个源条目时给完整源路径；多个条目时为 null（调用方显示「N 项」） */
  sourcePath: string | null;
  sourceItemCount: number;
  targetPath: string | null;
}

const unique = <T,>(list: T[]): T[] => [...new Set(list)];

export function buildTransferRoute(
  task: TransferRouteTaskLike,
  getConnectionName: (id: number) => string,
  maxTargets = 2
): TransferRouteView {
  const subTasks = task.subTasks || [];
  const targetIds = unique(
    task.targetConnectionIds && task.targetConnectionIds.length
      ? task.targetConnectionIds
      : subTasks.map((st) => st.connectionId)
  ).filter((id) => typeof id === 'number' && id > 0);
  const allTargetNames = targetIds.map(getConnectionName);
  const sourcePaths = unique(subTasks.map((st) => st.sourceItemPath || st.sourceItemName || '').filter(Boolean));
  return {
    sourceName: typeof task.sourceConnectionId === 'number' ? getConnectionName(task.sourceConnectionId) : null,
    targetNames: allTargetNames.slice(0, maxTargets),
    hiddenTargetCount: Math.max(0, allTargetNames.length - maxTargets),
    allTargetNames,
    sourcePath: sourcePaths.length === 1 ? sourcePaths[0] : null,
    sourceItemCount: sourcePaths.length,
    targetPath: task.remoteTargetPath || null,
  };
}
