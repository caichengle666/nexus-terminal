# 基础镜像固定到具体版本 (由 Dependabot 每周检查更新)，保证构建可复现。
FROM node:22.23.3-bookworm AS builder

WORKDIR /app

# 根 workspace 的 package.json 与锁文件 + 各 workspace 的 package.json (npm ci 需要完整的 workspace 结构)
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/

# 仅安装后端 workspace 的依赖 (含 devDependencies，用于 tsc 构建)。构建不需要原生模块，跳过安装脚本。
RUN npm ci -w @nexus-terminal/backend --ignore-scripts --no-audit --no-fund

COPY packages/backend/src ./packages/backend/src
COPY packages/backend/tsconfig.json ./packages/backend/
COPY packages/backend/html-presets ./packages/backend/html-presets

RUN npm run build --workspace=@nexus-terminal/backend


FROM node:22.23.3-alpine3.24

WORKDIR /app

# 运行时依赖严格按根锁文件安装 (npm ci)，并在 alpine (musl) 中安装/编译原生模块 (sqlite3、bcrypt)，
# 保证与运行环境一致。构建工具在安装后删除。
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/
RUN apk add --no-cache --virtual .build-deps python3 py3-setuptools make g++ \
    && npm ci --omit=dev -w @nexus-terminal/backend --no-audit --no-fund \
    && npm cache clean --force \
    && apk del .build-deps \
    && apk add --no-cache su-exec

# 后端位于 /app/packages/backend，使 Node 能同时解析 workspace 内嵌依赖
# (packages/backend/node_modules) 与提升到 /app/node_modules 的依赖。
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/src/locales ./packages/backend/dist/locales
COPY --from=builder /app/packages/backend/html-presets ./packages/backend/html-presets

# 数据目录保持为 /app/data (docker-compose 挂载 ./data:/app/data)
ENV APP_BACKEND_DATA_PATH=/app/data
WORKDIR /app/packages/backend

EXPOSE 3001

COPY packages/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
