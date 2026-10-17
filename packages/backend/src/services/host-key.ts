import crypto from 'crypto';

/**
 * SSH 主机密钥校验 (TOFU: Trust On First Use) 的纯逻辑部分。
 * 不依赖数据库或 ssh2，便于单元测试。
 */

export type HostKeyDecision = 'trust-new' | 'match' | 'mismatch';

const FINGERPRINT_PREFIX = 'SHA256:';

/**
 * 计算主机公钥 (SSH wire 格式的公钥 blob) 的 SHA256 指纹，
 * 格式与 OpenSSH (`ssh-keygen -lf`) 一致: "SHA256:<无填充 base64>"。
 */
export const computeFingerprint = (key: Buffer): string => {
    if (!Buffer.isBuffer(key) || key.length === 0) {
        throw new Error('Host key must be a non-empty Buffer.');
    }
    const digest = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    return `${FINGERPRINT_PREFIX}${digest}`;
};

/**
 * 规范化指纹字符串：去除首尾空白与 base64 填充；空值返回 null。
 */
export const normalizeFingerprint = (fingerprint: string | null | undefined): string | null => {
    if (typeof fingerprint !== 'string') return null;
    let value = fingerprint.trim();
    if (!value) return null;
    if (!value.startsWith(FINGERPRINT_PREFIX)) {
        value = `${FINGERPRINT_PREFIX}${value}`;
    }
    return value.replace(/=+$/, '');
};

/**
 * 校验字符串是否为合法的 OpenSSH SHA256 指纹 (32 字节摘要 -> 43 字符 base64)。
 */
export const isValidFingerprint = (fingerprint: string | null | undefined): boolean => {
    const normalized = normalizeFingerprint(fingerprint);
    if (!normalized) return false;
    return /^SHA256:[A-Za-z0-9+/]{43}$/.test(normalized);
};

/**
 * 比较已保存与当前收到的指纹，决定如何处理。
 * - 未保存 -> 'trust-new' (首次使用，信任并保存)
 * - 相等 -> 'match'
 * - 不等 -> 'mismatch' (必须拒绝连接)
 */
export const decideHostKey = (stored: string | null | undefined, received: string): HostKeyDecision => {
    const normalizedStored = normalizeFingerprint(stored);
    const normalizedReceived = normalizeFingerprint(received);
    if (!normalizedReceived) {
        // 没有可比较的指纹时绝不放行已保存的连接
        return normalizedStored ? 'mismatch' : 'trust-new';
    }
    if (!normalizedStored) return 'trust-new';
    const a = Buffer.from(normalizedStored, 'utf8');
    const b = Buffer.from(normalizedReceived, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return 'match';
    return 'mismatch';
};

export interface HostKeyMismatchInfo {
    connectionId: number;
    connectionName?: string;
    host?: string;
    port?: number;
    expectedFingerprint: string;
    receivedFingerprint: string;
    isJumpHost?: boolean;
}

export class HostKeyMismatchError extends Error {
    public readonly code = 'HOST_KEY_MISMATCH';
    public readonly info: HostKeyMismatchInfo;

    constructor(info: HostKeyMismatchInfo) {
        super(
            `主机密钥校验失败：${info.connectionName ?? `连接 ${info.connectionId}`}` +
            `${info.host ? ` (${info.host}${info.port ? `:${info.port}` : ''})` : ''} 的主机密钥已变化，可能存在中间人攻击。` +
            ` 已保存: ${info.expectedFingerprint}，收到: ${info.receivedFingerprint}`
        );
        this.name = 'HostKeyMismatchError';
        this.info = info;
    }
}

export const isHostKeyMismatchError = (err: unknown): err is HostKeyMismatchError =>
    err instanceof HostKeyMismatchError || (!!err && typeof err === 'object' && (err as any).code === 'HOST_KEY_MISMATCH' && !!(err as any).info);
