/** 前端会话 ID 格式：与 ssh:connect 的 requestedSessionId 一致 (uuid / base36 均符合) */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export const isValidSessionId = (value: unknown): value is string =>
    typeof value === 'string' && SESSION_ID_PATTERN.test(value);
