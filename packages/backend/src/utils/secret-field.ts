import { encrypt, decrypt } from './crypto';

/**
 * 配置中的敏感字段 (WebDAV 密码、CAPTCHA 密钥、SMTP 密码、Bot Token、Webhook 头部值) 的
 * 落库加密与对外掩码工具。
 *
 * - 加密值带前缀 `enc:v1:`，没有前缀的值视为历史明文，读取时原样返回 (透明兼容)，
 *   下次保存时会被加密。
 * - 返回给前端时用 SECRET_MASK 代替真实值；前端提交 SECRET_MASK 表示“保持原值不变”。
 */
export const SECRET_PREFIX = 'enc:v1:';
export const SECRET_MASK = '********';

export const isSealedSecret = (value: unknown): value is string =>
    typeof value === 'string' && value.startsWith(SECRET_PREFIX);

export const isMaskedSecret = (value: unknown): boolean => value === SECRET_MASK;

/** 加密非空字符串；空串 / 非字符串原样返回；已加密的值不重复加密 */
export function sealSecret<T>(value: T): T {
    if (typeof value !== 'string' || value === '' || isSealedSecret(value)) return value;
    return (SECRET_PREFIX + encrypt(value)) as unknown as T;
}

/** 解密；历史明文原样返回；解密失败 (例如 ENCRYPTION_KEY 已更换) 时返回空串 */
export function openSecret<T>(value: T): T {
    if (!isSealedSecret(value)) return value;
    try {
        return decrypt(value.slice(SECRET_PREFIX.length)) as unknown as T;
    } catch {
        console.warn('[Secrets] 无法解密已保存的敏感配置 (ENCRYPTION_KEY 可能已更换)，按空值处理。');
        return '' as unknown as T;
    }
}

/** 是否为尚未加密的历史明文 (非空、非加密) */
export const isLegacyPlaintextSecret = (value: unknown): boolean =>
    typeof value === 'string' && value !== '' && !isSealedSecret(value);

export const maskSecret = (value: unknown): string =>
    typeof value === 'string' && value !== '' ? SECRET_MASK : '';

/** 前端提交的值为掩码时沿用原值，否则使用新值 */
export const keepIfMasked = <T>(incoming: T, existing: T): T => (isMaskedSecret(incoming) ? existing : incoming);
