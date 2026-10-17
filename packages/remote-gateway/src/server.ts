// @ts-ignore - Still need this for the import as no types exist
import GuacamoleLite from 'guacamole-lite';
import express, { Request, Response } from 'express';
import http from 'http';
import crypto from 'crypto';
import cors from 'cors';
import * as net from 'net';

// --- 配置 ---
const REMOTE_GATEWAY_WS_PORT = process.env.REMOTE_GATEWAY_WS_PORT || 8080; // 统一端口，或按需分开
const REMOTE_GATEWAY_API_PORT = process.env.REMOTE_GATEWAY_API_PORT || 9090;
const GUACD_HOST = process.env.GUACD_HOST || 'localhost';
const GUACD_PORT = parseInt(process.env.GUACD_PORT || '4822', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'http://localhost:3000';

// --- 网关共享密钥 ---
// 后端调用 POST /api/remote-desktop/token 时必须携带请求头 X-Gateway-Secret = REMOTE_GATEWAY_SECRET。
// 未设置该变量时，API 仅监听 127.0.0.1 (适用于本地/开发模式)，除非显式设置 REMOTE_GATEWAY_API_HOST。
const REMOTE_GATEWAY_SECRET = (process.env.REMOTE_GATEWAY_SECRET || '').trim();
// REMOTE_GATEWAY_API_HOST: 监听地址；'*' 表示所有接口 (IPv4 + IPv6)。
// 默认：设置了共享密钥时监听所有接口，否则仅监听 127.0.0.1。
const rawApiHost = (process.env.REMOTE_GATEWAY_API_HOST || '').trim();
const REMOTE_GATEWAY_API_HOST: string | undefined = rawApiHost
    ? (rawApiHost === '*' ? undefined : rawApiHost)
    : (REMOTE_GATEWAY_SECRET ? undefined : '127.0.0.1');
const API_HOST_LABEL = REMOTE_GATEWAY_API_HOST ?? '*';
const isLoopbackHost = (host: string | undefined) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

if (!REMOTE_GATEWAY_SECRET) {
    if (isLoopbackHost(REMOTE_GATEWAY_API_HOST)) {
        console.warn(`[Remote Gateway] 警告：未设置 REMOTE_GATEWAY_SECRET，令牌 API 仅监听 ${API_HOST_LABEL}。如需供其他主机/容器访问，请在后端与网关两侧配置相同的 REMOTE_GATEWAY_SECRET。`);
    } else {
        console.warn(`[Remote Gateway] !!! 安全警告：未设置 REMOTE_GATEWAY_SECRET，但令牌 API 监听在 ${API_HOST_LABEL}。任何能访问该端口的客户端都可以申请远程桌面令牌。请尽快在 .env 中设置 REMOTE_GATEWAY_SECRET (重新运行 install.sh 会自动生成)。 !!!`);
    }
}

const timingSafeEqualStrings = (a: string, b: string): boolean => {
    const aBuf = crypto.createHash('sha256').update(a, 'utf8').digest();
    const bBuf = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(aBuf, bBuf) && a.length === b.length;
};

const requireGatewaySecret = (req: Request, res: Response, next: () => void): void => {
    if (!REMOTE_GATEWAY_SECRET) {
        next();
        return;
    }
    const header = req.headers['x-gateway-secret'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (typeof provided !== 'string' || !timingSafeEqualStrings(provided, REMOTE_GATEWAY_SECRET)) {
        console.warn(`[Remote Gateway] 拒绝未授权的令牌请求 (来源: ${req.socket.remoteAddress})。`);
        res.status(401).json({ error: '未授权' });
        return;
    }
    next();
};

// --- 令牌有效期 (TTL) ---
// 已签发令牌的 ID 与过期时间保存在内存中；WebSocket 握手时校验 (verifyClient)，过期或未知令牌将被拒绝。
const TOKEN_TTL_MS = Math.max(5, parseInt(process.env.REMOTE_GATEWAY_TOKEN_TTL_SECONDS || '60', 10) || 60) * 1000;
const issuedTokens = new Map<string, number>(); // jti -> expiresAt (ms)

const sweepExpiredTokens = () => {
    const now = Date.now();
    for (const [jti, expiresAt] of issuedTokens) {
        if (expiresAt <= now) issuedTokens.delete(jti);
    }
};
setInterval(sweepExpiredTokens, 30 * 1000).unref();

// --- 启动时生成内存加密密钥 ---
console.log("[Remote Gateway] 正在为此会话生成新的内存加密密钥...");
const ENCRYPTION_KEY_STRING = crypto.randomBytes(32).toString('hex');
const ENCRYPTION_KEY_BUFFER = Buffer.from(ENCRYPTION_KEY_STRING, 'hex');
console.log("[Remote Gateway] 内存加密密钥已生成。");

// --- Express 应用设置 ---
const app = express();
app.use(express.json()); // 用于解析请求体中的 JSON
const apiServer = http.createServer(app);

const allowedOrigins = [
    FRONTEND_URL,
    MAIN_BACKEND_URL
];
console.log(`[Remote Gateway] CORS 允许的来源: ${allowedOrigins.join(', ')}`);
app.use(cors({ origin: allowedOrigins }));

const checkGuacdReachable = (): Promise<boolean> => {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: GUACD_HOST, port: GUACD_PORT });
        const timeout = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, 2000);

        socket.once('connect', () => {
            clearTimeout(timeout);
            socket.end();
            resolve(true);
        });

        socket.once('error', () => {
            clearTimeout(timeout);
            resolve(false);
        });
    });
};


const guacdOptions = {
    host: GUACD_HOST,
    port: GUACD_PORT,
};

const decryptTokenPayload = (token: string): any => {
    const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY_BUFFER, Buffer.from(tokenData.iv, 'base64'));
    let decrypted = decipher.update(Buffer.from(tokenData.value, 'base64'), undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
};

// 在 WebSocket 握手阶段校验令牌有效期，拒绝过期/未签发的令牌 (在 guacamole-lite 连接 guacd 之前)
const verifyClient = (
    info: { req: http.IncomingMessage },
    callback: (result: boolean, code?: number, message?: string) => void
): void => {
    try {
        const requestUrl = new URL(info.req.url || '/', 'http://gateway.local');
        const token = requestUrl.searchParams.get('token');
        if (!token) {
            callback(false, 401, 'Missing token');
            return;
        }
        const payload = decryptTokenPayload(token);
        const jti = typeof payload?.jti === 'string' ? payload.jti : '';
        const expiresAt = issuedTokens.get(jti);
        if (!jti || expiresAt === undefined || expiresAt <= Date.now() || typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
            if (jti) issuedTokens.delete(jti);
            console.warn('[Remote Gateway] 拒绝 WebSocket 连接：令牌已过期或无效。');
            callback(false, 401, 'Token expired or invalid');
            return;
        }
        callback(true);
    } catch (error) {
        console.warn('[Remote Gateway] 拒绝 WebSocket 连接：令牌解析失败。');
        callback(false, 401, 'Invalid token');
    }
};

const websocketOptions = {
    port: REMOTE_GATEWAY_WS_PORT,
    host: '0.0.0.0', // 监听所有接口
    verifyClient,
};

const clientOptions = {
    crypt: {
        key: ENCRYPTION_KEY_BUFFER,
        cypher: 'aes-256-cbc'
    },
    // 默认连接设置将根据协议动态调整
    connectionDefaultSettings: {},
};

let guacServer: any;

try {
    console.log(`[Remote Gateway] 正在使用选项初始化 GuacamoleLite: WS 端口=${websocketOptions.port}, Guacd=${guacdOptions.host}:${guacdOptions.port}`);
    guacServer = new GuacamoleLite(websocketOptions, guacdOptions, clientOptions);
    console.log(`[Remote Gateway] GuacamoleLite 初始化成功。`);

    if (guacServer.on) {
        guacServer.on('error', (error: Error) => {
            console.error(`[Remote Gateway] GuacamoleLite 服务器错误:`, error);
        });
        guacServer.on('connection', (client: any) => {
            const clientId = client.id || '未知客户端ID';
            console.log(`[Remote Gateway] Guacd 连接事件触发。客户端 ID: ${clientId}`);

            if (client && typeof client.on === 'function') {
                client.on('disconnect', (reason: string) => {
                    console.log(`[Remote Gateway] Guacd 连接断开。客户端 ID: ${clientId}, 原因: ${reason || '未知'}`);
                });
                client.on('error', (err: Error) => {
                     console.error(`[Remote Gateway] Guacd 客户端错误。客户端 ID: ${clientId}, 错误:`, err);
                });
            }
        });
   }
} catch (error) {
   console.error(`[Remote Gateway] 初始化 GuacamoleLite 失败:`, error);
   process.exit(1);
}

const encryptToken = (data: string, keyBuffer: Buffer): string => {
    try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);
        let encrypted = cipher.update(data, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        const output = {
            iv: iv.toString('base64'),
            value: encrypted
        };
        const jsonString = JSON.stringify(output);
        return Buffer.from(jsonString).toString('base64');
    } catch (e) {
        console.error("[Remote Gateway] 令牌加密失败:", e);
        throw new Error("令牌加密失败。");
    }
};

app.post('/api/remote-desktop/token', requireGatewaySecret, (req: Request, res: Response): void => {
    const { protocol, connectionConfig } = req.body;

    if (!protocol || !connectionConfig) {
        res.status(400).json({ error: '缺少必需的参数 (protocol, connectionConfig)' });
        return;
    }

    if (protocol !== 'rdp' && protocol !== 'vnc') {
        res.status(400).json({ error: '无效的协议类型。支持 "rdp" 或 "vnc"。' });
        return;
    }

    const { hostname, port, username, password, width, height, dpi, security, ignoreCert } = connectionConfig;

    if (!hostname || !port) {
        res.status(400).json({ error: '缺少必需的连接参数 (hostname, port)' });
        return;
    }

    let settings: any = {
        hostname: hostname as string,
        port: port as string,
        width: String(width || '1024'),
        height: String(height || '768'),
    };

    if (protocol === 'rdp') {
        if (typeof username === 'undefined' || typeof password === 'undefined') {
            res.status(400).json({ error: 'RDP 连接缺少 username 或 password' });
            return;
        }
        settings.username = username as string;
        settings.password = password as string;
        settings.security = security || 'any'; // RDP 特有，使用默认值 'any'
        settings['ignore-cert'] = String(ignoreCert || 'true'); // RDP 特有
        settings.dpi = String(dpi || '96'); // RDP 特有
    } else if (protocol === 'vnc') {
        if (typeof password === 'undefined') {
            res.status(400).json({ error: 'VNC 连接缺少 password' });
            return;
        }
        settings.password = password as string;
        if (username) { // VNC 可选 username
            settings.username = username as string;
        }
        // VNC 特有的其他参数可以根据需要从 connectionConfig 中获取并添加
        // 例如: settings['enable-audio'] = connectionConfig.enableAudio || 'false';
    }

    const jti = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + TOKEN_TTL_MS;

    const connectionParams = {
        jti,
        exp: expiresAt,
        connection: {
            type: protocol, // 'rdp' or 'vnc'
            settings: settings
        }
    };

    try {
        const tokenData = JSON.stringify(connectionParams);
        const encryptedToken = encryptToken(tokenData, ENCRYPTION_KEY_BUFFER);
        issuedTokens.set(jti, expiresAt);
        res.json({ token: encryptedToken, expiresAt });
    } catch (error) {
        console.error("[Remote Gateway] /api/remote-desktop/token 接口出错:", error);
        res.status(500).json({ error: '生成令牌失败' });
    }
});

app.get('/api/health', async (_req: Request, res: Response): Promise<void> => {
    const guacdReachable = await checkGuacdReachable();
    res.status(guacdReachable ? 200 : 503).json({
        ok: guacdReachable,
        service: 'remote-gateway',
        guacdHost: GUACD_HOST,
        guacdPort: GUACD_PORT,
        message: guacdReachable ? '远程桌面网关可用。' : '远程桌面网关已启动，但 guacd 不可用。',
    });
});

const onApiListening = () => {
    console.log(`[Remote Gateway] API 服务器正在监听 ${API_HOST_LABEL}:${REMOTE_GATEWAY_API_PORT} (共享密钥校验: ${REMOTE_GATEWAY_SECRET ? '已启用' : '未启用'})`);
    console.log(`[Remote Gateway] Guacamole WebSocket 服务器应在端口 ${REMOTE_GATEWAY_WS_PORT} 上运行 (由 GuacamoleLite 管理)`);
};
if (REMOTE_GATEWAY_API_HOST) {
    apiServer.listen(Number(REMOTE_GATEWAY_API_PORT), REMOTE_GATEWAY_API_HOST, onApiListening);
} else {
    apiServer.listen(Number(REMOTE_GATEWAY_API_PORT), onApiListening);
}

const gracefulShutdown = (signal: string) => {
    console.log(`[Remote Gateway] 收到 ${signal} 信号。正在优雅地关闭...`);

  let guacClosed = false;
  let apiClosed = false;

  const tryExit = () => {
    if (guacClosed && apiClosed) {
      console.log("[Remote Gateway] 所有服务器已关闭。正在退出。");
      process.exit(0);
    }
  };

  apiServer.close((err) => {
    if (err) {
        console.error("[Remote Gateway] 关闭 API 服务器时出错:", err);
    } else {
        console.log("[Remote Gateway] API 服务器已关闭。");
    }
    apiClosed = true;
    tryExit();
  });

  if (typeof guacServer !== 'undefined' && guacServer && typeof guacServer.close === 'function') {
    console.log("[Remote Gateway] 正在关闭 Guacamole 服务器...");
    guacServer.close(() => {
        console.log("[Remote Gateway] Guacamole 服务器已关闭。");
        guacClosed = true;
        tryExit();
    });
  } else {
    console.log("[Remote Gateway] Guacamole 服务器未运行或不支持 close() 方法。");
    guacClosed = true;
    tryExit();
  }

  setTimeout(() => {
    console.error("[Remote Gateway] 关闭超时。强制退出。");
    process.exit(1);
  }, 10000); // 10 秒超时
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGUSR2', () => {
    gracefulShutdown('SIGUSR2 (nodemon restart)');
});
