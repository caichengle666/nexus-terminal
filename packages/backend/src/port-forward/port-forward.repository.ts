import { getDbInstance, runDb, getDb as getDbRow, allDb } from '../database/connection';

export type PortForwardType = 'local' | 'remote' | 'dynamic';

/** 一条端口转发规则（按连接绑定，运行态不在这里） */
export interface PortForwardRule {
    id: number;
    connection_id: number;
    type: PortForwardType;
    bind_host: string;
    bind_port: number;
    /** 动态转发（SOCKS）不需要目标 */
    target_host: string | null;
    target_port: number | null;
    /** 1 = 连上/启动后自动恢复 */
    auto_start: number;
    created_at: number;
    updated_at: number;
}

export interface PortForwardRuleInput {
    type: PortForwardType;
    bind_host?: string;
    bind_port: number;
    target_host?: string | null;
    target_port?: number | null;
    auto_start?: boolean | number;
}

const COLUMNS = 'id, connection_id, type, bind_host, bind_port, target_host, target_port, auto_start, created_at, updated_at';

export const listRulesByConnection = async (connectionId: number): Promise<PortForwardRule[]> => {
    const db = await getDbInstance();
    return await allDb<PortForwardRule>(db, `SELECT ${COLUMNS} FROM port_forwards WHERE connection_id = ? ORDER BY id`, [connectionId]);
};

export const listAutoStartRules = async (): Promise<PortForwardRule[]> => {
    const db = await getDbInstance();
    return await allDb<PortForwardRule>(db, `SELECT ${COLUMNS} FROM port_forwards WHERE auto_start = 1 ORDER BY connection_id, id`);
};

export const getRuleById = async (id: number): Promise<PortForwardRule | null> => {
    const db = await getDbInstance();
    const row = await getDbRow<PortForwardRule>(db, `SELECT ${COLUMNS} FROM port_forwards WHERE id = ?`, [id]);
    return row ?? null;
};

export const createRule = async (connectionId: number, input: PortForwardRuleInput): Promise<PortForwardRule> => {
    const db = await getDbInstance();
    const result = await runDb(
        db,
        `INSERT INTO port_forwards (connection_id, type, bind_host, bind_port, target_host, target_port, auto_start)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            connectionId,
            input.type,
            input.bind_host || '127.0.0.1',
            input.bind_port,
            input.target_host ?? null,
            input.target_port ?? null,
            input.auto_start ? 1 : 0,
        ]
    );
    const created = await getRuleById(Number(result.lastID));
    if (!created) throw new Error('端口转发规则创建后读取失败');
    return created;
};

export const updateRule = async (id: number, input: PortForwardRuleInput): Promise<PortForwardRule | null> => {
    const db = await getDbInstance();
    await runDb(
        db,
        `UPDATE port_forwards
            SET type = ?, bind_host = ?, bind_port = ?, target_host = ?, target_port = ?, auto_start = ?,
                updated_at = strftime('%s', 'now')
          WHERE id = ?`,
        [
            input.type,
            input.bind_host || '127.0.0.1',
            input.bind_port,
            input.target_host ?? null,
            input.target_port ?? null,
            input.auto_start ? 1 : 0,
            id,
        ]
    );
    return await getRuleById(id);
};

export const setAutoStart = async (id: number, autoStart: boolean): Promise<void> => {
    const db = await getDbInstance();
    await runDb(db, `UPDATE port_forwards SET auto_start = ?, updated_at = strftime('%s', 'now') WHERE id = ?`, [autoStart ? 1 : 0, id]);
};

export const deleteRule = async (id: number): Promise<void> => {
    const db = await getDbInstance();
    await runDb(db, `DELETE FROM port_forwards WHERE id = ?`, [id]);
};

/** 连接被删时兜底清一遍（FK 已带 CASCADE，这里防止老库 pragma 未开） */
export const deleteRulesByConnection = async (connectionId: number): Promise<void> => {
    const db = await getDbInstance();
    await runDb(db, `DELETE FROM port_forwards WHERE connection_id = ?`, [connectionId]);
};
