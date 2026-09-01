#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

readonly DEFAULT_INSTALL_DIR="/opt/nexus-terminal"
readonly DEFAULT_REPOSITORY="caichengle666/nexus-terminal"
readonly DEFAULT_REF="main"
readonly DEFAULT_PORT="18111"
readonly ARM64_GUACD_IMAGE="guacamole/guacd:1.6.0-RC1"

INSTALL_DIR="${NEXUS_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
REPOSITORY="${NEXUS_REPOSITORY:-$DEFAULT_REPOSITORY}"
REF="${NEXUS_REF:-$DEFAULT_REF}"
REQUESTED_TAG=""
DRY_RUN=0
NON_INTERACTIVE=0
FORCE_INTERACTIVE=0
SUDO=""
TEMP_DIR=""
LOCK_DIR=""
LOCK_ACQUIRED=0

print_info() { printf '\033[1;34m[信息]\033[0m %s\n' "$*"; }
print_ok() { printf '\033[1;32m[完成]\033[0m %s\n' "$*"; }
print_warn() { printf '\033[1;33m[注意]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Nexus Terminal 一键安装/更新脚本

用法:
  curl -fsSL https://raw.githubusercontent.com/caichengle666/nexus-terminal/main/install.sh | bash

参数:
  --dir PATH       安装目录，默认 /opt/nexus-terminal
  --tag TAG        镜像标签，例如 latest、0.9.22.18
  --ref REF        下载 Compose 的 Git 分支或标签，默认 main
  --non-interactive  无终端提示，直接使用默认值或现有配置
  --interactive    强制进入交互模式，没有终端时失败
  --dry-run        只下载并校验，不修改文件、不拉取镜像
  -h, --help       显示帮助

环境变量:
  NEXUS_INSTALL_DIR、NEXUS_REPOSITORY、NEXUS_REF
EOF
}

run_as_root() {
  if [[ -n "$SUDO" ]]; then
    "$SUDO" "$@"
  else
    "$@"
  fi
}

cleanup() {
  if [[ "$LOCK_ACQUIRED" -eq 1 && -n "$LOCK_DIR" ]]; then
    run_as_root rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
  if [[ -n "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR" 2>/dev/null || true
  fi
}

on_error() {
  local exit_code=$?
  printf '\033[1;31m[失败]\033[0m 脚本在第 %s 行退出，退出码: %s\n' "${BASH_LINENO[0]:-unknown}" "$exit_code" >&2
  exit "$exit_code"
}

trap cleanup EXIT
trap on_error ERR

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir)
        [[ $# -ge 2 ]] || die "--dir 需要一个路径。"
        INSTALL_DIR="$2"
        shift 2
        ;;
      --tag)
        [[ $# -ge 2 ]] || die "--tag 需要一个镜像标签。"
        REQUESTED_TAG="$2"
        shift 2
        ;;
      --ref)
        [[ $# -ge 2 ]] || die "--ref 需要一个分支或标签。"
        REF="$2"
        shift 2
        ;;
      --non-interactive)
        NON_INTERACTIVE=1
        shift
        ;;
      --interactive)
        FORCE_INTERACTIVE=1
        NON_INTERACTIVE=0
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "未知参数: $1。使用 --help 查看用法。"
        ;;
    esac
  done
}

validate_args() {
  [[ "$INSTALL_DIR" = /* ]] || die "安装目录必须是绝对路径: $INSTALL_DIR"
  [[ "$INSTALL_DIR" != "/" ]] || die "不能把根目录作为安装目录。"
  [[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "仓库格式必须是 owner/name。"
  [[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "无效的仓库分支或标签: $REF"

  if [[ -n "$REQUESTED_TAG" ]]; then
    [[ "$REQUESTED_TAG" =~ ^[A-Za-z0-9._-]+$ ]] || die "无效的镜像标签: $REQUESTED_TAG"
  fi
}

prepare_privileges() {
  if [[ "$EUID" -eq 0 ]]; then
    return
  fi
  command -v sudo >/dev/null 2>&1 || die "当前用户不是 root，且系统没有 sudo。请使用 sudo bash 执行。"
  SUDO="sudo"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少依赖命令: $1"
}

prepare_dependencies() {
  require_command mktemp
  require_command awk
  require_command sed
  require_command date
  require_command curl

  run_as_root docker info >/dev/null 2>&1 || die "Docker 未运行，或当前用户没有访问 Docker 的权限。"
  run_as_root docker compose version >/dev/null 2>&1 || die "未找到 Docker Compose 插件，请安装 Docker Compose v2。"
}

has_interactive_terminal() {
  [[ "$NON_INTERACTIVE" -eq 0 ]] && { [[ -t 0 ]] || [[ -r /dev/tty && -w /dev/tty ]]; }
}

tty_print() {
  printf '%s' "$*" > /dev/tty
}

tty_read() {
  local variable_name="$1"
  IFS= read -r "$variable_name" < /dev/tty
}

read_existing_image_tag() {
  if run_as_root test -f "$INSTALL_DIR/.env"; then
    run_as_root awk -F= '$1 == "NEXUS_IMAGE_TAG" { value=$2 } END { gsub(/[[:space:]]/, "", value); print value }' "$INSTALL_DIR/.env" 2>/dev/null || true
  fi
}

prompt_for_install_options() {
  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    return
  fi
  if ! has_interactive_terminal; then
    [[ "$FORCE_INTERACTIVE" -eq 1 ]] && die "已要求交互模式，但当前没有可用终端。"
    return
  fi

  local action="安装"
  run_as_root test -f "$INSTALL_DIR/docker-compose.yml" && action="更新"

  tty_print "\nNexus Terminal 一键${action}\n"
  tty_print "直接回车将使用默认值。\n\n"
  tty_print "安装目录 [${INSTALL_DIR}]: "
  local input=""
  tty_read input || die "无法读取安装目录。"
  [[ -n "$input" ]] && INSTALL_DIR="$input"

  local default_tag="${REQUESTED_TAG:-$(read_existing_image_tag)}"
  default_tag="${default_tag:-latest}"
  tty_print "镜像标签 [${default_tag}]: "
  input=""
  tty_read input || die "无法读取镜像标签。"
  [[ -n "$input" ]] && REQUESTED_TAG="$input"

  local selected_tag="${REQUESTED_TAG:-$(read_existing_image_tag)}"
  selected_tag="${selected_tag:-latest}"
  tty_print "\n即将使用：\n"
  tty_print "  安装目录: ${INSTALL_DIR}\n"
  tty_print "  镜像标签: ${selected_tag}\n"
  tty_print "  数据目录: ${INSTALL_DIR}/data（保留现有数据）\n\n"
  tty_print "确认继续？[Y/n]: "
  input=""
  tty_read input || die "无法读取确认选项。"
  case "$input" in
    n|N|no|NO|No) die "用户取消安装。" ;;
  esac
}

download_file() {
  local url="$1"
  local destination="$2"
  curl --fail --location --silent --show-error \
    --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 120 \
    "$url" -o "$destination"
}

read_env_tag() {
  local env_file="$1"
  awk -F= '$1 == "NEXUS_IMAGE_TAG" { value=$2 } END { gsub(/[[:space:]]/, "", value); print value }' "$env_file"
}

set_env_tag() {
  local source="$1"
  local destination="$2"
  local tag="$3"
  awk -v tag="$tag" '
    BEGIN { replaced = 0 }
    /^NEXUS_IMAGE_TAG[[:space:]]*=/ {
      if (!replaced) {
        print "NEXUS_IMAGE_TAG=" tag
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (!replaced) print "NEXUS_IMAGE_TAG=" tag
    }
  ' "$source" > "$destination"
}

prepare_temp_files() {
  TEMP_DIR="$(mktemp -d -t nexus-terminal-install.XXXXXX)"
  local raw_base="https://raw.githubusercontent.com/${REPOSITORY}/${REF}"
  local compose_candidate="$TEMP_DIR/docker-compose.yml"
  local env_candidate="$TEMP_DIR/.env"

  print_info "下载 Docker Compose 配置 (${REPOSITORY}@${REF})..."
  download_file "${raw_base}/docker-compose.yml" "$compose_candidate"

  if run_as_root test -f "$INSTALL_DIR/.env"; then
    print_info "保留现有 .env 配置。"
    run_as_root cat "$INSTALL_DIR/.env" > "$env_candidate"
  else
    print_info "首次安装，下载默认 .env 配置。"
    download_file "${raw_base}/.env" "$env_candidate"
  fi

  if [[ "$(uname -s)" == "Linux" ]]; then
    case "$(uname -m)" in
      aarch64|arm64)
        print_info "检测到 ARM64，使用兼容的 ${ARM64_GUACD_IMAGE}。"
        sed -i.bak "s#guacamole/guacd:latest#${ARM64_GUACD_IMAGE}#g" "$compose_candidate"
        rm -f "${compose_candidate}.bak"
        ;;
      armv7l|armv6l)
        die "当前 Docker 镜像不提供 ARMv7/ARMv6 架构，请使用 ARM64 或 AMD64 主机。"
        ;;
    esac
  fi

  local image_tag="${REQUESTED_TAG:-$(read_env_tag "$env_candidate")}"
  image_tag="${image_tag:-latest}"
  [[ "$image_tag" =~ ^[A-Za-z0-9._-]+$ ]] || die ".env 中的 NEXUS_IMAGE_TAG 无效: $image_tag"

  if [[ -n "$REQUESTED_TAG" ]]; then
    local updated_env="$TEMP_DIR/.env.updated"
    set_env_tag "$env_candidate" "$updated_env" "$REQUESTED_TAG"
    mv "$updated_env" "$env_candidate"
  fi

  printf '%s\n' "$image_tag" > "$TEMP_DIR/image-tag"
  printf '%s\n' "$compose_candidate" > "$TEMP_DIR/compose-path"
  printf '%s\n' "$env_candidate" > "$TEMP_DIR/env-path"
}

compose() {
  local compose_file="$1"
  local env_file="$2"
  shift 2
  run_as_root docker compose \
    --project-directory "$INSTALL_DIR" \
    --file "$compose_file" \
    --env-file "$env_file" \
    "$@"
}

validate_compose() {
  local compose_file
  local env_file
  compose_file="$(<"$TEMP_DIR/compose-path")"
  env_file="$(<"$TEMP_DIR/env-path")"
  print_info "校验 Compose 配置..."
  compose "$compose_file" "$env_file" config --quiet
}

acquire_lock() {
  [[ "$DRY_RUN" -eq 1 ]] && return
  run_as_root mkdir -p "$INSTALL_DIR"
  local lock_path="$INSTALL_DIR/.nexus-terminal-install.lock"
  if run_as_root mkdir "$lock_path" 2>/dev/null; then
    LOCK_DIR="$lock_path"
    LOCK_ACQUIRED=1
  else
    local existing_pid=""
    existing_pid="$(run_as_root cat "$lock_path/pid" 2>/dev/null || true)"
    if [[ "$existing_pid" =~ ^[0-9]+$ ]] && run_as_root kill -0 "$existing_pid" 2>/dev/null; then
      die "检测到另一个安装/更新任务正在执行: $lock_path"
    fi
    print_warn "发现过期的安装锁，正在清理。"
    run_as_root rm -rf "$lock_path"
    run_as_root mkdir "$lock_path"
    LOCK_DIR="$lock_path"
    LOCK_ACQUIRED=1
  fi
  printf '%s\n' "$$" | run_as_root tee "$LOCK_DIR/pid" >/dev/null
}

backup_current_files() {
  local backup_dir="$1"
  [[ "$DRY_RUN" -eq 1 ]] && return
  if run_as_root test -f "$INSTALL_DIR/docker-compose.yml" || run_as_root test -f "$INSTALL_DIR/.env"; then
    run_as_root mkdir -p "$backup_dir"
    run_as_root test -f "$INSTALL_DIR/docker-compose.yml" && run_as_root cp -p "$INSTALL_DIR/docker-compose.yml" "$backup_dir/docker-compose.yml"
    run_as_root test -f "$INSTALL_DIR/.env" && run_as_root cp -p "$INSTALL_DIR/.env" "$backup_dir/.env"
    print_info "已备份当前部署文件: $backup_dir"
  fi
}

install_files() {
  local compose_file
  local env_file
  local backup_dir="$INSTALL_DIR/.nexus-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  compose_file="$(<"$TEMP_DIR/compose-path")"
  env_file="$(<"$TEMP_DIR/env-path")"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    print_info "干跑模式：不会修改 $INSTALL_DIR。"
    return
  fi

  run_as_root mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/data" "$INSTALL_DIR/.nexus-backups"
  backup_current_files "$backup_dir"
  run_as_root install -m 0644 "$compose_file" "$INSTALL_DIR/docker-compose.yml"
  run_as_root install -m 0600 "$env_file" "$INSTALL_DIR/.env"
  run_as_root chmod 0700 "$INSTALL_DIR/data"
}

start_services() {
  local compose_file="$INSTALL_DIR/docker-compose.yml"
  local env_file="$INSTALL_DIR/.env"
  local image_tag
  image_tag="$(<"$TEMP_DIR/image-tag")"

  [[ "$DRY_RUN" -eq 1 ]] && return
  print_info "拉取镜像标签: ${image_tag}"
  compose "$compose_file" "$env_file" pull
  print_info "启动或平滑更新容器..."
  compose "$compose_file" "$env_file" up -d --remove-orphans
}

wait_for_frontend() {
  [[ "$DRY_RUN" -eq 1 ]] && return
  local url="http://127.0.0.1:${DEFAULT_PORT}/"
  local attempt
  for attempt in {1..12}; do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null 2>&1; then
      print_ok "Nexus Terminal 已启动: ${url}"
      return
    fi
    sleep 2
  done
  print_warn "容器已经启动，但暂时无法通过 ${url} 访问。请执行以下命令查看日志："
  printf '  cd %q && docker compose logs --tail=100\n' "$INSTALL_DIR"
  return 1
}

print_summary() {
  local image_tag
  image_tag="$(<"$TEMP_DIR/image-tag")"
  print_ok "安装/更新完成。"
  print_info "目录: $INSTALL_DIR"
  print_info "镜像标签: $image_tag"
  print_info "数据目录: $INSTALL_DIR/data（已保留，不会被更新覆盖）"
  print_info "访问地址: http://<服务器IP>:${DEFAULT_PORT}"
  print_info "后续再次执行同一条 curl 命令即可更新镜像。"
}

main() {
  parse_args "$@"
  validate_args
  prepare_privileges
  prepare_dependencies
  prompt_for_install_options
  validate_args
  acquire_lock
  prepare_temp_files
  validate_compose
  install_files
  start_services
  wait_for_frontend
  print_summary
}

main "$@"
