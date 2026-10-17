/**
 * 轻量日志层：在不改动现有 console.* 调用点的前提下，提供
 *  - 日志级别（LOG_LEVEL=error|warn|info|debug，默认 info；生产可设为 warn）
 *  - 时间戳与级别前缀
 *  - 敏感信息脱敏（Cookie、Authorization、password/secret/token 字段、Bearer 令牌）
 * 新代码请直接使用导出的 logger。
 */
import util from 'util';

type Level = 'error' | 'warn' | 'info' | 'debug';
const LEVEL_ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const resolveLevel = (): Level => {
    const raw = String(process.env.LOG_LEVEL || '').toLowerCase();
    return (raw in LEVEL_ORDER ? raw : 'info') as Level;
};

const REDACTIONS: Array<[RegExp, string]> = [
    [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]'],
    [/("?(?:cookie|set-cookie|authorization|x-gateway-secret)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi, '$1"[REDACTED]"'],
    [/("?(?:password|passphrase|secret|token|apiKey|api_key|private_key|privateKey)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi, '$1"[REDACTED]"'],
    [/connect\.sid=[^;\s"]+/g, 'connect.sid=[REDACTED]'],
];

export const redact = (text: string): string =>
    REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);

const original = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    debug: console.debug.bind(console),
};

const emit = (level: Level, sink: (...args: unknown[]) => void, args: unknown[]) => {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[resolveLevel()]) return;
    const message = util.format(...args);
    sink(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(message)}`);
};

export const logger = {
    error: (...args: unknown[]) => emit('error', original.error, args),
    warn: (...args: unknown[]) => emit('warn', original.warn, args),
    info: (...args: unknown[]) => emit('info', original.log, args),
    debug: (...args: unknown[]) => emit('debug', original.debug, args),
};

let installed = false;
/** 将全局 console.* 路由到 logger（只安装一次）。 */
export const installConsoleLogger = (): void => {
    if (installed) return;
    installed = true;
    console.error = logger.error;
    console.warn = logger.warn;
    console.info = logger.info;
    console.log = logger.info;
    console.debug = logger.debug;
};
