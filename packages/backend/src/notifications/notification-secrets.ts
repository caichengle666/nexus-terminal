import {
    isLegacyPlaintextSecret,
    isMaskedSecret,
    maskSecret,
    openSecret,
    sealSecret,
} from '../utils/secret-field';

/**
 * 通知渠道配置中的敏感字段：
 * - email.smtpPass
 * - telegram.botToken
 * - gotify.token
 * - webhook.headers 的所有值 (常见 Authorization / token)
 */
const SECRET_STRING_FIELDS = ['smtpPass', 'botToken', 'token'] as const;

type AnyConfig = Record<string, any>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

const mapSecrets = (config: unknown, fn: (value: unknown) => unknown): AnyConfig => {
    if (!isPlainObject(config)) return (config ?? {}) as AnyConfig;
    const out: AnyConfig = { ...config };
    for (const field of SECRET_STRING_FIELDS) {
        if (field in out) out[field] = fn(out[field]);
    }
    if (isPlainObject(out.headers)) {
        const headers: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(out.headers)) headers[name] = fn(value);
        out.headers = headers;
    }
    return out;
};

export const sealNotificationConfig = (config: unknown): AnyConfig => mapSecrets(config, sealSecret);
export const openNotificationConfig = (config: unknown): AnyConfig => mapSecrets(config, openSecret);
export const maskNotificationConfig = (config: unknown): AnyConfig => mapSecrets(config, maskSecret);

/** 存储的配置里是否还有未加密的敏感字段 */
export const hasLegacyPlaintextSecrets = (storedConfig: unknown): boolean => {
    let found = false;
    mapSecrets(storedConfig, value => {
        if (isLegacyPlaintextSecret(value)) found = true;
        return value;
    });
    return found;
};

/**
 * 合并前端提交的配置：值为掩码的敏感字段沿用已保存的 (已解密) 值。
 * Webhook 头部按名称匹配；新增头部若为掩码则丢弃 (没有可沿用的原值)。
 */
export const mergeMaskedNotificationConfig = (incoming: unknown, existingOpened: unknown): AnyConfig => {
    if (!isPlainObject(incoming)) return (incoming ?? {}) as AnyConfig;
    const existing: AnyConfig = isPlainObject(existingOpened) ? existingOpened : {};
    const out: AnyConfig = { ...incoming };
    for (const field of SECRET_STRING_FIELDS) {
        if (isMaskedSecret(out[field])) out[field] = existing[field] ?? '';
    }
    if (isPlainObject(out.headers)) {
        const existingHeaders = isPlainObject(existing.headers) ? existing.headers : {};
        const headers: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(out.headers)) {
            if (isMaskedSecret(value)) {
                if (name in existingHeaders) headers[name] = existingHeaders[name];
                continue;
            }
            headers[name] = value;
        }
        out.headers = headers;
    }
    return out;
};
