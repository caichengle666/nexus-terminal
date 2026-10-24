import './ssh2-host-cert';
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

/**
 * 实际使用的兼容算法：ssh2 主机证书补丁生效时，再追加 OpenSSH 主机证书算法
 * (补丁未生效时 ssh2 会拒绝这些算法名，所以不能无条件加入)。
 */
export const getLegacyCompatAlgorithms = (): Algorithms => {
    if (!isSsh2HostCertPatched()) return SSH_LEGACY_COMPAT_ALGORITHMS;
    return {
        ...SSH_LEGACY_COMPAT_ALGORITHMS,
        serverHostKey: { append: [...SSH_HOST_CERT_ALGORITHMS, 'ssh-dss'] },
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
