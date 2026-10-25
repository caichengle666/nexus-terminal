
import * as ConnectionRepository from '../connections/connection.repository';
import * as ProxyRepository from '../proxies/proxy.repository';
import * as TagService from '../tags/tag.service';
import { encrypt } from '../utils/crypto'; 
import { getDbInstance, runDb, getDb as getDbRow, allDb } from '../database/connection';
import { decrypt, getEncryptionKeyBuffer as getCryptoKeyBuffer } from '../utils/crypto'; 
import { getAllDecryptedSshKeys, DecryptedSshKeyDetails } from '../ssh_keys/ssh_key.service'; 
import { EncryptedZipArchive } from '../utils/encrypted-zip-archive';
import { isZipBuffer, readZipEntries, ZipPasswordError } from '../utils/zip-aes';




/** 端口转发规则（随连接导出；仅桌面端会真正运行） */
export interface ExportPortForwardRule {
    type: 'local' | 'remote' | 'dynamic';
    bind_host: string;
    bind_port: number;
    target_host?: string | null;
    target_port?: number | null;
    auto_start?: boolean;
}

interface ImportedConnectionData {
    name: string;
    type: 'SSH' | 'RDP' | 'VNC'; 
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key'; // For SSH
    // Plaintext fields for export
    password?: string | null;
    private_key?: string | null;
    passphrase?: string | null;
    // Encrypted fields might still be part of the base ImportedConnectionData if it's used elsewhere
    encrypted_password?: string | null;
    encrypted_private_key?: string | null;
    encrypted_passphrase?: string | null;
    tag_ids?: number[];
    tag_names?: string[];
    ssh_key_name?: string | null;
    notes?: string | null;
    // 跳板机 (v2 导出新增；旧文件没有这些字段)
    id?: number | null; // 导出时的原连接 ID，仅用于解析 jump_chain
    proxy_type?: 'proxy' | 'jump' | null;
    jump_chain?: number[] | null; // 原连接 ID (导出端)
    jump_chain_names?: string[] | null; // 跳板机连接名称 (优先用于解析)
    port_forwards?: ExportPortForwardRule[] | null; // 端口转发规则 (v2 新增，可选)
    proxy?: {
        name: string;
        type: 'SOCKS5' | 'HTTP';
        host: string;
        port: number;
        username?: string | null;
        auth_method?: 'none' | 'password' | 'key'; // For proxy
        // Plaintext fields for proxy export
        password?: string | null;
        private_key?: string | null; // If proxy uses key auth
        passphrase?: string | null; // If proxy key has passphrase
        // Encrypted fields for proxy
        encrypted_password?: string | null;
        encrypted_private_key?: string | null;
        encrypted_passphrase?: string | null;
    } | null;
}

// This will represent the structure of the data *before* it's put into the JSON for export,
// containing plaintext sensitive info.
interface PlaintextExportConnectionData {
    id: number;
    name: string;
    type: 'SSH' | 'RDP' | 'VNC';
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key'; // SSH auth method
    password?: string | null; // Plaintext password
    private_key?: string | null; // Plaintext private key
    passphrase?: string | null; // Plaintext passphrase for key
    ssh_key_id?: number | null; // +++ Add SSH Key ID +++
    tag_ids?: number[];
    notes?: string | null;
    proxy_type?: 'proxy' | 'jump' | null; // 连接自身的代理/跳板机模式
    jump_chain?: number[] | null; // 跳板机连接 ID 列表
    proxy?: {
        name: string;
        type: 'SOCKS5' | 'HTTP';
        host: string;
        port: number;
        username?: string | null;
        auth_method?: 'none' | 'password' | 'key'; // Proxy auth method
        password?: string | null; // Plaintext proxy password
        private_key?: string | null; // Plaintext proxy private key
        passphrase?: string | null; // Plaintext proxy key passphrase
    } | null;
}

export interface ImportResult {
    successCount: number;
    failureCount: number;
    errors: { connectionName?: string; message: string }[];
}


/**
 * 获取所有连接的明文数据以供导出。
 * 敏感信息将被解密。
 */
const getPlaintextConnectionsData = async (): Promise<PlaintextExportConnectionData[]> => {
    try {
        const db = await getDbInstance();

        // Ensure ExportRow reflects the updated FullConnectionData (which now includes 'type')
        // 注意：c.* 中已包含连接自身的 proxy_type ('proxy' | 'jump')，代理服务器类型使用别名 proxy_server_type，避免覆盖
        type ExportRow = Omit<ConnectionRepository.FullConnectionData, 'jump_chain'> & { // FullConnectionData 包含 ssh_key_id
             jump_chain: string | null; // DB 中以 JSON 字符串存储
             proxy_db_id: number | null;
             proxy_name: string | null;
             proxy_server_type: 'SOCKS5' | 'HTTP' | null;
             proxy_host: string | null;
             proxy_port: number | null;
             proxy_username: string | null;
             proxy_auth_method: 'none' | 'password' | 'key' | null;
             proxy_encrypted_password?: string | null;
             proxy_encrypted_private_key?: string | null;
             proxy_encrypted_passphrase?: string | null;
        };


        const connectionsWithProxies = await allDb<ExportRow>(db,
            `SELECT
                c.*,
                p.id as proxy_db_id, p.name as proxy_name, p.type as proxy_server_type,
                p.host as proxy_host, p.port as proxy_port, p.username as proxy_username,
                p.auth_method as proxy_auth_method,
                p.encrypted_password as proxy_encrypted_password,
                p.encrypted_private_key as proxy_encrypted_private_key,
                p.encrypted_passphrase as proxy_encrypted_passphrase
             FROM connections c
             LEFT JOIN proxies p ON c.proxy_id = p.id
             ORDER BY c.name ASC`
        );


        const tagRows = await allDb<{ connection_id: number, tag_id: number }>(db,
            'SELECT connection_id, tag_id FROM connection_tags'
        );


        const tagsMap: { [connId: number]: number[] } = {};
        tagRows.forEach(row => {
            if (!tagsMap[row.connection_id]) tagsMap[row.connection_id] = [];
            tagsMap[row.connection_id].push(row.tag_id);
        });


        const formattedData: PlaintextExportConnectionData[] = connectionsWithProxies.map(row => {
            // Decrypt main connection sensitive data
            let plainPassword = null;
            if (row.encrypted_password) {
                try { plainPassword = decrypt(row.encrypted_password); }
                catch (e) { console.warn(`解密连接 [${row.name}] 密码失败: ${(e as Error).message}`); }
            }
            let plainPrivateKey = null;
            if (row.encrypted_private_key) {
                try { plainPrivateKey = decrypt(row.encrypted_private_key); }
                catch (e) { console.warn(`解密连接 [${row.name}] 私钥失败: ${(e as Error).message}`); }
            }
            let plainPassphrase = null;
            if (row.encrypted_passphrase) {
                try { plainPassphrase = decrypt(row.encrypted_passphrase); }
                catch (e) { console.warn(`解密连接 [${row.name}] 私钥密码失败: ${(e as Error).message}`); }
            }

            let jumpChain: number[] | null = null;
            if (row.jump_chain) {
                try {
                    const parsedChain = JSON.parse(row.jump_chain);
                    if (Array.isArray(parsedChain)) {
                        const ids = parsedChain.filter((id: unknown): id is number => typeof id === 'number');
                        jumpChain = ids.length > 0 ? ids : null;
                    }
                } catch (e) { console.warn(`解析连接 [${row.name}] 跳板机配置失败: ${(e as Error).message}`); }
            }

            const connection: PlaintextExportConnectionData = {
                id: row.id,
                name: row.name ?? 'Unnamed',
                type: row.type,
                host: row.host,
                port: row.port,
                username: row.username,
                auth_method: row.auth_method, // Keep auth_method as is
                password: plainPassword,
                private_key: plainPrivateKey,
                passphrase: plainPassphrase,
                ssh_key_id: (row.type === 'SSH' && row.auth_method === 'key') ? row.ssh_key_id : null, // +++ Populate SSH Key ID +++
                tag_ids: tagsMap[row.id] || [],
                notes: row.notes ?? null,
                proxy_type: row.proxy_type ?? null,
                jump_chain: jumpChain,
                proxy: null
            };

            if (row.proxy_db_id && row.proxy_name && row.proxy_server_type && row.proxy_host && row.proxy_port !== null) {
                // Decrypt proxy sensitive data
                let proxyPlainPassword = null;
                if (row.proxy_encrypted_password) {
                    try { proxyPlainPassword = decrypt(row.proxy_encrypted_password); }
                    catch (e) { console.warn(`解密代理 [${row.proxy_name}] 密码失败: ${(e as Error).message}`); }
                }
                let proxyPlainPrivateKey = null;
                if (row.proxy_encrypted_private_key) {
                    try { proxyPlainPrivateKey = decrypt(row.proxy_encrypted_private_key); }
                    catch (e) { console.warn(`解密代理 [${row.proxy_name}] 私钥失败: ${(e as Error).message}`); }
                }
                let proxyPlainPassphrase = null;
                if (row.proxy_encrypted_passphrase) {
                    try { proxyPlainPassphrase = decrypt(row.proxy_encrypted_passphrase); }
                    catch (e) { console.warn(`解密代理 [${row.proxy_name}] 私钥密码失败: ${(e as Error).message}`); }
                }

                connection.proxy = {
                    name: row.proxy_name,
                    type: row.proxy_server_type,
                    host: row.proxy_host,
                    port: row.proxy_port,
                    username: row.proxy_username,
                    auth_method: row.proxy_auth_method ?? 'none',
                    password: proxyPlainPassword,
                    private_key: proxyPlainPrivateKey,
                    passphrase: proxyPlainPassphrase,
                };
            }
            return connection;
        });

        return formattedData;

    } catch (err: any) {
        console.error('Service: 获取明文连接数据时出错:', err.message);
        throw new Error(`获取明文连接数据失败: ${err.message}`);
    }
};

/**
 * 导出所有连接配置为一个加密的 ZIP 文件。
 * @param includeSshKeys 是否包含 SSH 密钥
 * @returns Buffer 包含加密的 ZIP 文件内容 (IV + Ciphertext + AuthTag)。
 */

// 辅助函数：安全地转义 CLI 参数，如果参数包含空格或引号，则用双引号括起来
export interface ExportJsonData {
    version: number;
    exported_at: string;
    tags: { id: number; name: string }[];
    connections: {
        name: string;
        type: 'SSH' | 'RDP' | 'VNC';
        host: string;
        port: number;
        username: string;
        auth_method: 'password' | 'key';
        password?: string | null;
        private_key?: string | null;
        passphrase?: string | null;
        ssh_key_name?: string | null;
        notes?: string | null;
        tag_names?: string[];
        id?: number;
        proxy_type?: 'proxy' | 'jump' | null;
        jump_chain?: number[];
        jump_chain_names?: string[];
        port_forwards?: ExportPortForwardRule[];
        proxy?: {
            name: string;
            type: 'SOCKS5' | 'HTTP';
            host: string;
            port: number;
            username?: string | null;
            auth_method?: 'none' | 'password' | 'key';
            password?: string | null;
        } | null;
    }[];
    ssh_keys?: { name: string; private_key: string; passphrase?: string | null }[];
}

/** 读出全部端口转发规则，按连接分组（只导出配置，不导出运行态） */
const getPortForwardsByConnection = async (): Promise<Map<number, ExportPortForwardRule[]>> => {
    const map = new Map<number, ExportPortForwardRule[]>();
    try {
        const db = await getDbInstance();
        const rows = await allDb<{ connection_id: number; type: ExportPortForwardRule['type']; bind_host: string; bind_port: number; target_host: string | null; target_port: number | null; auto_start: number }>(
            db,
            'SELECT connection_id, type, bind_host, bind_port, target_host, target_port, auto_start FROM port_forwards ORDER BY connection_id, id'
        );
        for (const row of rows) {
            const rule: ExportPortForwardRule = { type: row.type, bind_host: row.bind_host, bind_port: row.bind_port, auto_start: !!row.auto_start };
            if (row.type !== 'dynamic') {
                rule.target_host = row.target_host;
                rule.target_port = row.target_port;
            }
            const list = map.get(row.connection_id) ?? [];
            list.push(rule);
            map.set(row.connection_id, list);
        }
    } catch (err: any) {
        console.warn('Service: 读取端口转发规则失败，导出将不包含端口转发:', err.message);
    }
    return map;
};

const isValidImportPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;
const IMPORT_HOST_RE = /^[A-Za-z0-9._:\-\[\]%]{1,253}$/;

/** 校验导入文件里的一条端口转发规则；不合法返回 null（跳过该条，不影响连接本身） */
export const normalizeImportedPortForward = (raw: any): ExportPortForwardRule | null => {
    if (!raw || typeof raw !== 'object') return null;
    const type = raw.type;
    if (type !== 'local' && type !== 'remote' && type !== 'dynamic') return null;
    const bindHost = typeof raw.bind_host === 'string' && raw.bind_host.trim() ? raw.bind_host.trim() : '127.0.0.1';
    if (!IMPORT_HOST_RE.test(bindHost) || !isValidImportPort(raw.bind_port)) return null;
    if (type === 'dynamic') {
        return { type, bind_host: bindHost, bind_port: raw.bind_port, target_host: null, target_port: null, auto_start: !!raw.auto_start };
    }
    const targetHost = typeof raw.target_host === 'string' ? raw.target_host.trim() : '';
    if (!targetHost || !IMPORT_HOST_RE.test(targetHost) || !isValidImportPort(raw.target_port)) return null;
    return { type, bind_host: bindHost, bind_port: raw.bind_port, target_host: targetHost, target_port: raw.target_port, auto_start: !!raw.auto_start };
};

export const exportConnectionsAsJson = async (): Promise<Buffer> => {
    const connectionsData = await getPlaintextConnectionsData();
    const allTags = await TagService.getAllTags();
    const allSshKeys = await getAllDecryptedSshKeys();

    const tagsMap = new Map(allTags.map(tag => [tag.id, tag.name]));
    const sshKeyNames = new Map(allSshKeys.map(k => [k.id, k.name]));

    const connectionNamesById = new Map(connectionsData.map(c => [c.id, c.name]));
    const portForwardsByConnection = await getPortForwardsByConnection();

    const exportData: ExportJsonData = {
        version: 2, // v2: 新增 id / proxy_type / jump_chain / jump_chain_names (导入兼容 v1)
        exported_at: new Date().toISOString(),
        tags: allTags.map(t => ({ id: t.id, name: t.name })),
        connections: connectionsData.map(conn => {
            const tagNames = (conn.tag_ids || [])
                .map(id => tagsMap.get(id))
                .filter((n): n is string => !!n);

            const result: ExportJsonData['connections'][0] = {
                id: conn.id,
                name: conn.name || `${conn.username}@${conn.host}`,
                type: conn.type,
                host: conn.host,
                port: conn.port,
                username: conn.username,
                auth_method: conn.auth_method,
            };

            if (conn.password) result.password = conn.password;
            if (conn.private_key) result.private_key = conn.private_key;
            if (conn.passphrase) result.passphrase = conn.passphrase;
            if (conn.ssh_key_id && sshKeyNames.has(conn.ssh_key_id)) {
                result.ssh_key_name = sshKeyNames.get(conn.ssh_key_id)!;
            }

            if (conn.notes) result.notes = conn.notes;

            if (tagNames.length > 0) result.tag_names = tagNames;

            if (conn.proxy_type) result.proxy_type = conn.proxy_type;
            if (conn.jump_chain && conn.jump_chain.length > 0) {
                // 名称用于在目标实例上解析 (ID 会变化)；ID 作为同一文件内的后备映射
                result.jump_chain = [...conn.jump_chain];
                result.jump_chain_names = conn.jump_chain.map(id => connectionNamesById.get(id) ?? '');
            }

            const rules = portForwardsByConnection.get(conn.id);
            if (rules && rules.length > 0) result.port_forwards = rules;

            if (conn.proxy) {
                result.proxy = {
                    name: conn.proxy.name,
                    type: conn.proxy.type,
                    host: conn.proxy.host,
                    port: conn.proxy.port,
                    username: conn.proxy.username || null,
                    auth_method: conn.proxy.auth_method || 'none',
                    password: conn.proxy.password || null,
                };
            }

            return result;
        }),
        ssh_keys: allSshKeys.map(k => ({
            name: k.name!,
            private_key: k.privateKey!,
            passphrase: k.passphrase || null,
        })),
    };

    const jsonStr = JSON.stringify(exportData, null, 2);
    return Buffer.from(jsonStr, 'utf8');
};

export const MIN_EXPORT_PASSPHRASE_LENGTH = 8;

/**
 * 导出为 AES-256 加密的 ZIP (可用 7-Zip 等打开)，内含可直接导入的 connections.json。
 * ZIP 密码由用户在导出时指定 (不再使用服务器的 ENCRYPTION_KEY)。
 */
export const exportConnectionsAsPassphraseZip = async (passphrase: string): Promise<Buffer> => {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH) {
        throw new Error(`导出密码至少需要 ${MIN_EXPORT_PASSPHRASE_LENGTH} 个字符。`);
    }
    const json = await exportConnectionsAsJson();
    return new Promise<Buffer>((resolve, reject) => {
        const archive = new EncryptedZipArchive({
            zlib: { level: 9 },
            encryptionMethod: 'aes256',
            password: passphrase,
        });
        const buffers: Buffer[] = [];
        archive.on('data', (chunk: Buffer) => buffers.push(chunk));
        archive.on('warning', (err: Error) => console.warn('Archiver warning during export:', err.message));
        archive.on('error', (err: Error) => reject(new Error(`导出 ZIP 失败: ${err.message}`)));
        archive.append(json, { name: 'connections.json' });
        archive.finalize()
            .then(() => resolve(Buffer.concat(buffers)))
            .catch((err: Error) => reject(new Error(`导出 ZIP 失败: ${err.message}`)));
    });
};

// --- 旧版 ZIP 导出 (ENCRYPTION_KEY 加密，内含 connections.txt 脚本格式) 的解析 ---

/** 按旧导出器 escapeCliArgument 的规则切分：空白分隔，双引号包裹，\" 转义 */
export const tokenizeLegacyScriptLine = (line: string): string[] => {
    const tokens: string[] = [];
    let i = 0;
    while (i < line.length) {
        while (i < line.length && /\s/.test(line[i])) i++;
        if (i >= line.length) break;
        if (line[i] === '"') {
            i++;
            let value = '';
            while (i < line.length && line[i] !== '"') {
                if (line[i] === '\\' && line[i + 1] === '"') { value += '"'; i += 2; continue; }
                value += line[i++];
            }
            i++; // 跳过结束引号
            tokens.push(value);
        } else {
            let value = '';
            while (i < line.length && !/\s/.test(line[i])) value += line[i++];
            tokens.push(value);
        }
    }
    return tokens;
};

const LEGACY_FLAGS = new Set(['-type', '-name', '-p', '-k', '-passphrase', '-tags', '-note']);

/** 把旧版 connections.txt + ssh_keys/*.txt 转为 v2 JSON 导入结构 */
export const parseLegacyScriptExport = (script: string, keyFiles: Map<string, string>): ExportJsonData => {
    const connections: ExportJsonData['connections'] = [];
    const keyPassphrases = new Map<string, string>();
    const tagSet = new Set<string>();
    for (const rawLine of script.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const tokens = tokenizeLegacyScriptLine(line);
        const target = tokens.shift() || '';
        const at = target.lastIndexOf('@');
        const colon = target.lastIndexOf(':');
        if (at <= 0 || colon <= at) continue;
        const username = target.slice(0, at);
        const host = target.slice(at + 1, colon).replace(/^\[|\]$/g, '');
        const port = Number.parseInt(target.slice(colon + 1), 10) || 22;
        const flags: Record<string, string> = {};
        const tags: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
            const flag = tokens[i];
            if (!LEGACY_FLAGS.has(flag)) continue;
            if (flag === '-tags') {
                while (i + 1 < tokens.length && !LEGACY_FLAGS.has(tokens[i + 1])) tags.push(tokens[++i]);
                continue;
            }
            flags[flag] = tokens[i + 1] ?? '';
            i++;
        }
        const type = (flags['-type'] || 'SSH').toUpperCase() as 'SSH' | 'RDP' | 'VNC';
        const conn: any = {
            name: flags['-name'] || `${username}@${host}`,
            type,
            host,
            port,
            username,
            auth_method: flags['-k'] ? 'key' : 'password',
        };
        if (flags['-p']) conn.password = flags['-p'];
        if (flags['-k']) {
            conn.ssh_key_name = flags['-k'];
            if (flags['-passphrase']) keyPassphrases.set(flags['-k'], flags['-passphrase']);
        }
        if (flags['-note']) conn.notes = flags['-note'];
        const cleanTags = tags.filter(Boolean);
        if (cleanTags.length > 0) {
            conn.tag_names = cleanTags;
            cleanTags.forEach(t => tagSet.add(t));
        }
        connections.push(conn);
    }
    const ssh_keys = [...keyFiles.entries()].map(([name, privateKey]) => ({
        name,
        private_key: privateKey,
        passphrase: keyPassphrases.get(name) || null,
    }));
    return {
        version: 2,
        exported_at: new Date().toISOString(),
        tags: [...tagSet].map((name, index) => ({ id: index + 1, name })),
        connections,
        ssh_keys,
    };
};

export class ImportPassphraseError extends Error {
    code = 'IMPORT_PASSPHRASE_INVALID';
    constructor(message: string) { super(message); this.name = 'ImportPassphraseError'; }
}

/**
 * 解析上传的导入文件，返回 JSON Buffer：
 * - .json：原样返回 (旧版前端导出的明文 JSON)
 * - .zip：先用用户提供的密码解密；失败时再尝试 ENCRYPTION_KEY (旧版 ZIP 导出)。
 *   内含 connections.json 直接使用；只有 connections.txt (旧脚本格式) 时转换为 JSON。
 */
export const resolveImportPayload = (fileBuffer: Buffer, passphrase?: string): Buffer => {
    if (!isZipBuffer(fileBuffer)) return fileBuffer;
    const candidates = [passphrase, process.env.ENCRYPTION_KEY].filter((p): p is string => typeof p === 'string' && p.length > 0);
    let entries: Map<string, Buffer> | null = null;
    let lastError: any = null;
    for (const candidate of candidates) {
        try {
            entries = readZipEntries(fileBuffer, candidate);
            break;
        } catch (error: any) {
            lastError = error;
            if (!(error instanceof ZipPasswordError)) break;
        }
    }
    if (!entries) {
        if (!lastError || lastError instanceof ZipPasswordError) {
            throw new ImportPassphraseError(passphrase ? '导入文件密码错误。' : '该导入文件已加密，请输入导出时设置的密码。');
        }
        throw new Error(`读取 ZIP 文件失败: ${lastError.message}`);
    }
    const json = entries.get('connections.json');
    if (json) return json;
    const script = entries.get('connections.txt');
    if (script) {
        const keyFiles = new Map<string, string>();
        for (const [name, data] of entries) {
            const match = /^ssh_keys\/(.+)\.txt$/.exec(name);
            if (match) keyFiles.set(match[1], data.toString('utf8'));
        }
        return Buffer.from(JSON.stringify(parseLegacyScriptExport(script.toString('utf8'), keyFiles)), 'utf8');
    }
    throw new Error('ZIP 中未找到 connections.json。');
};


/**
 * 导入第二遍：解析跳板机链。
 * 解析顺序：本次导入中同名的连接 → 同一文件中的原 ID → 数据库中已存在的同名连接。
 * 无法解析的跳板机会被跳过，并返回提示 (连接本身仍会导入)。
 * 注意：应在导入事务中调用。
 */
const resolveImportedJumpChains = async (
    db: Awaited<ReturnType<typeof getDbInstance>>,
    insertedResults: { connectionId: number; originalData: any }[]
): Promise<{ connectionName?: string; message: string }[]> => {
    const warnings: { connectionName?: string; message: string }[] = [];
    const importedByName = new Map<string, { id: number; type: string }>();
    const importedByOldId = new Map<number, { id: number; type: string }>();
    for (const r of insertedResults) {
        const data = r.originalData;
        if (data?.name && !importedByName.has(data.name)) importedByName.set(data.name, { id: r.connectionId, type: data.type });
        if (typeof data?.import_old_id === 'number') importedByOldId.set(data.import_old_id, { id: r.connectionId, type: data.type });
    }

    for (const r of insertedResults) {
        const data = r.originalData;
        const names: string[] = Array.isArray(data?.import_jump_chain_names) ? data.import_jump_chain_names : [];
        const oldIds: number[] = Array.isArray(data?.import_jump_chain_old_ids) ? data.import_jump_chain_old_ids : [];
        const hopCount = Math.max(names.length, oldIds.length);
        if (hopCount === 0) continue;

        const resolved: number[] = [];
        const unresolved: string[] = [];
        for (let i = 0; i < hopCount; i++) {
            const name = names[i];
            const oldId = oldIds[i];
            let target: { id: number; type: string } | undefined;
            if (name) target = importedByName.get(name);
            if (!target && typeof oldId === 'number') target = importedByOldId.get(oldId);
            if (!target && name) {
                const existing = await getDbRow<{ id: number; type: string }>(db, 'SELECT id, type FROM connections WHERE name = ? ORDER BY id ASC LIMIT 1', [name]);
                if (existing) target = existing;
            }
            if (!target || target.type !== 'SSH' || target.id === r.connectionId || resolved.includes(target.id)) {
                unresolved.push(name || (typeof oldId === 'number' ? `#${oldId}` : `#${i + 1}`));
                continue;
            }
            resolved.push(target.id);
        }

        if (resolved.length > 0) {
            await runDb(db, 'UPDATE connections SET jump_chain = ? WHERE id = ?', [JSON.stringify(resolved), r.connectionId]);
        } else if (data?.proxy_type === 'jump') {
            // 跳板机全部无法解析：回退为直连，避免保存一个空的跳板机模式
            await runDb(db, 'UPDATE connections SET proxy_type = NULL WHERE id = ?', [r.connectionId]);
        }
        if (unresolved.length > 0) {
            warnings.push({
                connectionName: data?.name,
                message: `已导入，但以下跳板机未找到 (已忽略): ${unresolved.join(', ')}`,
            });
        }
    }
    return warnings;
};

/**
 * 导入连接配置
 * @param fileBuffer Buffer containing the JSON file content
 */
export const importConnections = async (fileBuffer: Buffer): Promise<ImportResult> => {
    let importedData: ImportedConnectionData[];
    let importTags: { id: number; name: string }[] = [];
    let importSshKeys: { name: string; private_key: string; passphrase?: string | null }[] = [];

    try {
        const fileContent = fileBuffer.toString('utf8');
        const parsed = JSON.parse(fileContent);

        // Support both array format (legacy) and object format (new with tags)
        if (Array.isArray(parsed)) {
            importedData = parsed;
        } else if (parsed && Array.isArray(parsed.connections)) {
            importedData = parsed.connections;
            importTags = parsed.tags || [];
            importSshKeys = parsed.ssh_keys || [];
        } else {
            throw new Error('JSON content must be an array or an object with a connections array.');
        }
    } catch (error: any) {
        console.error('Service: 解析导入文件失败:', error);
        throw new Error(`解析 JSON 文件失败: ${error.message}`);
    }

    let successCount = 0;
    let failureCount = 0;
    const errors: { connectionName?: string; message: string }[] = [];
    const db = await getDbInstance();

    try {
        await runDb(db, 'BEGIN TRANSACTION');

        // Create/reuse tags by name
        const tagNameToId: { [name: string]: number } = {};
        for (const tagName of importTags.map(t => t.name)) {
            try {
                const existing = await TagService.getTagByName(tagName);
                if (existing) {
                    tagNameToId[tagName] = existing.id;
                } else {
                    const newTag = await TagService.createTag(tagName);
                    tagNameToId[tagName] = newTag.id;
                }
            } catch (err: any) {
                if (err.message.includes('已存在')) {
                    const existing = await TagService.getTagByName(tagName);
                    if (existing) tagNameToId[tagName] = existing.id;
                } else {
                    console.warn(`Service: 创建标签 "${tagName}" 失败: ${err.message}`);
                }
            }
        }

        // Import SSH keys
        const sshKeyNameToId: { [name: string]: number } = {};
        if (importSshKeys.length > 0) {
            
            for (const keyData of importSshKeys) {
                try {
                    const existingKeys = await getAllDecryptedSshKeys();
                    const existing = existingKeys.find(k => k.name === keyData.name);
                    if (existing) {
                        sshKeyNameToId[keyData.name] = existing.id!;
                    } else {
                        const encKey = encrypt(keyData.private_key);
                        const encPassphrase = keyData.passphrase ? encrypt(keyData.passphrase) : null;
                        const insertKeySql = `INSERT INTO ssh_keys (name, encrypted_private_key, encrypted_passphrase) VALUES (?, ?, ?)`;
                        const result = await runDb(db, insertKeySql, [keyData.name, encKey, encPassphrase]);
                        sshKeyNameToId[keyData.name] = result.lastID;
                    }
                } catch (err: any) {
                    console.warn(`Service: 导入 SSH 密钥 "${keyData.name}" 失败: ${err.message}`);
                }
            }
        }

        type ConnectionToInsert = Omit<ConnectionRepository.FullConnectionData, 'id' | 'created_at' | 'updated_at' | 'last_connected_at'> & {
            tag_ids?: number[];
            tag_names?: string[];
            ssh_key_id?: number | null;
            notes?: string | null;
            // 仅用于第二遍解析跳板机链 (不写入数据库)
            import_old_id?: number | null;
            import_jump_chain_names?: string[] | null;
            import_jump_chain_old_ids?: number[] | null;
            import_port_forwards?: unknown[] | null;
        };
        const connectionsToInsert: ConnectionToInsert[] = [];
        const proxyCache: { [key: string]: number } = {};

        for (const connData of importedData) {
             try {

                // Validate imported data, including type
                if (!connData.type || !['SSH', 'RDP', 'VNC'].includes(connData.type)) {
                    throw new Error('缺少或无效的连接类型 (type)。');
                }
                if (!connData.name || !connData.host || !connData.port || !connData.username) {
                    throw new Error('缺少必要的连接字段 (name, host, port, username)。');
                }
                // Validate SSH specific fields only if type is SSH
                if (connData.type === 'SSH' && (!connData.auth_method || !['password', 'key'].includes(connData.auth_method))) {
                     throw new Error('SSH 连接缺少有效的认证方式 (auth_method)。');
                }
                // RDP specific validation (e.g., password required) could be added here if needed


                let proxyIdToUse: number | null = null;

                if (connData.proxy) {
                    const proxyData = connData.proxy;
                    if (!proxyData.name || !proxyData.type || !proxyData.host || !proxyData.port) {
                        throw new Error('代理信息不完整 (缺少 name, type, host, port)。');
                    }
                    const cacheKey = `${proxyData.name}-${proxyData.type}-${proxyData.host}-${proxyData.port}`;
                    if (proxyCache[cacheKey]) {
                        proxyIdToUse = proxyCache[cacheKey];
                    } else {
                        const existingProxy = await ProxyRepository.findProxyByNameTypeHostPort(proxyData.name, proxyData.type, proxyData.host, proxyData.port);
                        if (existingProxy) {
                            proxyIdToUse = existingProxy.id;
                        } else {
                            const newProxyData: Omit<ProxyRepository.ProxyData, 'id' | 'created_at' | 'updated_at'> = {
                                name: proxyData.name,
                                type: proxyData.type,
                                host: proxyData.host,
                                port: proxyData.port,
                                username: proxyData.username || null,
                                auth_method: proxyData.auth_method || 'none',
                                encrypted_password: proxyData.encrypted_password || null,
                                encrypted_private_key: proxyData.encrypted_private_key || null,
                                encrypted_passphrase: proxyData.encrypted_passphrase || null,
                            };
                            proxyIdToUse = await ProxyRepository.createProxy(newProxyData);
                            console.log(`Service: 导入连接 ${connData.name}: 新代理 ${proxyData.name} 创建成功 (ID: ${proxyIdToUse})`);
                        }
                        if (proxyIdToUse) proxyCache[cacheKey] = proxyIdToUse; 
                    }
                }

                // Prepare data for repository, ensuring correct auth_method for RDP
                const authMethodForDb = (connData.type === 'RDP' || connData.type === 'VNC') ? 'password' : connData.auth_method!;
                let sshKeyId: number | null = null;
                if (connData.ssh_key_name && sshKeyNameToId[connData.ssh_key_name]) {
                    sshKeyId = sshKeyNameToId[connData.ssh_key_name];
                }
                const encPassword = connData.password ? encrypt(connData.password) : (connData.encrypted_password || null);
                const encPrivateKey = connData.private_key ? encrypt(connData.private_key) : (connData.encrypted_private_key || null);
                const encPassphrase = connData.passphrase ? encrypt(connData.passphrase) : (connData.encrypted_passphrase || null);

                // 跳板机链 (仅 SSH)：第一遍只记录，插入全部连接后再解析为新 ID
                const jumpNames = connData.type === 'SSH' && Array.isArray(connData.jump_chain_names)
                    ? connData.jump_chain_names.map(n => (typeof n === 'string' ? n : ''))
                    : null;
                const jumpOldIds = connData.type === 'SSH' && Array.isArray(connData.jump_chain)
                    ? connData.jump_chain.filter((id): id is number => typeof id === 'number')
                    : null;
                const hasJumpChain = (jumpNames?.length ?? 0) > 0 || (jumpOldIds?.length ?? 0) > 0;
                let proxyTypeForDb: 'proxy' | 'jump' | null = null;
                if (connData.type === 'SSH') {
                    if (connData.proxy_type === 'proxy' || connData.proxy_type === 'jump') {
                        proxyTypeForDb = connData.proxy_type;
                    } else if (hasJumpChain) {
                        proxyTypeForDb = 'jump';
                    } else if (proxyIdToUse) {
                        proxyTypeForDb = 'proxy';
                    }
                }

                connectionsToInsert.push({
                    name: connData.name,
                    type: connData.type,
                    host: connData.host,
                    port: connData.port,
                    username: connData.username,
                    auth_method: authMethodForDb,
                    encrypted_password: encPassword,
                    encrypted_private_key: encPrivateKey,
                    encrypted_passphrase: encPassphrase,
                    proxy_id: proxyIdToUse,
                    proxy_type: proxyTypeForDb,
                    ssh_key_id: sshKeyId,
                    notes: connData.notes || null,
                    tag_ids: [],
                    tag_names: connData.tag_names || [],
                    jump_chain: null, // 第二遍解析后更新
                    import_old_id: typeof connData.id === 'number' ? connData.id : null,
                    import_jump_chain_names: jumpNames,
                    import_jump_chain_old_ids: jumpOldIds,
                    import_port_forwards: connData.type === 'SSH' && Array.isArray(connData.port_forwards) ? connData.port_forwards : null,
                });

            } catch (connError: any) {
                failureCount++;
                errors.push({ connectionName: connData.name || '未知连接', message: connError.message });
                console.warn(`Service: 处理导入连接 "${connData.name || '未知'}" 时出错: ${connError.message}`);
            }
        } 
        let insertedResults: { connectionId: number, originalData: any }[] = [];
        if (connectionsToInsert.length > 0) {

             insertedResults = await ConnectionRepository.bulkInsertConnections(db, connectionsToInsert);
             successCount = insertedResults.length;
        }

        // 第二遍：将跳板机 (名称 / 原 ID) 解析为新 ID 并更新 jump_chain
        const jumpWarnings = await resolveImportedJumpChains(db, insertedResults);
        errors.push(...jumpWarnings);

        // 端口转发规则：挂到新连接 ID 上；单条不合法只跳过并给出提示
        const insertPortForwardSql = `INSERT INTO port_forwards (connection_id, type, bind_host, bind_port, target_host, target_port, auto_start) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        for (const result of insertedResults) {
            const rawRules = result.originalData?.import_port_forwards;
            if (!Array.isArray(rawRules)) continue;
            let skipped = 0;
            for (const raw of rawRules) {
                const rule = normalizeImportedPortForward(raw);
                if (!rule) { skipped++; continue; }
                await runDb(db, insertPortForwardSql, [
                    result.connectionId, rule.type, rule.bind_host, rule.bind_port,
                    rule.target_host ?? null, rule.target_port ?? null, rule.auto_start ? 1 : 0,
                ]);
            }
            if (skipped > 0) {
                errors.push({ connectionName: result.originalData?.name, message: `跳过 ${skipped} 条无效的端口转发规则` });
            }
        }

        const insertTagSql = `INSERT OR IGNORE INTO connection_tags (connection_id, tag_id) VALUES (?, ?)`;
        for (const result of insertedResults) {
            const tagNames = result.originalData?.tag_names as string[] | undefined;
            if (tagNames && Array.isArray(tagNames) && tagNames.length > 0) {
                for (const tagName of tagNames) {
                    const tagId = tagNameToId[tagName];
                    if (tagId) {
                        await runDb(db, insertTagSql, [result.connectionId, tagId]).catch(tagError => {
                            console.warn(`Service: 导入连接 ${result.originalData.name}: 关联标签 "${tagName}" 失败: ${tagError.message}`);
                        });
                    }
                }
            }
        }



        await runDb(db, 'COMMIT');
        console.log(`Service: 导入事务提交。成功: ${successCount}, 失败: ${failureCount}`);
        return { successCount, failureCount, errors };

    } catch (error: any) {

        console.error('Service: 导入事务处理出错，正在回滚:', error);
        try {
            await runDb(db, 'ROLLBACK');
        } catch (rollbackErr: any) {
            console.error("Service: 回滚事务失败:", rollbackErr);
        }
        failureCount = importedData.length;
        successCount = 0;
        errors.push({ message: `事务处理失败: ${error.message}` });
        return { successCount, failureCount, errors };
    }
};
