import path from 'path';

export const getBackendDataPath = (): string => {
    return process.env.APP_BACKEND_DATA_PATH || path.join(__dirname, '..', '..', 'data');
};

export const resolveBackendDataPath = (...segments: string[]): string => {
    return path.join(getBackendDataPath(), ...segments);
};
