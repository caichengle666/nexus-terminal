#!/usr/bin/env bash
# Docker upgrade + smoke test, run by .github/workflows/ci.yml.
#  Phase A: start the currently published images (NEXUS_OLD_TAG, default latest),
#           create the admin and an SSH connection (encrypted password).
#  Phase B: replace them with images built from this commit on the same data
#           volume, then check: health of every service, migrations, login with
#           the old credentials, decrypting the old connection (real SSH test),
#           nginx security headers, gateway health, and a browser run (web-smoke.js).
set -euo pipefail
cd "$(dirname "$0")/../.."

OLD_TAG="${NEXUS_OLD_TAG:-latest}"
NEW_TAG="smoke"
BASE="http://127.0.0.1:18111"
JAR="$(mktemp)"
PASS='NexusSmoke#2026'
SSH_PASS='SshSmoke#2026'
fail() { echo "::error::docker smoke: $*"; docker compose logs --no-color --tail=200 || true; exit 1; }
note() { echo "::notice::docker smoke PASS: $*"; }

cp .env .env.smoke-backup
cleanup() { mv .env.smoke-backup .env; docker compose down -v >/dev/null 2>&1 || true; docker rm -f nexus-smoke-sshd >/dev/null 2>&1 || true; }
trap cleanup EXIT
{
  echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
  echo "SESSION_SECRET=$(openssl rand -hex 64)"
  echo "REMOTE_GATEWAY_SECRET=$(openssl rand -hex 32)"
  echo "SETUP_TOKEN=smoke-setup-token-0123456789"
} >> .env
rm -rf data && mkdir -p data

wait_healthy() { # service... ; 180 s budget
  for _ in $(seq 1 90); do
    local ok=1
    for svc in "$@"; do
      state="$(docker inspect -f '{{.State.Health.Status}}' "nexus-terminal-$svc" 2>/dev/null || echo missing)"
      [ "$state" = "healthy" ] || ok=0
    done
    [ $ok = 1 ] && return 0
    sleep 2
  done
  for svc in "$@"; do echo "$svc: $(docker inspect -f '{{.State.Health.Status}}' "nexus-terminal-$svc" 2>/dev/null)"; done
  return 1
}
api() { # method path [json]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -o /tmp/api.out -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$method" -H 'Content-Type: application/json' -H "Origin: $BASE" --data "$body" "$BASE$path"
  else
    curl -s -o /tmp/api.out -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$method" -H "Origin: $BASE" "$BASE$path"
  fi
}

# ---------- Phase A: published images ----------
NEXUS_IMAGE_TAG="$OLD_TAG" docker compose pull -q frontend backend remote-gateway guacd
NEXUS_IMAGE_TAG="$OLD_TAG" docker compose up -d --no-build
docker run -d --name nexus-smoke-sshd --network nexus-terminal-network --network-alias sshd \
  -e PUID=1000 -e PGID=1000 -e PASSWORD_ACCESS=true -e USER_NAME=smoke -e USER_PASSWORD="$SSH_PASS" \
  lscr.io/linuxserver/openssh-server:latest >/dev/null
wait_healthy backend || fail "old backend never became healthy"
for _ in $(seq 1 30); do [ "$(api GET /api/v1/auth/needs-setup)" = 200 ] && break; sleep 2; done
code=$(api POST /api/v1/auth/setup "{\"username\":\"admin\",\"password\":\"$PASS\",\"confirmPassword\":\"$PASS\",\"setupToken\":\"smoke-setup-token-0123456789\"}")
[ "${code:0:1}" = 2 ] || fail "old setup $code $(cat /tmp/api.out)"
code=$(api POST /api/v1/auth/login "{\"username\":\"admin\",\"password\":\"$PASS\"}")
[ "$code" = 200 ] || fail "old login $code $(cat /tmp/api.out)"
code=$(api POST /api/v1/connections "{\"name\":\"upgrade-ssh\",\"type\":\"SSH\",\"host\":\"sshd\",\"port\":2222,\"username\":\"smoke\",\"auth_method\":\"password\",\"password\":\"$SSH_PASS\"}")
[ "${code:0:1}" = 2 ] || fail "old create connection $code $(cat /tmp/api.out)"
CONN_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/api.out","utf8"));console.log(j.id ?? j.connection?.id ?? j.data?.id ?? "")')"
[ -n "$CONN_ID" ] || fail "no connection id in $(cat /tmp/api.out)"
sleep 3
code=$(api POST "/api/v1/connections/$CONN_ID/test")
echo "old image connection test: $code $(cat /tmp/api.out)"
note "phase A on $OLD_TAG images: admin + SSH connection $CONN_ID created"
docker exec nexus-smoke-sshd sh -c 'touch /config/sftp_smoke_marker.txt && chown 1000:1000 /config/sftp_smoke_marker.txt'
docker compose stop frontend backend remote-gateway

# ---------- Phase B: images from this commit, same data ----------
NEXUS_IMAGE_TAG="$NEW_TAG" docker compose build
NEXUS_IMAGE_TAG="$NEW_TAG" docker compose up -d --no-build --force-recreate frontend backend remote-gateway
wait_healthy backend frontend remote-gateway || fail "new services never became healthy"
note "backend, frontend and remote-gateway healthy"

docker compose logs --no-color backend > /tmp/backend.log
grep -qiE "迁移失败|migration failed|SQLITE_ERROR|Error: Cannot find module|ERR_DLOPEN|invalid ELF" /tmp/backend.log && fail "backend log shows startup/migration errors"
note "no migration or native-module errors in backend log"

hdrs="$(curl -sI "$BASE/")"
for h in "X-Frame-Options" "X-Content-Type-Options" "Referrer-Policy" "Content-Security-Policy"; do
  echo "$hdrs" | grep -qi "^$h:" || fail "missing header $h"
done
note "nginx security headers present"

rm -f "$JAR"; JAR="$(mktemp)"
code=$(api POST /api/v1/auth/login "{\"username\":\"admin\",\"password\":\"wrong-password-xyz\"}")
[ "$code" != 200 ] || fail "wrong password accepted"
code=$(api POST /api/v1/auth/login "{\"username\":\"admin\",\"password\":\"$PASS\"}")
[ "$code" = 200 ] || fail "login with pre-upgrade credentials $code $(cat /tmp/api.out)"
note "pre-upgrade admin can log in"
code=$(api GET /api/v1/connections)
grep -q upgrade-ssh /tmp/api.out || fail "pre-upgrade connection missing after upgrade ($code)"
code=$(api POST "/api/v1/connections/$CONN_ID/test")
[ "$code" = 200 ] && grep -q '"success":true' /tmp/api.out || fail "SSH test with the pre-upgrade encrypted password failed: $code $(cat /tmp/api.out)"
note "pre-upgrade encrypted SSH password still decrypts; real SSH login ok"
code=$(api GET /api/v1/settings)
[ "$code" = 200 ] || fail "settings $code"
code=$(api POST /api/v1/connections/export "{}")
[ "${code:0:1}" = 4 ] || fail "export without current password returned $code"
note "export requires re-authentication"

docker compose exec -T remote-gateway wget -q -O - http://127.0.0.1:9090/api/health >/dev/null || fail "gateway health"
note "remote gateway reaches guacd"

SMOKE_BASE="$BASE" SMOKE_PASS="$PASS" SMOKE_CONN="upgrade-ssh" SMOKE_SFTP_MARKER=sftp_smoke_marker.txt SMOKE_DIR=smoke/web node .github/smoke/web-smoke.js || fail "browser smoke failed"
code=$(api POST /api/v1/auth/logout)
code=$(api GET /api/v1/auth/status)
[ "$code" = 401 ] || fail "still authenticated after logout ($code)"
note "logout ends the session"
echo "::notice::docker upgrade + smoke test passed"
