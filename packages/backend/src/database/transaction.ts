import { AsyncLocalStorage } from 'async_hooks';
import type sqlite3 from 'sqlite3';

/**
 * 单连接 SQLite 的事务串行化。
 *
 * 整个后端只有一个 sqlite3.Database 连接，事务是连接级别的：只要有一个事务打开，
 * 这条连接上的任何语句都会被卷进去。所以这里做的是一个读写锁：
 * - 事务（withTransaction）是独占的：拿到锁之前要等所有在途的普通语句完成，
 *   持有期间，其他调用方的普通语句（runDb/getDb/allDb）都排队等待。
 * - 普通语句之间是共享的，互不阻塞（与原来的并行行为一致）。
 * - 事务回调内部（通过 AsyncLocalStorage 识别）发出的语句直接执行；回调里再调用
 *   withTransaction 会改用 SAVEPOINT，不会死锁。
 * - 有事务在排队时，新的普通语句先让事务执行（避免事务饿死）；事务结束时先放行
 *   已在等待的普通语句（避免普通语句饿死）。
 */

interface TxToken {
    db: sqlite3.Database;
    active: boolean;
    savepointSeq: number;
}

interface LockState {
    txActive: boolean;
    txQueue: Array<() => void>;
    plainInflight: number;
    plainWaiters: Array<() => void>;
}

type TxStore = ReadonlyMap<sqlite3.Database, TxToken>;

const txContext = new AsyncLocalStorage<TxStore>();
const lockStates = new WeakMap<object, LockState>();

const getLockState = (db: sqlite3.Database): LockState => {
    let state = lockStates.get(db);
    if (!state) {
        state = { txActive: false, txQueue: [], plainInflight: 0, plainWaiters: [] };
        lockStates.set(db, state);
    }
    return state;
};

const currentToken = (db: sqlite3.Database): TxToken | undefined => {
    const token = txContext.getStore()?.get(db);
    return token && token.active ? token : undefined;
};

/** 当前异步上下文是否持有该连接上的事务。 */
export const isInTransaction = (db: sqlite3.Database): boolean => currentToken(db) !== undefined;

const grantPlainWaiters = (state: LockState): void => {
    const waiters = state.plainWaiters;
    state.plainWaiters = [];
    for (const resolve of waiters) {
        state.plainInflight++;
        resolve();
    }
};

const grantNextTx = (state: LockState): boolean => {
    if (state.txActive || state.plainInflight > 0 || state.txQueue.length === 0) return false;
    state.txActive = true;
    const next = state.txQueue.shift()!;
    next();
    return true;
};

const acquirePlain = (state: LockState): Promise<void> | void => {
    if (!state.txActive && state.txQueue.length === 0) {
        state.plainInflight++;
        return;
    }
    return new Promise<void>(resolve => state.plainWaiters.push(resolve));
};

const releasePlain = (state: LockState): void => {
    state.plainInflight = Math.max(0, state.plainInflight - 1);
    if (state.plainInflight === 0) grantNextTx(state);
};

const acquireTx = (state: LockState): Promise<void> | void => {
    if (!state.txActive && state.txQueue.length === 0 && state.plainInflight === 0) {
        state.txActive = true;
        return;
    }
    return new Promise<void>(resolve => state.txQueue.push(resolve));
};

const releaseTx = (state: LockState): void => {
    state.txActive = false;
    if (state.plainWaiters.length > 0) {
        grantPlainWaiters(state);
        // 普通语句完成后（plainInflight 归零）会在 releasePlain 里放行下一个事务。
        return;
    }
    grantNextTx(state);
};

/**
 * 在锁的保护下执行一条普通语句。事务内部（同一异步上下文）直接执行。
 */
export const runSerialized = async <T>(db: sqlite3.Database, op: () => Promise<T>): Promise<T> => {
    if (currentToken(db)) {
        return op();
    }
    const state = getLockState(db);
    const pending = acquirePlain(state);
    if (pending) await pending;
    try {
        return await op();
    } finally {
        releasePlain(state);
    }
};

/**
 * 独占这条连接执行 op（不开事务）：等在途语句全部完成、期间其他语句排队。
 * 用于 VACUUM INTO 这类要求“连接上没有其他语句在执行”且不能在事务内运行的操作。
 */
export const runExclusive = async <T>(db: sqlite3.Database, op: () => Promise<T>): Promise<T> => {
    if (currentToken(db)) {
        throw new Error('runExclusive 不能在事务内调用');
    }
    const state = getLockState(db);
    const pending = acquireTx(state);
    if (pending) await pending;
    try {
        return await op();
    } finally {
        releaseTx(state);
    }
};

const rawRun = (db: sqlite3.Database, sql: string): Promise<void> =>
    new Promise((resolve, reject) => {
        db.run(sql, [], (err: Error | null) => (err ? reject(err) : resolve()));
    });

export interface TransactionOptions {
    /** IMMEDIATE 会在 BEGIN 时就拿写锁（用于整库恢复等大批量写入）。 */
    mode?: 'DEFERRED' | 'IMMEDIATE';
}

/**
 * 在一个串行化的事务里执行 fn。fn 成功则 COMMIT，抛错则 ROLLBACK 并把原错误抛出。
 * fn 内部的 runDb/getDb/allDb 以及它调用的仓库函数都会落在这个事务里；
 * 嵌套调用 withTransaction 时使用 SAVEPOINT，内层失败只回滚内层。
 */
export const withTransaction = async <T>(
    db: sqlite3.Database,
    fn: () => Promise<T>,
    options: TransactionOptions = {},
): Promise<T> => {
    const outer = currentToken(db);
    if (outer) {
        const name = `nx_sp_${++outer.savepointSeq}`;
        await rawRun(db, `SAVEPOINT ${name}`);
        try {
            const result = await fn();
            await rawRun(db, `RELEASE ${name}`);
            return result;
        } catch (error) {
            try {
                await rawRun(db, `ROLLBACK TO ${name}`);
                await rawRun(db, `RELEASE ${name}`);
            } catch (rollbackError: any) {
                console.error(`[数据库] 回滚保存点 ${name} 失败:`, rollbackError?.message ?? rollbackError);
            }
            throw error;
        }
    }

    const state = getLockState(db);
    const pending = acquireTx(state);
    if (pending) await pending;

    const token: TxToken = { db, active: true, savepointSeq: 0 };
    try {
        await rawRun(db, options.mode === 'IMMEDIATE' ? 'BEGIN IMMEDIATE TRANSACTION' : 'BEGIN TRANSACTION');
        try {
            const store = new Map(txContext.getStore() ?? []);
            store.set(db, token);
            const result = await txContext.run(store, fn);
            await rawRun(db, 'COMMIT');
            return result;
        } catch (error) {
            try {
                await rawRun(db, 'ROLLBACK');
            } catch (rollbackError: any) {
                console.error('[数据库] 回滚事务失败:', rollbackError?.message ?? rollbackError);
            }
            throw error;
        }
    } finally {
        // 事务结束后，回调里遗留的“即发即忘”语句不再被当作事务内语句直接执行。
        token.active = false;
        releaseTx(state);
    }
};
