import { Archiver, type ArchiverOptions } from 'archiver';
import ZipEncrypted from 'archiver-zip-encrypted';

/**
 * archiver 8 是纯 ESM，移除了 archiver(format)/archiver.create()/archiver.registerFormat() 工厂，
 * 改为导出 ZipArchive/TarArchive 等类。archiver-zip-encrypted (最新 2.0.0) 仍是 archiver 7 风格的
 * 格式插件 (append/finalize/on/pipe/unpipe 接口与 archiver 8 的插件接口一致)，
 * 因此在这里按 archiver 8 内置 ZipArchive 的方式把它挂到 Archiver 核心上。
 */
export interface EncryptedZipOptions extends ArchiverOptions {
    encryptionMethod: 'aes256' | 'zip20';
    password: string | Buffer;
}

export class EncryptedZipArchive extends Archiver {
    constructor(options: EncryptedZipOptions) {
        super(options);
        // 与 archiver 8 的 ZipArchive 构造函数相同的内部字段 (archiver 未提供公开的插件注册 API)
        const self = this as unknown as {
            _format: string;
            _module: unknown;
            _supportsDirectory: boolean;
            _supportsSymlink: boolean;
            _modulePipe(): void;
        };
        self._format = 'zip-encrypted';
        self._module = new ZipEncrypted(options);
        self._supportsDirectory = true;
        self._supportsSymlink = true;
        self._modulePipe();
    }
}
