# 基础镜像固定到具体版本 (由 Dependabot 每周检查更新)，保证构建可复现。
FROM node:22.23.3-alpine3.24 AS builder

WORKDIR /app

# 使用根 workspace 锁文件安装 (npm ci)，依赖版本与仓库锁定一致
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/

# 安装网关 workspace 的全部依赖 (含 typescript 等 devDependencies) 用于构建
RUN npm ci -w @nexus-terminal/remote-gateway --ignore-scripts --no-audit --no-fund

COPY packages/remote-gateway/src ./packages/remote-gateway/src
COPY packages/remote-gateway/tsconfig.json ./packages/remote-gateway/tsconfig.json
COPY packages/remote-gateway/guacamole-lite.d.ts ./packages/remote-gateway/guacamole-lite.d.ts

RUN npm run build --workspace=@nexus-terminal/remote-gateway

# --- Production Stage ---
FROM node:22.23.3-alpine3.24

WORKDIR /app

# 运行时仅安装生产依赖，严格按根锁文件 (网关没有原生模块)
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/
RUN npm ci --omit=dev -w @nexus-terminal/remote-gateway --no-audit --no-fund \
    && npm cache clean --force

# 网关位于 /app/packages/remote-gateway，可同时解析 workspace 内嵌依赖与 /app/node_modules
COPY --from=builder /app/packages/remote-gateway/dist ./packages/remote-gateway/dist
WORKDIR /app/packages/remote-gateway

# Expose the API and WebSocket ports
EXPOSE 9090
EXPOSE 8080

USER node
CMD ["node", "dist/server.js"]
