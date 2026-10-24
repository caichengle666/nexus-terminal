/**
 * 让 ssh2 接受 OpenSSH 主机证书 (*-cert-v01@openssh.com)。
 *
 * 有些服务器 (例如 ssh.instabox.sh) 只提供 ssh-ed25519-cert-v01@openssh.com 主机密钥，
 * ssh2 不认识证书类型，握手以 "no matching host key format" 失败；OpenSSH 客户端则能连接。
 *
 * 这里的行为与 OpenSSH 未配置 @cert-authority 时一致：不校验证书签发者，
 * 从证书里取出内嵌的普通公钥，用它验证密钥交换签名，并把普通公钥交给主机密钥指纹校验
 * (所以证书续签不会触发指纹变化提示)。交换哈希仍使用服务器发来的原始证书 blob。
 *
 * ssh2 没有扩展点，因此在 Node 编译 ssh2/lib/protocol/kex.js 时对源码做少量替换。
 * 替换锚点找不到时 (ssh2 升级改了代码) 不做任何修改并打印警告，测试会因此失败。
 */
import Module from 'module';
import path from 'path';

const CERT_SUFFIX = '-cert-v01@openssh.com';

/** 追加到客户端主机密钥算法列表末尾：只有服务器不提供普通主机密钥时才会协商到证书。 */
export const SSH_HOST_CERT_ALGORITHMS = [
    'ssh-ed25519-cert-v01@openssh.com',
    'ecdsa-sha2-nistp256-cert-v01@openssh.com',
    'ecdsa-sha2-nistp384-cert-v01@openssh.com',
    'ecdsa-sha2-nistp521-cert-v01@openssh.com',
    'rsa-sha2-512-cert-v01@openssh.com',
    'rsa-sha2-256-cert-v01@openssh.com',
];

/** 协商出的算法名 -> 签名算法名 (证书去掉后缀；普通算法原样返回)。 */
export const hostKeySigType = (negotiated: string): string => (
    negotiated.endsWith(CERT_SUFFIX) ? negotiated.slice(0, -CERT_SUFFIX.length) : negotiated
);

/** 协商出的算法名 -> 主机密钥 blob 里的类型名。 */
const expectedBlobType = (negotiated: string): string => {
    if (!negotiated.endsWith(CERT_SUFFIX)) return negotiated;
    const base = hostKeySigType(negotiated);
    return (base === 'rsa-sha2-256' || base === 'rsa-sha2-512' ? 'ssh-rsa' : base) + CERT_SUFFIX;
};

/** 收到的主机密钥类型是否与协商出的证书算法匹配。 */
export const hostKeyTypeMatches = (blobType: string, negotiated: string): boolean => (
    negotiated.endsWith(CERT_SUFFIX) && blobType === expectedBlobType(negotiated)
);

const readString = (buf: Buffer, pos: number): [Buffer, number] => {
    if (pos + 4 > buf.length) throw new Error('Malformed SSH certificate');
    const len = buf.readUInt32BE(pos);
    const start = pos + 4;
    if (start + len > buf.length) throw new Error('Malformed SSH certificate');
    return [buf.subarray(start, start + len), start + len];
};

const writeStrings = (parts: Buffer[]): Buffer => Buffer.concat(parts.flatMap((part) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(part.length, 0);
    return [len, part];
}));

/**
 * 把 OpenSSH 证书 blob 转成内嵌的普通公钥 blob；不是证书则原样返回。
 * 布局见 OpenSSH PROTOCOL.certkeys：type, nonce, 公钥字段..., serial, ...
 */
export const plainHostKey = (blob: Buffer): Buffer => {
    let pos = 0;
    let typeBuf: Buffer;
    [typeBuf, pos] = readString(blob, pos);
    const type = typeBuf.toString('latin1');
    if (!type.endsWith(CERT_SUFFIX)) return blob;
    const base = type.slice(0, -CERT_SUFFIX.length);
    [, pos] = readString(blob, pos); // nonce

    let fieldCount: number;
    if (base === 'ssh-ed25519') fieldCount = 1; // pk
    else if (base.startsWith('ecdsa-sha2-')) fieldCount = 2; // curve, Q
    else if (base === 'ssh-rsa') fieldCount = 2; // e, n
    else throw new Error(`Unsupported SSH host certificate type: ${type}`);

    const fields: Buffer[] = [];
    for (let i = 0; i < fieldCount; i++) {
        let field: Buffer;
        [field, pos] = readString(blob, pos);
        fields.push(field);
    }
    return writeStrings([Buffer.from(base, 'latin1'), ...fields]);
};

// --- 对 ssh2 源码的替换 ---------------------------------------------------

const KEX_REPLACEMENTS: Array<[string, string]> = [
    // 1. 客户端：收到的主机密钥类型检查允许证书
    [
        'if (hostPubKeyType !== this.negotiated.serverHostKey) {',
        'if (hostPubKeyType !== this.negotiated.serverHostKey\n              && !__nexusHostCert.hostKeyTypeMatches(hostPubKeyType, this.negotiated.serverHostKey)) {',
    ],
    // 2. 主机密钥指纹校验使用内嵌的普通公钥
    [
        'ret = this._protocol._hostVerifier(hostPubKey, (permitted) => {',
        'ret = this._protocol._hostVerifier(__nexusHostCert.plainHostKey(hostPubKey), (permitted) => {',
    ],
    // 3. 签名类型为证书对应的基础算法
    [
        'if (sigType !== negotiated.serverHostKey) {',
        'if (sigType !== __nexusHostCert.hostKeySigType(negotiated.serverHostKey)) {',
    ],
    // 4. 用内嵌公钥验证签名
    [
        'bufferParser.init(this._hostKey, 0);\n          const name = bufferParser.readString(true);\n          const hostKey = this._hostKey.slice(bufferParser.pos());',
        'const __plainHostKey = __nexusHostCert.plainHostKey(this._hostKey);\n          bufferParser.init(__plainHostKey, 0);\n          const name = bufferParser.readString(true);\n          const hostKey = __plainHostKey.slice(bufferParser.pos());',
    ],
    // 5. rsa-sha2-*-cert 的哈希算法
    [
        "const verified = parsedHostKey.verify(exchangeHash, sigValue, hashAlgo);",
        "if (hashAlgo === undefined) {\n          switch (__nexusHostCert.hostKeySigType(this.negotiated.serverHostKey)) {\n            case 'rsa-sha2-256': hashAlgo = 'sha256'; break;\n            case 'rsa-sha2-512': hashAlgo = 'sha512'; break;\n          }\n        }\n        const verified = parsedHostKey.verify(exchangeHash, sigValue, hashAlgo);",
    ],
];

/** 对 kex.js 源码应用替换；任一锚点缺失则返回 null (不做部分修改)。 */
export const patchSsh2KexSource = (source: string, helperPath: string): string | null => {
    let out = source;
    for (const [from, to] of KEX_REPLACEMENTS) {
        const idx = out.indexOf(from);
        if (idx === -1 || out.indexOf(from, idx + from.length) !== -1) return null;
        out = out.slice(0, idx) + to + out.slice(idx + from.length);
    }
    return `const __nexusHostCert = require(${JSON.stringify(helperPath)});\n${out}`;
};

const KEX_SUFFIX = path.join('ssh2', 'lib', 'protocol', 'kex.js');
let installed = false;
let kexPatched = false;

export const isSsh2HostCertPatched = (): boolean => kexPatched;

export const installSsh2HostCertSupport = (): void => {
    if (installed) return;
    installed = true;

    const alreadyLoaded = Object.keys(require.cache).some((f) => f.endsWith(KEX_SUFFIX));
    if (alreadyLoaded) {
        console.warn('[ssh2-host-cert] ssh2 已在补丁安装前加载，主机证书支持未启用。');
        return;
    }

    const proto = (Module as unknown as { prototype: { _compile: (content: string, filename: string) => unknown } }).prototype;
    const originalCompile = proto._compile;
    proto._compile = function patchedCompile(this: unknown, content: string, filename: string) {
        if (!kexPatched && typeof filename === 'string' && filename.endsWith(KEX_SUFFIX)) {
            const patched = patchSsh2KexSource(content, __filename);
            if (patched) {
                kexPatched = true;
                content = patched;
                try {
                    // 让 ssh2 接受 algorithms.serverHostKey 里的证书算法名
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const constants = require(path.join(path.dirname(filename), 'constants.js'));
                    const supported: string[] | undefined = constants?.SUPPORTED_SERVER_HOST_KEY;
                    if (Array.isArray(supported)) {
                        for (const alg of SSH_HOST_CERT_ALGORITHMS) {
                            if (!supported.includes(alg)) supported.push(alg);
                        }
                    }
                } catch (e) {
                    console.warn('[ssh2-host-cert] 无法扩展 ssh2 支持的主机密钥算法列表:', e);
                }
            } else {
                console.warn('[ssh2-host-cert] ssh2 kex.js 与预期不符 (可能已升级)，主机证书支持未启用。');
            }
        }
        return originalCompile.call(this, content, filename);
    };
};

installSsh2HostCertSupport();
