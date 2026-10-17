#!/bin/sh
# 以 root 启动仅用于修正挂载卷 /app/data 的属主（兼容旧版本以 root 写入的数据），
# 随后降权为 node 用户运行后端。
set -e
mkdir -p /app/data
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data
  exec su-exec node "$@"
fi
exec "$@"
