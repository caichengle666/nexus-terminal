import { AuthenticatedWebSocket, ClientState, DockerContainer, DockerStats } from '../types';
import { parsePortsString } from '../utils';
import { clientStates, settingsService } from '../state';
import WebSocket from 'ws';
import { isValidContainerId, INVALID_CONTAINER_ID_MESSAGE } from '../../docker/docker-validate';
import { execBackground } from '../../services/ssh-channel-limiter';
import type { ClientChannel } from 'ssh2';

const DEFAULT_DOCKER_STATUS_INTERVAL_SECONDS = 2;
/** 单条 docker 命令的超时：dockerd 卡死时关闭通道，避免占满 exec 通道 */
export const DOCKER_EXEC_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.DOCKER_EXEC_TIMEOUT_MS ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 20000;
})();

interface DockerExecResult { stdout: string; stderr: string; code: number | null }

/**
 * 执行一条 docker 命令，带超时；超时后发送 KILL 并关闭通道 (释放限流器槽位)。
 * background=true 时走后台配额 (轮询)，不会占用为用户命令保留的通道。
 */
export function runDockerExec(
    state: ClientState,
    command: string,
    options: { background?: boolean; timeoutMs?: number } = {}
): Promise<DockerExecResult> {
    const timeoutMs = options.timeoutMs ?? DOCKER_EXEC_TIMEOUT_MS;
    return new Promise<DockerExecResult>((resolve, reject) => {
        if (!state.sshClient) {
            reject(new Error('SSH client disconnected before command execution.'));
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const settle = (error: Error | null, code: number | null = null) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (error) reject(error);
            else resolve({ stdout, stderr, code });
        };
        const onChannel = (err: Error | undefined, stream: ClientChannel) => {
            if (err) return settle(err);
            if (settled) {
                // 已超时 (仍在排队时)：立即关闭迟到的通道
                try { stream.close(); } catch { /* ignore */ }
                return;
            }
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                try { stream.signal('KILL'); } catch { /* ignore */ }
                try { stream.close(); } catch { /* ignore */ }
                settle(new Error(`Docker 命令执行超时 (${Math.round(timeoutMs / 1000)} 秒)`));
            }, timeoutMs);
            stream.on('data', (data: Buffer) => { stdout += data.toString(); });
            stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
            stream.on('close', (code: number | null) => settle(null, typeof code === 'number' ? code : null));
            stream.on('error', (execErr: Error) => settle(execErr));
        };
        try {
            if (options.background) execBackground(state.sshClient, command, { pty: false }, onChannel as any);
            else state.sshClient.exec(command, { pty: false }, onChannel as any);
        } catch (error: any) {
            settle(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

export async function fetchRemoteDockerStatus(state: ClientState, options: { background?: boolean } = {}): Promise<{ available: boolean; containers: DockerContainer[] }> {
    if (!state || !state.sshClient) {
        console.warn(`[fetchRemoteDockerStatus] SSH client not available or not connected for session ${state?.ws?.sessionId}.`);
        return { available: false, containers: [] };
    }

    let allContainers: DockerContainer[] = [];
    const statsMap = new Map<string, DockerStats>();

    try {
        const versionCommand = "docker version --format '{{.Server.Version}}'";
        const { stdout: versionStdout, stderr: versionStderr } = await runDockerExec(state, versionCommand, { background: options.background });

        if (versionStderr.includes('command not found') ||
            versionStderr.includes('permission denied') ||
            versionStderr.includes('Cannot connect to the Docker daemon')) {
            console.warn(`[fetchRemoteDockerStatus] Docker version check failed on session ${state.ws.sessionId}. Docker unavailable or inaccessible. Stderr: ${versionStderr.trim()}`);
            return { available: false, containers: [] };
        } else if (versionStderr) {
            console.warn(`[fetchRemoteDockerStatus] Docker version command stderr on session ${state.ws.sessionId}: ${versionStderr.trim()}`);
        }

        if (!versionStdout.trim()) {
            console.warn(`[fetchRemoteDockerStatus] Docker version check on session ${state.ws.sessionId} produced no output, assuming Docker unavailable.`);
            return { available: false, containers: [] };
        }
    } catch (error: any) {
        console.error(`[fetchRemoteDockerStatus] Error executing docker version for session ${state.ws.sessionId}:`, error.message);
        return { available: false, containers: [] };
    }

    try {
        const psCommand = "docker ps -a --no-trunc --format '{{json .}}'";
        const { stdout: psStdout, stderr: psStderr } = await runDockerExec(state, psCommand, { background: options.background });

        if (psStderr.includes('command not found') ||
            psStderr.includes('permission denied') ||
            psStderr.includes('Cannot connect to the Docker daemon')) {
            console.warn(`[fetchRemoteDockerStatus] Docker ps command failed unexpectedly after version check on session ${state.ws.sessionId}. Stderr: ${psStderr.trim()}`);
            return { available: false, containers: [] };
        } else if (psStderr) {
             console.warn(`[fetchRemoteDockerStatus] Docker ps command stderr on session ${state.ws.sessionId}: ${psStderr.trim()}`);
        }

        const lines = psStdout.trim() ? psStdout.trim().split('\n') : [];
        allContainers = lines
            .map(line => {
                try {
                    const data = JSON.parse(line);
                    const container: DockerContainer = {
                        id: data.ID,
                        Names: typeof data.Names === 'string' ? data.Names.split(',') : (data.Names || []),
                        Image: data.Image || '',
                        ImageID: data.ImageID || '',
                        Command: data.Command || '',
                        Created: data.CreatedAt || 0,
                        State: data.State || 'unknown',
                        Status: data.Status || '',
                        Ports: parsePortsString(data.Ports),
                        Labels: data.Labels || {},
                        stats: null
                    };
                    return container;
                } catch (parseError) {
                    console.error(`[fetchRemoteDockerStatus] Failed to parse container JSON line for session ${state.ws.sessionId}: ${line}`, parseError);
                    return null;
                }
            })
            .filter((container): container is DockerContainer => container !== null);
    } catch (error: any) {
        console.error(`[fetchRemoteDockerStatus] Error executing docker ps for session ${state.ws.sessionId}:`, error.message);
        return { available: false, containers: [] };
    }

    const runningContainerIds = allContainers.filter(c => c.State === 'running').map(c => c.id);

    if (runningContainerIds.length > 0) {
        try {
            const statsCommand = `docker stats ${runningContainerIds.join(' ')} --no-stream --format '{{json .}}'`;
            const { stdout: statsStdout, stderr: statsStderr } = await runDockerExec(state, statsCommand, { background: options.background });

            if (statsStderr) {
                console.warn(`[fetchRemoteDockerStatus] Docker stats command stderr on session ${state.ws.sessionId}: ${statsStderr.trim()}`);
            }

            const statsLines = statsStdout.trim() ? statsStdout.trim().split('\n') : [];
            statsLines.forEach(line => {
                try {
                    const statsData = JSON.parse(line) as DockerStats;
                    if (statsData.ID) {
                        statsMap.set(statsData.ID, statsData);
                    }
                } catch (parseError) {
                    console.error(`[fetchRemoteDockerStatus] Failed to parse stats JSON line for session ${state.ws.sessionId}: ${line}`, parseError);
                }
            });
        } catch (error: any) {
            console.warn(`[fetchRemoteDockerStatus] Error executing docker stats for session ${state.ws.sessionId}:`, error.message);
        }
    }

    allContainers.forEach(container => {
        const shortId = container.id.substring(0, 12);
        const stats = statsMap.get(container.id) || statsMap.get(shortId);
        if (stats) {
            container.stats = stats;
        }
    });

    return { available: true, containers: allContainers };
}

export async function handleDockerGetStatus(ws: AuthenticatedWebSocket, sessionId: string | undefined): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    if (!state) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:get_status 请求，但无活动会话状态。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:status:error', payload: { message: 'Session state not found.' } }));
        return;
    }
    if (!state.sshClient) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:get_status 请求，但无活动 SSH 连接。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:status:error', payload: { message: 'SSH connection not active.' } }));
        return;
    }
    try {
        const statusPayload = await fetchRemoteDockerStatus(state);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:status:update', payload: statusPayload }));
    } catch (error: any) {
        console.error(`WebSocket: 手动执行远程 Docker 状态命令失败 for session ${sessionId}:`, error);
        const errorMessage = error.message || 'Unknown error fetching status';
        const isUnavailable = errorMessage.includes('command not found') || errorMessage.includes('Cannot connect to the Docker daemon');
        if (ws.readyState === WebSocket.OPEN) {
            if (isUnavailable) {
                ws.send(JSON.stringify({ type: 'docker:status:update', payload: { available: false, containers: [] } }));
            } else {
                ws.send(JSON.stringify({ type: 'docker:status:error', payload: { message: `Failed to get remote Docker status: ${errorMessage}` } }));
            }
        }
    }
}

export async function handleDockerCommand(ws: AuthenticatedWebSocket, sessionId: string | undefined, payload: any): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    if (!state || !state.sshClient) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:command 请求，但无活动 SSH 连接。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:command:error', payload: { command: payload?.command, message: 'SSH connection not active.' } }));
        return;
    }
    const { containerId, command } = payload || {};
    if (!isValidContainerId(containerId)) {
        console.error(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:command 请求，containerId 格式无效。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:command:error', payload: { command, message: INVALID_CONTAINER_ID_MESSAGE } }));
        return;
    }
    if (!command || !['start', 'stop', 'restart', 'remove'].includes(command)) {
        console.error(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的无效 docker:command 请求。Payload:`, payload);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:command:error', payload: { command: command, message: 'Invalid containerId or command.' } }));
        return;
    }

    console.log(`WebSocket: Processing command '${command}' for container '${containerId}' on session ${sessionId}...`);
    try {
        // containerId was strictly validated above; never interpolate unvalidated input.
        const cleanContainerId = containerId;

        let dockerCliCommand: string;
        switch (command) {
            case 'start': dockerCliCommand = `docker start ${cleanContainerId}`; break;
            case 'stop': dockerCliCommand = `docker stop ${cleanContainerId}`; break;
            case 'restart': dockerCliCommand = `docker restart ${cleanContainerId}`; break;
            case 'remove': dockerCliCommand = `docker rm -f ${cleanContainerId}`; break;
            default: throw new Error(`Unsupported command: ${command}`);
        }

        // start/stop/restart 可能较慢，给更长的超时
        const result = await runDockerExec(state, dockerCliCommand, { timeoutMs: Math.max(DOCKER_EXEC_TIMEOUT_MS, 120000) });
        if (result.code === 0) {
            console.log(`WebSocket: 远程 Docker 命令 (${dockerCliCommand}) on session ${sessionId} 执行成功。`);
        } else {
            console.error(`WebSocket: 远程 Docker 命令 (${dockerCliCommand}) on session ${sessionId} 执行失败 (Code: ${result.code}). Stderr: ${result.stderr.slice(0, 500)}`);
            throw new Error(`Command failed with code ${result.code}. ${result.stderr || 'No stderr output.'}`);
        }

        // Request a status update after a short delay
        setTimeout(() => {
            const currentState = clientStates.get(sessionId!); // Re-fetch state as it might have changed
            if (currentState && currentState.ws.readyState === WebSocket.OPEN) {
                currentState.ws.send(JSON.stringify({ type: 'request_docker_status_update' }));
            }
        }, 500);

    } catch (error: any) {
        console.error(`WebSocket: 执行远程 Docker 命令 (${command} for ${containerId}) 失败 for session ${sessionId}:`, error);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:command:error', payload: { command, containerId, message: `Failed to execute remote command: ${error.message}` } }));
    }
}

export async function handleDockerGetStats(ws: AuthenticatedWebSocket, sessionId: string | undefined, payload: any): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    if (!state || !state.sshClient) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:get_stats 请求，但无活动 SSH 连接。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId: payload?.containerId, message: 'SSH connection not active.' } }));
        return;
    }
    if (!payload || !payload.containerId) {
        console.warn(`WebSocket: Invalid payload for docker:get_stats in session ${sessionId}:`, payload);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId: payload?.containerId, message: 'Missing containerId.' } }));
        return;
    }

    const containerId = payload.containerId;
    if (!isValidContainerId(containerId)) {
        console.warn(`WebSocket: Invalid containerId for docker:get_stats in session ${sessionId}.`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { message: INVALID_CONTAINER_ID_MESSAGE } }));
        return;
    }
    console.log(`WebSocket: Handling docker:get_stats for container ${containerId} in session ${sessionId}`);
    const command = `docker stats ${containerId} --no-stream --format '{{json .}}'`;

    try {
        const execResult = await runDockerExec(state, command);

        if (execResult.stderr) {
            console.error(`WebSocket: Docker stats stderr for ${containerId} in session ${sessionId}: ${execResult.stderr}`);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: execResult.stderr.trim() || 'Error executing stats command.' } }));
            return;
        }

        if (!execResult.stdout) {
            console.warn(`WebSocket: No stats output for container ${containerId} in session ${sessionId}. Might be stopped or error occurred.`);
            if (!execResult.stderr && ws.readyState === WebSocket.OPEN) {
                 ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: 'No stats data received (container might be stopped).' } }));
            }
            return;
        }

        try {
            const statsData = JSON.parse(execResult.stdout.trim());
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:update', payload: { containerId, stats: statsData } }));
        } catch (parseError) {
            console.error(`WebSocket: Failed to parse docker stats JSON for ${containerId} in session ${sessionId}: ${execResult.stdout}`, parseError);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: 'Failed to parse stats data.' } }));
        }

    } catch (error: any) {
        console.error(`WebSocket: Failed to execute docker stats for ${containerId} in session ${sessionId}:`, error);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: error.message || 'Failed to fetch Docker stats.' } }));
    }
}

export async function startDockerStatusPolling(sessionId: string): Promise<void> {
    const state = clientStates.get(sessionId);
    if (!state) {
        console.warn(`[Docker Polling] Cannot start polling for non-existent session ${sessionId}`);
        return;
    }

    console.log(`WebSocket: 会话 ${sessionId} 正在启动 Docker 状态轮询...`);
    let dockerPollIntervalMs = DEFAULT_DOCKER_STATUS_INTERVAL_SECONDS * 1000;
    try {
        const intervalSetting = await settingsService.getSetting('dockerStatusIntervalSeconds');
        if (intervalSetting) {
            const intervalSeconds = parseInt(intervalSetting, 10);
            if (!isNaN(intervalSeconds) && intervalSeconds >= 1) {
                dockerPollIntervalMs = intervalSeconds * 1000;
                console.log(`[Docker Polling] Using interval from settings: ${intervalSeconds}s (${dockerPollIntervalMs}ms) for session ${sessionId}`);
            } else {
                 console.warn(`[Docker Polling] Invalid interval setting '${intervalSetting}' found. Using default ${dockerPollIntervalMs}ms for session ${sessionId}`);
            }
        } else {
            console.log(`[Docker Polling] No interval setting found. Using default ${dockerPollIntervalMs}ms for session ${sessionId}`);
        }
    } catch (settingError) {
         console.error(`[Docker Polling] Error fetching interval setting for session ${sessionId}. Using default ${dockerPollIntervalMs}ms:`, settingError);
    }

    // Clear existing interval if any, to prevent multiple pollers for the same session
    if (state.dockerStatusIntervalId) {
        clearInterval(state.dockerStatusIntervalId);
        console.log(`[Docker Polling] Cleared existing Docker status interval for session ${sessionId}.`);
    }

    let pollInFlight = false;
    const dockerIntervalId = setInterval(async () => {
        // 上一轮还没结束 (例如 dockerd 卡住) 时跳过本轮，避免轮询命令不断堆积
        if (pollInFlight) return;
        const currentState = clientStates.get(sessionId); // Re-fetch state in case it changed (e.g., disconnected)
        if (!currentState || currentState.ws.readyState !== WebSocket.OPEN || !currentState.sshClient) {
            console.log(`[Docker Polling] Session ${sessionId} no longer valid, WS closed, or SSH disconnected. Stopping poll.`);
            clearInterval(dockerIntervalId);
            if (currentState && currentState.dockerStatusIntervalId === dockerIntervalId) { // Ensure we only delete our own interval ID
                delete currentState.dockerStatusIntervalId;
            }
            return;
        }
        pollInFlight = true;
        try {
            const statusPayload = await fetchRemoteDockerStatus(currentState, { background: true });
            if (currentState.ws.readyState === WebSocket.OPEN) { // Check again before sending
                currentState.ws.send(JSON.stringify({ type: 'docker:status:update', payload: statusPayload }));
            }
        } catch (error: any) {
            console.error(`[Docker Polling] Error fetching Docker status for session ${sessionId}:`, error.message);
            // Optionally send an error to the client if polling fails consistently,
            // but be mindful of flooding the client with errors.
            // if (currentState.ws.readyState === WebSocket.OPEN) {
            //     currentState.ws.send(JSON.stringify({ type: 'docker:status:error', payload: { message: `Polling error: ${error.message}` } }));
            // }
        } finally {
            pollInFlight = false;
        }
    }, dockerPollIntervalMs);
    state.dockerStatusIntervalId = dockerIntervalId;

    // Initial fetch
    const initialState = clientStates.get(sessionId);
    if (initialState && initialState.ws.readyState === WebSocket.OPEN && initialState.sshClient) {
        console.log(`[Docker Initial Fetch] Fetching status for session ${sessionId}...`);
        try {
            const statusPayload = await fetchRemoteDockerStatus(initialState, { background: true });
            if (initialState.ws.readyState === WebSocket.OPEN) { // Check again
                initialState.ws.send(JSON.stringify({ type: 'docker:status:update', payload: statusPayload }));
            }
        } catch (error: any) {
            console.error(`[Docker Initial Fetch] Error fetching Docker status for session ${sessionId}:`, error.message);
            if (initialState.ws.readyState === WebSocket.OPEN) {
                 const errorMessage = error.message || 'Unknown error during initial fetch';
                 const isUnavailable = errorMessage.includes('command not found') || errorMessage.includes('Cannot connect to the Docker daemon');
                 if (isUnavailable) {
                     initialState.ws.send(JSON.stringify({ type: 'docker:status:update', payload: { available: false, containers: [] } }));
                 } else {
                     initialState.ws.send(JSON.stringify({ type: 'docker:status:error', payload: { message: `Initial Docker status fetch failed: ${errorMessage}` } }));
                 }
            }
        }
    }
}