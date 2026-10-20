import crypto from 'crypto';
import zlib from 'zlib';
import AdmZip from 'adm-zip';

/**
 * 读取 WinZip AES (AE-1/AE-2) 加密的 ZIP，例如 archiver-zip-encrypted 生成的 aes256 压缩包。
 * adm-zip 只支持传统 ZipCrypto，这里手动实现 AES 解密：
 *   PBKDF2-HMAC-SHA1(1000 次) 派生 AES 密钥 + HMAC 密钥 + 2 字节密码校验值，
 *   AES-CTR (小端计数器，从 1 开始)，HMAC-SHA1 前 10 字节作为认证码。
 */
export class ZipPasswordError extends Error {
    constructor(message = 'ZIP 密码错误。') {
        super(message);
        this.name = 'ZipPasswordError';
    }
}

const AES_METHOD = 99;
const AES_EXTRA_ID = 0x9901;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const STRENGTH_TO_KEY_LENGTH: Record<number, number> = { 1: 16, 2: 24, 3: 32 };

interface AesExtra { strength: number; actualMethod: number }

function parseAesExtra(extra: Buffer | undefined): AesExtra | null {
    if (!extra) return null;
    let offset = 0;
    while (offset + 4 <= extra.length) {
        const id = extra.readUInt16LE(offset);
        const size = extra.readUInt16LE(offset + 2);
        if (id === AES_EXTRA_ID && size >= 7 && offset + 4 + size <= extra.length) {
            return { strength: extra.readUInt8(offset + 8), actualMethod: extra.readUInt16LE(offset + 9) };
        }
        offset += 4 + size;
    }
    return null;
}

function aesCtrLittleEndian(key: Buffer, data: Buffer): Buffer {
    const algorithm = key.length === 16 ? 'aes-128-ecb' : key.length === 24 ? 'aes-192-ecb' : 'aes-256-ecb';
    const cipher = crypto.createCipheriv(algorithm, key, null);
    cipher.setAutoPadding(false);
    const blocks = Math.ceil(data.length / 16);
    const counters = Buffer.alloc(blocks * 16);
    const counter = Buffer.alloc(16);
    counter[0] = 1;
    for (let i = 0; i < blocks; i++) {
        counter.copy(counters, i * 16);
        for (let j = 0; j < 16; j++) {
            if (counter[j] === 255) { counter[j] = 0; continue; }
            counter[j] += 1;
            break;
        }
    }
    const keystream = Buffer.concat([cipher.update(counters), cipher.final()]);
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ keystream[i];
    return out;
}

function decryptAesEntry(raw: Buffer, password: string, extra: AesExtra): Buffer {
    const keyLength = STRENGTH_TO_KEY_LENGTH[extra.strength];
    if (!keyLength) throw new Error('不支持的 ZIP AES 加密强度。');
    const saltLength = keyLength / 2;
    if (raw.length < saltLength + 2 + 10) throw new Error('ZIP 条目已损坏。');
    const salt = raw.subarray(0, saltLength);
    const verifier = raw.subarray(saltLength, saltLength + 2);
    const encrypted = raw.subarray(saltLength + 2, raw.length - 10);
    const authCode = raw.subarray(raw.length - 10);
    const derived = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, keyLength * 2 + 2, 'sha1');
    const aesKey = derived.subarray(0, keyLength);
    const hmacKey = derived.subarray(keyLength, keyLength * 2);
    if (!crypto.timingSafeEqual(derived.subarray(keyLength * 2), verifier)) throw new ZipPasswordError();
    const expected = crypto.createHmac('sha1', hmacKey).update(encrypted).digest().subarray(0, 10);
    if (!crypto.timingSafeEqual(expected, authCode)) throw new ZipPasswordError('ZIP 密码错误或文件已损坏。');
    const compressed = aesCtrLittleEndian(aesKey, encrypted);
    if (extra.actualMethod === 0) return compressed;
    if (extra.actualMethod === 8) return zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    throw new Error(`不支持的 ZIP 压缩方式: ${extra.actualMethod}`);
}

/** 是否为 ZIP 文件 (PK\x03\x04) */
export const isZipBuffer = (buffer: Buffer): boolean =>
    buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;

/**
 * 读取 ZIP 中所有文件条目 (支持 AES 加密与未加密条目)。密码错误时抛出 ZipPasswordError。
 */
export function readZipEntries(buffer: Buffer, password: string | undefined): Map<string, Buffer> {
    const zip = new AdmZip(buffer);
    const result = new Map<string, Buffer>();
    let total = 0;
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        let data: Buffer;
        if (entry.header.method === AES_METHOD) {
            if (!password) throw new ZipPasswordError('该 ZIP 已加密，需要提供密码。');
            const extra = parseAesExtra(entry.extra);
            if (!extra) throw new Error('无法识别 ZIP AES 加密信息。');
            data = decryptAesEntry(entry.getCompressedData(), password, extra);
        } else if (entry.header.encrypted) {
            if (!password) throw new ZipPasswordError('该 ZIP 已加密，需要提供密码。');
            try {
                data = entry.getData(password);
            } catch {
                throw new ZipPasswordError();
            }
        } else {
            data = entry.getData();
        }
        total += data.length;
        if (data.length > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new Error('ZIP 内容过大。');
        result.set(entry.entryName, data);
    }
    return result;
}
