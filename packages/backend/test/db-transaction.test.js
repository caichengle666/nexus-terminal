const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');

// connection.js 加载时会创建数据目录，这里指向临时目录。
process.env.APP_BACKEND_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-db-tx-test-'));

const { runDb, getDb, allDb, withTransaction, isInTransaction, runExclusive } = require('../dist/database/connection.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const openDb = async () => {
  const db = new sqlite3.Database(':memory:');
  await runDb(db, 'CREATE TABLE items (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, n INTEGER NOT NULL)');
  await runDb(db, 'CREATE UNIQUE INDEX items_owner_n ON items(owner, n)');
  return db;
};
const close = db => new Promise(resolve => db.close(() => resolve()));
const countOf = async (db, owner) => (await getDb(db, 'SELECT COUNT(*) AS c FROM items WHERE owner = ?', [owner])).c;

test('two overlapping transactions both commit (no "transaction within a transaction")', async () => {
  const db = await openDb();
  try {
    const order = [];
    const txA = withTransaction(db, async () => {
      order.push('A:start');
      for (let i = 0; i < 5; i++) {
        await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['A', i]);
        await sleep(5); // 跨 await，模拟导入里的大量异步步骤
      }
      order.push('A:end');
    });
    const txB = withTransaction(db, async () => {
      order.push('B:start');
      for (let i = 0; i < 5; i++) {
        await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['B', i]);
        await sleep(1);
      }
      order.push('B:end');
    });
    await Promise.all([txA, txB]);
    assert.equal(await countOf(db, 'A'), 5);
    assert.equal(await countOf(db, 'B'), 5);
    // 串行化：B 必须在 A 结束后才开始
    assert.deepEqual(order, ['A:start', 'A:end', 'B:start', 'B:end']);
  } finally {
    await close(db);
  }
});

test('a failing transaction rolls back only itself; overlapping ones and plain writes survive', async () => {
  const db = await openDb();
  try {
    const good = withTransaction(db, async () => {
      for (let i = 0; i < 3; i++) {
        await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['good', i]);
        await sleep(3);
      }
    });
    const bad = withTransaction(db, async () => {
      await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['bad', 0]);
      await sleep(3);
      await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['bad', 1]);
      throw new Error('boom');
    });
    // 一个普通写入（类似审计日志），在事务进行中发出：不能被卷进任何事务
    await sleep(1);
    const plain = runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['plain', 0]);
    const good2 = withTransaction(db, async () => {
      await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['good2', 0]);
    });

    const results = await Promise.allSettled([good, bad, plain, good2]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.match(results[1].reason.message, /boom/);
    assert.equal(results[2].status, 'fulfilled');
    assert.equal(results[3].status, 'fulfilled');

    assert.equal(await countOf(db, 'good'), 3);
    assert.equal(await countOf(db, 'bad'), 0);
    assert.equal(await countOf(db, 'plain'), 1);
    assert.equal(await countOf(db, 'good2'), 1);
  } finally {
    await close(db);
  }
});

test('plain statements issued while a transaction is open wait for it and are not rolled back with it', async () => {
  const db = await openDb();
  try {
    let plainDone = false;
    let sawPlainInsideTx = null;
    const tx = withTransaction(db, async () => {
      await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['tx', 0]);
      // 外部写入在这里发出
      runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['outside', 0]).then(() => { plainDone = true; });
      await sleep(20);
      sawPlainInsideTx = plainDone;
      throw new Error('rollback me');
    });
    // 注意：上面的 runDb 是在事务回调里发出的，属于事务上下文；这里再从外部发一条
    const outsider = (async () => {
      await sleep(5);
      await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['outsider', 0]);
    })();
    await assert.rejects(tx, /rollback me/);
    await outsider;
    assert.equal(sawPlainInsideTx, true, 'statements from inside the tx context run immediately');
    assert.equal(await countOf(db, 'tx'), 0);
    assert.equal(await countOf(db, 'outside'), 0, 'issued inside the tx, rolled back with it');
    assert.equal(await countOf(db, 'outsider'), 1, 'outside writer waited and was not rolled back');
  } finally {
    await close(db);
  }
});

test('nested withTransaction uses a savepoint: no deadlock, inner failure rolls back only the inner part', async () => {
  const db = await openDb();
  try {
    // 模拟“事务里调用了自己也用事务的仓库函数”
    const repoFn = async (owner, fail) => withTransaction(db, async () => {
      assert.equal(isInTransaction(db), true);
      await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', [owner, 0]);
      if (fail) throw new Error('inner fail');
    });

    await withTransaction(db, async () => {
      await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['outer', 0]);
      await repoFn('inner-ok', false);
      await assert.rejects(repoFn('inner-bad', true), /inner fail/);
      // 内层失败后外层事务仍可继续
      await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['outer', 1]);
    });
    assert.equal(isInTransaction(db), false);
    assert.equal(await countOf(db, 'outer'), 2);
    assert.equal(await countOf(db, 'inner-ok'), 1);
    assert.equal(await countOf(db, 'inner-bad'), 0);
  } finally {
    await close(db);
  }
});

test('a constraint error inside one of many concurrent transactions leaves the others intact', async () => {
  const db = await openDb();
  try {
    const jobs = [];
    for (let k = 0; k < 10; k++) {
      jobs.push(withTransaction(db, async () => {
        await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', [`job${k}`, 0]);
        await sleep(Math.random() * 3);
        if (k === 4) {
          await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', [`job${k}`, 0]); // UNIQUE 冲突
        }
        await runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', [`job${k}`, 1]);
      }));
      jobs.push(allDb(db, 'SELECT * FROM items'));
    }
    const results = await Promise.allSettled(jobs);
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    const rows = await allDb(db, 'SELECT owner, COUNT(*) AS c FROM items GROUP BY owner ORDER BY owner');
    assert.equal(rows.length, 9);
    for (const row of rows) assert.equal(row.c, 2);
    assert.equal(rows.some(r => r.owner === 'job4'), false);
  } finally {
    await close(db);
  }
});

test('runExclusive waits for in-flight statements and blocks new ones; refuses to run inside a transaction', async () => {
  const db = await openDb();
  try {
    const rawCount = () => new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS c FROM items WHERE owner = 'p'", (e, r) => (e ? reject(e) : resolve(r.c))));
    const seen = [];
    const plain = runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['p', 0]);
    const exclusive = runExclusive(db, async () => {
      seen.push(await rawCount()); // 之前发出的语句已经完成
      await sleep(10);
      seen.push(await rawCount()); // 之后发出的语句还在排队
    });
    const later = runDb(db, 'INSERT INTO items (owner, n) VALUES (?, ?)', ['p', 1]);
    await Promise.all([plain, exclusive, later]);
    assert.deepEqual(seen, [1, 1]);
    assert.equal(await rawCount(), 2);
    await withTransaction(db, async () => {
      await assert.rejects(runExclusive(db, async () => {}), /事务内/);
    });
  } finally {
    await close(db);
  }
});
