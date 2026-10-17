/**
 * Shared validation for Docker container identifiers that end up in shell commands
 * (local child_process.exec or remote SSH exec). Container IDs (hex) and container
 * names ([a-zA-Z0-9][a-zA-Z0-9_.-]+) both match. Anything else is rejected outright
 * instead of being silently stripped, so a malformed ID can never be turned into a
 * different (but valid) container reference or a shell payload.
 */
export const DOCKER_CONTAINER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export const INVALID_CONTAINER_ID_MESSAGE = 'Invalid container ID format.';

export const isValidContainerId = (value: unknown): value is string =>
    typeof value === 'string' && DOCKER_CONTAINER_ID_PATTERN.test(value);

/** Returns the container ID unchanged when valid; throws Error('Invalid container ID format.') otherwise. */
export const assertValidContainerId = (value: unknown): string => {
    if (!isValidContainerId(value)) {
        throw new Error(INVALID_CONTAINER_ID_MESSAGE);
    }
    return value;
};
