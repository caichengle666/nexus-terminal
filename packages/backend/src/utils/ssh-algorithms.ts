import './ssh2-host-cert';
import * as crypto from 'crypto';
import type { Algorithms } from 'ssh2';
import { SSH_HOST_CERT_ALGORITHMS, isSsh2HostCertPatched } from './ssh2-host-cert';

/**
 * 兼容旧设备（老路由器、交换机、嵌入式系统、旧版 OpenSSH）的算法。
 *
 * ssh2 默认只启用现代算法；服务器若只提供 ssh-dss 主机密钥、SHA-1 密钥交换或 CBC 加密，
 * 握手会以 "no matching host key format" 等错误失败。这里把这些算法追加到默认列表末尾：
 * 只有服务器不支持任何现代算法时才会被协商到，现代服务器的连接不受影响，
 * 主机密钥指纹校验也照常进行。
 */
export const SSH_LEGACY_COMPAT_ALGORITHMS: Algorithms = {
    serverHostKey: { append: ['ssh-dss'] },
    kex: { append: ['diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] },
    cipher: { append: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'] },
    hmac: { append: ['hmac-sha2-256-96', 'hmac-sha2-512-96', 'hmac-sha1-96', 'hmac-md5'] },
} as Algorithms;

// 固定的 DSA 测试向量 (1024 位公钥 + 对 DSA_PROBE_MESSAGE 的 SHA-1 签名)，用于探测当前运行时能否校验 ssh-dss。
const DSA_PROBE_PUBLIC_KEY = 'MIIBtzCCASsGByqGSM44BAEwggEeAoGBANAk7wfytnFSYfHq7+18qbql3ijKDVmzDNgN39frEasEhVRJm0xi6ukcBhwLL3gMMH8nAnN2b2VaCmK7hNwoEmZN7JRGXlxEU42R0aKnbwVZRZK7qKyYnWNdteiUULOMTFSSQZogVgdmkIxdIU/wJYoPOlFpWjSGpKZDewpDRQVxAhUAvxmOEUhE44SaVltbIQ0rdbk7dkkCgYBJA3+gOgb4ZI1eiAwanQBGxPufpG/kEOVWEVVo2CYLEAXk5sAJodr35hpNawd3atfzMbyv/XRstDNGkx3OTeY3CDu55QnebgtlaZWpMHP8m7oYTtugXd2mliFu4H+ZX4PHBlmhYwJOicNkDloVgD5wHa3//65V7g3sK0HoaG7IuwOBhQACgYEAz/JMqQ9g5q/O71E0szDSh1suAHU4i3VBSFK3k8fdyWyep+O5ZKEtCNX47g0JATybCrqLJNUAGaglINTymt2tJ70HR5lfURDCbsI0DdVEnbiKRYXC/OpEJrHxvTwot0lajlKtza50JwzKt9Dy4903PUYkL0eSpZUojkdcIXmfB1M=';
const DSA_PROBE_SIGNATURE = 'MC0CFQCT5ZxJL/m0A/try3BiL8NqluJ9jwIUHtoVECoz8VSF/QFvJF1r9URKoFM=';
const DSA_PROBE_MESSAGE = 'nexus-dsa-probe';

export interface LegacyCryptoSupport {
    dsa: boolean;
    dhGroup1: boolean;
}

/**
 * 桌面端后端运行在 Electron 内置的 Node.js 上，它用 BoringSSL 而不是 OpenSSL：
 * 不支持 DSA (ssh-dss)，也没有 modp2 (diffie-hellman-group1-sha1)。
 * 把运行时不支持的算法从兼容列表里去掉，否则协商到它们时握手会在中途抛错，
 * 而不是干净地报告 "no matching ..."。
 */
export const detectLegacyCryptoSupport = (): LegacyCryptoSupport => {
    let dsa = false;
    try {
        const key = crypto.createPublicKey({ key: Buffer.from(DSA_PROBE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
        dsa = crypto.verify('sha1', Buffer.from(DSA_PROBE_MESSAGE), key, Buffer.from(DSA_PROBE_SIGNATURE, 'base64'));
    } catch {
        dsa = false;
    }
    let dhGroup1 = false;
    try {
        crypto.createDiffieHellmanGroup('modp2');
        dhGroup1 = true;
    } catch {
        dhGroup1 = false;
    }
    return { dsa, dhGroup1 };
};

let cachedSupport: LegacyCryptoSupport | undefined;
const getLegacyCryptoSupport = (): LegacyCryptoSupport => {
    if (!cachedSupport) cachedSupport = detectLegacyCryptoSupport();
    return cachedSupport;
};

/**
 * 实际使用的兼容算法：ssh2 主机证书补丁生效时，再追加 OpenSSH 主机证书算法
 * (补丁未生效时 ssh2 会拒绝这些算法名，所以不能无条件加入)；
 * 再去掉当前加密库不支持的算法。
 */
export const getLegacyCompatAlgorithms = (support: LegacyCryptoSupport = getLegacyCryptoSupport()): Algorithms => {
    const compat = SSH_LEGACY_COMPAT_ALGORITHMS as { serverHostKey: { append: string[] }; kex: { append: string[] } };
    const hostKeys = [
        ...(isSsh2HostCertPatched() ? SSH_HOST_CERT_ALGORITHMS : []),
        ...compat.serverHostKey.append,
    ].filter(name => support.dsa || name !== 'ssh-dss');
    const kex = compat.kex.append.filter(name => support.dhGroup1 || name !== 'diffie-hellman-group1-sha1');
    return {
        ...SSH_LEGACY_COMPAT_ALGORITHMS,
        serverHostKey: { append: hostKeys },
        kex: { append: kex },
    } as Algorithms;
};

export const withLegacyCompatAlgorithms = <T extends { algorithms?: Algorithms }>(config: T): T => (
    config.algorithms ? config : { ...config, algorithms: getLegacyCompatAlgorithms() }
);

/**
 * 不会因为稍后重试而自行恢复的 SSH 握手/认证错误（算法不匹配、认证失败）。
 */
export const isNonRetryableSshError = (message: string): boolean => (
    /Handshake failed|no matching|All configured authentication methods failed|authentication methods failed/i.test(message)
);
