import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTransferRoute } from '../../src/utils/transferRoute';

const names: Record<number, string> = { 1: 'src-box', 2: 'web-1', 3: 'web-2', 4: 'db' };
const getName = (id: number) => names[id] ?? `#${id}`;

test('buildTransferRoute：源 → 目标（去重、按顺序），单条目给完整源路径', () => {
  const v = buildTransferRoute({
    sourceConnectionId: 1,
    remoteTargetPath: '/srv/app',
    subTasks: [
      { connectionId: 2, sourceItemName: 'app.tar', sourceItemPath: '/home/u/app.tar' },
      { connectionId: 3, sourceItemName: 'app.tar', sourceItemPath: '/home/u/app.tar' },
      { connectionId: 2, sourceItemName: 'app.tar', sourceItemPath: '/home/u/app.tar' },
    ],
  }, getName);
  assert.equal(v.sourceName, 'src-box');
  assert.deepEqual(v.allTargetNames, ['web-1', 'web-2']);
  assert.equal(v.sourcePath, '/home/u/app.tar');
  assert.equal(v.targetPath, '/srv/app');
  assert.equal(v.hiddenTargetCount, 0);
});

test('buildTransferRoute：优先用 targetConnectionIds；超过上限收成 +N；多条目时 sourcePath 为 null', () => {
  const v = buildTransferRoute({
    sourceConnectionId: 1,
    targetConnectionIds: [2, 3, 4],
    subTasks: [
      { connectionId: 2, sourceItemName: 'a', sourceItemPath: '/a' },
      { connectionId: 2, sourceItemName: 'b', sourceItemPath: '/b' },
    ],
  }, getName, 2);
  assert.deepEqual(v.targetNames, ['web-1', 'web-2']);
  assert.equal(v.hiddenTargetCount, 1);
  assert.equal(v.sourcePath, null);
  assert.equal(v.sourceItemCount, 2);
  assert.equal(v.targetPath, null);
});

test('buildTransferRoute：老任务没有 sourceConnectionId 时 sourceName 为 null（卡片不画路线）', () => {
  assert.equal(buildTransferRoute({ subTasks: [] }, getName).sourceName, null);
});
