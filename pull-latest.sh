#!/bin/bash

# QQBot 拉取最新源码并更新
# 从 GitHub 拉取最新代码，重新安装插件并重启
# 兼容 clawdbot / openclaw / moltbot，macOS 开箱即用
# 脚本可放在任意位置运行，会自动定位已安装的插件目录
#
# 用法:
#   pull-latest.sh                          # 从 GitHub 拉取最新代码并更新
#   pull-latest.sh --branch main            # 指定分支（默认 main）
#   pull-latest.sh --force                  # 跳过交互，强制更新
#   pull-latest.sh --repo https://github.com/sliverp/qqbot.git

set -euo pipefail

# ============================================================
# 常量
# ============================================================
readonly DEFAULT_REPO="https://github.com/sliverp/qqbot.git"
readonly GATEWAY_PORT=18789
readonly SUPPORTED_CLIS=(openclaw clawdbot moltbot)

# ============================================================
# 参数解析
# ============================================================
FORCE=false
BRANCH="main"
REPO_URL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -f|--force) FORCE=true; shift ;;
        -b|--branch) BRANCH="$2"; shift 2 ;;
        --repo) REPO_URL="$2"; shift 2 ;;
        -h|--help)
            echo "QQBot 拉取最新源码并更新"
            echo ""
            echo "用法:"
            echo "  pull-latest.sh                          # 拉取最新代码并更新"
            echo "  pull-latest.sh --branch main            # 指定分支（默认 main）"
            echo "  pull-latest.sh --force                  # 跳过交互，强制更新"
            echo "  pull-latest.sh --repo <git-url>         # 指定仓库地址"
            exit 0
            ;;
        *)
            echo "未知选项: $1 (使用 --help 查看帮助)"
            exit 1
            ;;
    esac
done
REPO_URL="${REPO_URL:-$DEFAULT_REPO}"

# ============================================================
# 工具函数
# ============================================================
info()  { echo "ℹ️  $*"; }
ok()    { echo "✅ $*"; }
warn()  { echo "⚠️  $*"; }
fail()  { echo "❌ $*" >&2; exit 1; }

check_cmd() {
    command -v "$1" &>/dev/null || fail "缺少必要命令: $1 — $2"
}

# 从 JSON 文件提取值（避免依赖 jq）
json_get() {
    local file="$1" expr="$2"
    node -e "process.stdout.write(String((function(){$expr})(JSON.parse(require('fs').readFileSync('$file','utf8')))||''))" 2>/dev/null || true
}

# ============================================================
# 前置检查
# ============================================================
check_cmd node "请安装 Node.js: https://nodejs.org/"
check_cmd npm  "npm 通常随 Node.js 一起安装"
check_cmd git  "请安装 Git: https://git-scm.com/"

echo "========================================="
echo "  QQBot 拉取最新源码并更新"
echo "========================================="
echo ""
echo "系统信息:"
echo "  macOS $(sw_vers -productVersion 2>/dev/null || echo '未知')"
echo "  Node  $(node -v)"
echo "  npm   $(npm -v)"
echo "  Git   $(git --version 2>/dev/null | awk '{print $3}')"
echo "  仓库  $REPO_URL"
echo "  分支  $BRANCH"

# ============================================================
# 检测 CLI 命令
# ============================================================
CMD=""
for name in "${SUPPORTED_CLIS[@]}"; do
    if command -v "$name" &>/dev/null; then
        CMD="$name"
        break
    fi
done
[ -z "$CMD" ] && fail "未找到 openclaw / clawdbot / moltbot 命令，请先安装其中之一"
echo "  CLI   $CMD ($($CMD --version 2>/dev/null || echo '未知版本'))"

# 推导配置目录
APP_HOME="$HOME/.$CMD"
APP_CONFIG="$APP_HOME/$CMD.json"

# ============================================================
# 定位插件目录（自动搜索，不依赖脚本自身位置）
# ============================================================
PROJ_DIR=""
FRESH_INSTALL=false

for app in "${SUPPORTED_CLIS[@]}"; do
    ext_dir="$HOME/.$app/extensions/qqbot"
    if [ -d "$ext_dir" ] && [ -f "$ext_dir/package.json" ]; then
        PROJ_DIR="$ext_dir"
        break
    fi
done

if [ -z "$PROJ_DIR" ]; then
    PROJ_DIR="$APP_HOME/extensions/qqbot"
    FRESH_INSTALL=true
    info "未找到已安装插件，将作为首次安装: $PROJ_DIR"
else
    echo "  插件目录: $PROJ_DIR"
fi

# ============================================================
# [1/5] 获取当前本地版本
# ============================================================
echo ""
LOCAL_VER=""
LOCAL_COMMIT=""
if [ "$FRESH_INSTALL" = true ]; then
    info "[1/5] 首次安装，无本地版本"
else
    [ -f "$PROJ_DIR/package.json" ] && LOCAL_VER=$(json_get "$PROJ_DIR/package.json" "c => c.version")
    if [ -d "$PROJ_DIR/.git" ]; then
        LOCAL_COMMIT=$(cd "$PROJ_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "")
    fi
    info "[1/5] 当前本地版本: ${LOCAL_VER:-未知}${LOCAL_COMMIT:+ (${LOCAL_COMMIT})}"
fi

# ============================================================
# [2/5] 拉取最新代码
# ============================================================
echo ""
info "[2/5] 拉取最新代码..."

TMP_DIR="${TMPDIR:-/tmp}/qqbot-update-$$"
cleanup() { rm -rf "$TMP_DIR" 2>/dev/null; }
trap cleanup EXIT INT TERM

if [ -d "$PROJ_DIR/.git" ] && [ "$FRESH_INSTALL" = false ]; then
    # 已有 git 仓库 → git pull
    cd "$PROJ_DIR"

    # 检查是否有本地修改
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
        if [ "$FORCE" = true ]; then
            warn "检测到本地修改，--force 已指定，将自动暂存（git stash）后继续..."
            git stash push -m "pull-latest auto-stash $(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
            git clean -fd 2>/dev/null
        else
            warn "检测到本地修改:"
            git --no-pager diff --stat 2>/dev/null
            echo ""
            echo "更新前会将本地修改暂存（git stash），更新后可通过 git stash pop 恢复。"
            printf "是否继续更新? (Y/n): "
            read -r discard_choice </dev/tty 2>/dev/null || discard_choice="Y"
            case "$discard_choice" in
                [Nn]* )
                    echo "已取消更新。"
                    exit 0
                    ;;
                * )
                    git stash push -m "pull-latest auto-stash $(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
                    git clean -fd 2>/dev/null
                    ok "本地修改已暂存，可通过 git stash pop 恢复"
                    ;;
            esac
        fi
    fi

    echo "  切换到分支 $BRANCH..."
    git fetch --all --prune 2>&1 | tail -3
    git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH" 2>/dev/null || true
    git reset --hard "origin/$BRANCH" 2>/dev/null

    REMOTE_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
    NEW_VER=$(json_get "$PROJ_DIR/package.json" "c => c.version")

    if [ -n "$LOCAL_COMMIT" ] && [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ]; then
        ok "已是最新 ($LOCAL_VER, commit: $LOCAL_COMMIT)"
        if [ "$FORCE" != true ]; then
            printf "是否强制重新安装? (y/N): "
            read -r force_choice </dev/tty 2>/dev/null || force_choice="N"
            case "$force_choice" in
                [Yy]* ) info "强制重新安装..." ;;
                * ) echo "跳过更新。"; exit 0 ;;
            esac
        else
            info "--force 已指定，继续重新安装..."
        fi
    else
        echo "  更新: ${LOCAL_COMMIT:-???} → ${REMOTE_COMMIT}"
        git --no-pager log --oneline "${LOCAL_COMMIT}..HEAD" 2>/dev/null | head -10 || true
    fi
else
    # 首次安装或非 git 目录 → git clone 到临时目录再同步
    rm -rf "$TMP_DIR"
    echo "  克隆仓库..."
    if ! git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TMP_DIR" 2>&1 | tail -3; then
        echo ""
        echo "❌ Git clone 失败"
        echo ""
        echo "请排查:"
        echo "  1. 检查网络: curl -I https://github.com"
        echo "  2. 检查仓库地址: $REPO_URL"
        echo "  3. 如果是私有仓库，确认已配置 SSH key 或 token"
        exit 1
    fi

    # 同步文件到插件目录（保留 .git）
    mkdir -p "$PROJ_DIR"
    rsync -a --delete \
        --exclude 'node_modules' \
        "$TMP_DIR/" "$PROJ_DIR/"

    cd "$PROJ_DIR"
    REMOTE_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
    NEW_VER=$(json_get "$PROJ_DIR/package.json" "c => c.version")
    echo "  已克隆到版本: ${NEW_VER:-未知} (${REMOTE_COMMIT})"

    cleanup
fi

NEW_VER="${NEW_VER:-未知}"
ok "代码已更新到 $NEW_VER"

# ============================================================
# [3/5] 备份通道配置
# ============================================================
echo ""
info "[3/5] 备份已有通道配置..."

SAVED_CHANNELS_JSON=""

for app in "${SUPPORTED_CLIS[@]}"; do
    cfg="$HOME/.$app/$app.json"
    [ -f "$cfg" ] || continue

    SAVED_CHANNELS_JSON=$(node -e "
        const cfg = JSON.parse(require('fs').readFileSync('$cfg', 'utf8'));
        const ch = cfg.channels && cfg.channels.qqbot;
        if (ch) process.stdout.write(JSON.stringify(ch));
    " 2>/dev/null || true)

    [ -n "$SAVED_CHANNELS_JSON" ] && break
done

if [ -n "$SAVED_CHANNELS_JSON" ]; then
    echo "  已备份 qqbot 通道配置"
else
    echo "  未找到已有通道配置（首次安装或已清理）"
fi

# ============================================================
# [4/5] 安装依赖
# ============================================================
echo ""
info "[4/5] 安装依赖..."
cd "$PROJ_DIR"
if ! npm install --omit=dev 2>&1 | tail -5; then
    echo ""
    echo "❌ npm 依赖安装失败"
    echo ""
    echo "请排查:"
    echo "  1. 手动重试: cd $PROJ_DIR && npm install --omit=dev"
    echo "  2. 清理后重试: rm -rf $PROJ_DIR/node_modules && npm install --omit=dev"
    echo "  3. 切换镜像: npm config set registry https://registry.npmmirror.com/"
    exit 1
fi

# ============================================================
# [5/5] 卸载旧插件 → 安装新插件 → 恢复配置 → 重启
# ============================================================
echo ""
info "[5/5] 重新安装插件并重启..."

# --- 5a. 临时移除 qqbot 相关配置（避免 openclaw 校验失败） ---
NEED_RESTORE_CHANNELS=false
if [ -f "$APP_CONFIG" ]; then
    echo "  临时移除 qqbot 相关配置（安装后恢复）..."
    node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
        let changed = false;
        if (cfg.channels && cfg.channels.qqbot) { delete cfg.channels.qqbot; changed = true; }
        if (cfg.plugins && cfg.plugins.entries && cfg.plugins.entries.qqbot) { delete cfg.plugins.entries.qqbot; changed = true; }
        if (cfg.plugins && cfg.plugins.installs && cfg.plugins.installs.qqbot) { delete cfg.plugins.installs.qqbot; changed = true; }
        if (changed) fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        process.stdout.write(changed ? 'yes' : 'no');
    " 2>/dev/null && NEED_RESTORE_CHANNELS=true
fi

# --- 5b. 安装插件 ---
echo ""
echo "  安装插件..."
cd "$PROJ_DIR"
if ! $CMD plugins install "$PROJ_DIR" 2>&1; then
    # 安装失败时尝试恢复配置
    if [ "$NEED_RESTORE_CHANNELS" = true ] && [ -n "$SAVED_CHANNELS_JSON" ]; then
        node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
            cfg.channels = cfg.channels || {};
            cfg.channels.qqbot = $SAVED_CHANNELS_JSON;
            fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        " 2>/dev/null && echo "  (已恢复通道配置)"
    fi
    echo ""
    echo "❌ 插件安装失败"
    echo ""
    echo "请排查:"
    echo "  1. 检查上方的错误输出"
    echo "  2. 手动重试: cd $PROJ_DIR && $CMD plugins install ."
    echo "  3. 检查 package.json: cat $PROJ_DIR/package.json"
    echo "  4. 确认 $CMD 版本兼容: $CMD --version"
    exit 1
fi
ok "插件安装成功"

# --- 5c. 恢复 channels.qqbot 配置 ---
if [ -n "$SAVED_CHANNELS_JSON" ]; then
    echo "  恢复 qqbot 通道配置..."
    if node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
        cfg.channels = cfg.channels || {};
        cfg.channels.qqbot = $SAVED_CHANNELS_JSON;
        fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
    " 2>/dev/null; then
        ok "通道配置已恢复"
    else
        echo ""
        echo "⚠️  通道配置恢复失败"
        echo ""
        echo "请手动恢复:"
        echo "  $CMD channels add --channel qqbot --token 'YOUR_APPID:YOUR_SECRET'"
        echo ""
        echo "或直接编辑配置文件: $APP_CONFIG"
    fi
fi

# --- 5d. 停止旧 gateway ---
echo ""
echo "  停止旧网关..."
$CMD gateway stop 2>/dev/null || true
sleep 1

# 强制杀占用端口的进程
PORT_PID=$(lsof -ti:"$GATEWAY_PORT" 2>/dev/null || true)
if [ -n "$PORT_PID" ]; then
    warn "端口 $GATEWAY_PORT 仍被占用 (PID: $PORT_PID)，强制终止..."
    kill -9 $PORT_PID 2>/dev/null || true
    sleep 1
fi

# 卸载 launchd 服务（防止自动拉起旧进程）
for svc in ai.openclaw.gateway ai.clawdbot.gateway ai.moltbot.gateway; do
    launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
done

# --- 5e. 启动新 gateway ---
echo "  启动网关..."
if $CMD gateway 2>&1; then
    ok "网关已启动"
else
    echo ""
    echo "⚠️  网关启动失败（不影响已安装的插件）"
    echo ""
    echo "请手动启动:"
    echo "  1. 安装服务: $CMD gateway install"
    echo "  2. 启动网关: $CMD gateway"
    echo "  3. 查看日志: $CMD logs --follow"
fi

# ============================================================
# 完成
# ============================================================
echo ""
echo "========================================="
echo "  ✅ QQBot 已更新到 ${NEW_VER}${REMOTE_COMMIT:+ (${REMOTE_COMMIT})}"
[ -n "$LOCAL_VER" ] && echo "     (从 ${LOCAL_VER}${LOCAL_COMMIT:+ (${LOCAL_COMMIT})} 升级)"
echo "========================================="
echo ""
echo "常用命令:"
echo "  $CMD logs --follow        # 跟踪日志"
echo "  $CMD gateway restart      # 重启服务"
echo "  $CMD plugins list         # 查看插件列表"
echo "  cd $PROJ_DIR && git log   # 查看更新历史"
echo "========================================="
