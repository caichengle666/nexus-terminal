declare module 'archiver-zip-encrypted' {
    /** archiver 格式插件 (ZipEncrypted)，供 EncryptedZipArchive 作为 archiver 8 的 _module 使用。 */
    const ZipEncrypted: new (options: {
        encryptionMethod: 'aes256' | 'zip20';
        password: string | Buffer;
    }) => unknown;
    export = ZipEncrypted;
}
