const encodeRfc5987Value = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

export const buildAttachmentContentDisposition = (filename: string) => {
    const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\;\r\n]/g, '_') || 'download';
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
};
