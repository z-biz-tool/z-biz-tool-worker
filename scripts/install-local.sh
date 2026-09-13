#!/usr/bin/env bash
#
# scripts/install-local.sh
# ------------------------------------------------------------------------------
# 本地构建 + 静默安装到当前机器(以 macOS 为目标)。
#
# 流程:
#   1. (可选) 执行 npm run tauri build, 生成 .app
#   2. 杀掉正在运行的进程 (App 本身 + agent-proxy 子进程)
#   3. 把新 .app 复制到 /Applications, 覆盖旧版本
#   4. 重新打开新应用
#
# 用法:
#   bash scripts/install-local.sh                 # 构建 + 安装
#   bash scripts/install-local.sh --skip-build    # 跳过构建, 仅安装 (用已有的 bundle)
#   bash scripts/install-local.sh --no-launch     # 安装后不自动启动
#   bash scripts/install-local.sh --help
#
# 前置条件:
#   - macOS (用 codesign + xcrun)
#   - 在项目根目录执行
# ------------------------------------------------------------------------------

set -euo pipefail

PROJECT_NAME="$(basename "$(pwd)")"

# ---------- 颜色 ----------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

info()  { printf "${C_BLUE}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*"; }
ok()    { printf "${C_GREEN}✓ %s${C_RESET}\n" "$*"; }
warn()  { printf "${C_YELLOW}! %s${C_RESET}\n" "$*"; }
err()   { printf "${C_RED}✗ %s${C_RESET}\n" "$*" >&2; }

# ---------- 参数 ----------
SKIP_BUILD=0
NO_LAUNCH=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --no-launch)  NO_LAUNCH=1 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *) err "未知参数: $arg"; exit 2 ;;
  esac
done

# ---------- 平台守卫 ----------
if [ "$(uname -s)" != "Darwin" ]; then
  err "此脚本目前仅支持 macOS (当前平台: $(uname -s))"
  exit 1
fi

# ---------- 读项目元数据 ----------
TAURI_CONF="src-tauri/tauri.conf.json"
CARGO_TOML="src-tauri/Cargo.toml"

if [ ! -f "$TAURI_CONF" ]; then
  err "找不到 $TAURI_CONF, 请在项目根目录运行此脚本"
  exit 1
fi

# 从 tauri.conf.json 提取 productName 和 identifier
PRODUCT_NAME="$(python3 -c "
import json
with open('$TAURI_CONF') as f:
    print(json.load(f)['productName'])
")"
BUNDLE_ID="$(python3 -c "
import json
with open('$TAURI_CONF') as f:
    print(json.load(f)['identifier'])
")"
VERSION="$(python3 -c "
import json
with open('$TAURI_CONF') as f:
    print(json.load(f)['version'])
")"

APP_BUNDLE="${PRODUCT_NAME}.app"
INSTALL_DIR="/Applications"
TARGET_PATH="${INSTALL_DIR}/${APP_BUNDLE}"
BUNDLE_SRC_DIR="src-tauri/target/release/bundle/macos"

info "项目: ${C_BOLD}${PROJECT_NAME}${C_RESET}"
info "应用: ${C_BOLD}${PRODUCT_NAME}${C_RESET} v${VERSION}"
info "Bundle ID: ${BUNDLE_ID}"

# ---------- 步骤 1: 构建 ----------
if [ $SKIP_BUILD -eq 0 ]; then
  info "[1/4] 执行 tauri build (release)..."
  if ! command -v npm >/dev/null 2>&1; then
    err "需要 npm"
    exit 1
  fi
  npm run tauri build -- --bundles app
  ok "构建完成"
else
  info "[1/4] 跳过构建 (--skip-build)"
fi

# ---------- 步骤 2: 定位 bundle ----------
info "[2/4] 定位打包产物..."
BUILT_APP="${BUNDLE_SRC_DIR}/${APP_BUNDLE}"
if [ ! -d "$BUILT_APP" ]; then
  err "找不到构建产物: $BUILT_APP"
  err "请先执行构建, 或检查 tauri.conf.json 中的 productName"
  exit 1
fi
ok "找到: $BUILT_APP"

# ---------- 步骤 3: 杀掉运行中的实例 ----------
info "[3/4] 杀掉运行中的实例..."

kill_pattern() {
  local pattern="$1"
  # pgrep -f 匹配完整命令行, 找不到时返回非零 (正常情况, 我们吞掉)
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    warn "发现运行中的进程 (匹配 \"$pattern\"): $pids"
    # 先 SIGTERM 优雅退出
    kill $pids 2>/dev/null || true
    sleep 1
    # 还活着的 SIGKILL 强杀
    local still_alive
    still_alive="$(pgrep -f "$pattern" 2>/dev/null || true)"
    if [ -n "$still_alive" ]; then
      warn "仍在运行, 强杀: $still_alive"
      kill -9 $still_alive 2>/dev/null || true
    fi
    ok "已结束: $pattern"
  fi
}

# 主进程: 通过 bundle id 找 (Launch Services 路径)
kill_pattern "${BUNDLE_ID}"
# 兜底: 通过可执行文件名
EXE_NAME="$(basename "$PRODUCT_NAME" | tr ' ' '-')"
kill_pattern "/${EXE_NAME}"
# agent-proxy 子进程 (本项目特有, 其他项目没也无害)
if [ -d "agent-proxy" ]; then
  kill_pattern "agent-proxy/dist/index.js"
fi

# 等待文件系统释放句柄
sleep 1

# ---------- 步骤 4: 替换安装 ----------
info "[4/4] 安装到 ${INSTALL_DIR}..."

# 探测 /Applications 是否可写, 否则升级到 sudo
INSTALL_CMD=""
if [ -w "$INSTALL_DIR" ]; then
  INSTALL_CMD=""
  warn_run() { "$@"; }
else
  warn "当前用户无 ${INSTALL_DIR} 写权限, 需要 sudo"
  INSTALL_CMD="sudo"
  warn_run() { sudo "$@"; }
fi

if [ -d "$TARGET_PATH" ]; then
  warn "已存在旧版本: $TARGET_PATH"
  warn_run rm -rf "$TARGET_PATH"
fi
# 用 ditto 保留扩展属性 (macOS 推荐方式, 比 cp -R 更稳)
warn_run ditto "$BUILT_APP" "$TARGET_PATH"
ok "已安装: $TARGET_PATH"

# 清掉隔离属性 (避免 Gatekeeper 弹窗)
warn_run xattr -dr com.apple.quarantine "$TARGET_PATH" 2>/dev/null || true

# ---------- 启动 ----------
if [ $NO_LAUNCH -eq 0 ]; then
  info "启动应用..."
  open "$TARGET_PATH"
  ok "已启动"
else
  info "已跳过启动 (--no-launch)"
fi

ok "🎉 安装完成!"
echo
echo "  应用路径: ${C_BOLD}${TARGET_PATH}${C_RESET}"
echo "  Bundle ID: ${BUNDLE_ID}"
echo "  版本: ${VERSION}"
echo