#!/bin/bash

# qqbot 测试脚本：自由切换不同的 QQBot npm 包
#
# 支持从任意 npm 包安装指定版本到 openclaw extensions 目录。
# 可用于在不同包之间切换测试，如 @sliverp/qqbot、@tencent-connect/openclaw-qqbot 等。
#
# 用法:
#   upgrade-via-alt-pkg.sh --pkg <包名> --version <version>   # 指定包+版本
#   upgrade-via-alt-pkg.sh --pkg <包名>                        # 指定包，安装 latest
#   upgrade-via-alt-pkg.sh --appid <appid> --secret <secret>   # 首次安装时配置
#   upgrade-via-alt-pkg.sh --no-restart                        # 只做文件替换，不重启
#
# 示例:
#   bash scripts/upgrade-via-alt-pkg.sh --pkg @sliverp/qqbot --version 1.5.1
#   bash scripts/upgrade-via-alt-pkg.sh --pkg @sliverp/qqbot --version 1.5.4
#   bash scripts/upgrade-via-alt-pkg.sh --pkg @tencent-connect/openclaw-qqbot --version 1.6.4
#   bash scripts/upgrade-via-alt-pkg.sh --pkg @sliverp/qqbot
#   bash scripts/upgrade-via-alt-pkg.sh --pkg @sliverp/qqbot --version 1.5.4 --appid 12345 --secret abc123

set -eo pipefail

PKG_NAME=""
VERSION=""
INSTALL_SRC=""
APPID=""
SECRET=""
NO_RESTART=false

print_usage() {
    echo "用法:"
    echo "  upgrade-via-alt-pkg.sh --pkg <包名> --version <版本号>"
    echo "  upgrade-via-alt-pkg.sh --pkg <包名>                      # 安装 latest"
    echo ""
    echo "选项:"
    echo "  --pkg <name>          npm 包名（必填，如 @sliverp/qqbot、@tencent-connect/openclaw-qqbot）"
    echo "  --version <version>   指定版本号（如 1.5.1, 1.5.4, 1.6.4）"
    echo "  --appid <appid>       QQ机器人 appid（首次安装时必填）"
    echo "  --secret <secret>     QQ机器人 secret（首次安装时必填）"
    echo "  --no-restart          只做文件替换，不重启 gateway"
    echo "  -h, --help            显示帮助信息"
    echo ""
    echo "环境变量:"
    echo "  QQBOT_APPID           QQ机器人 appid"
    echo "  QQBOT_SECRET          QQ机器人 secret"
    echo "  QQBOT_TOKEN           QQ机器人 token (appid:secret)"
    echo ""
    echo "示例:"
    echo "  # 从 @sliverp/qqbot 包安装 v1.5.1"
    echo "  bash scripts/upgrade-via-alt-pkg.sh --pkg @sliverp/qqbot --version 1.5.1"
    echo ""
    echo "  # 从 @sliverp/qqbot 包安装 v1.5.4"
    echo "  bash scripts/upgrade-via-alt-pkg.sh --pkg @sliverp/qqbot --version 1.5.4"
    echo ""
    echo "  # 从官方包安装 v1.6.4"
    echo "  bash scripts/upgrade-via-alt-pkg.sh --pkg @tencent-connect/openclaw-qqbot --version 1.6.4"
    echo ""
    echo "  # 切回 @sliverp/qqbot 包的 latest"
    echo "  bash scripts/upgrade-via-alt-pkg.sh --pkg @sliverp/qqbot"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pkg|--package)
            [ -z "$2" ] && echo "❌ --pkg 需要参数" && exit 1
            PKG_NAME="$2"
            shift 2
            ;;
        --version)
            [ -z "$2" ] && echo "❌ --version 需要参数" && exit 1
            VERSION="$2"
            shift 2
            ;;
        --tag)
            [ -z "$2" ] && echo "❌ --tag 需要参数" && exit 1
            VERSION="$2"
            shift 2
            ;;
        --appid)
            [ -z "$2" ] && echo "❌ --appid 需要参数" && exit 1
            APPID="$2"
            shift 2
            ;;
        --secret)
            [ -z "$2" ] && echo "❌ --secret 需要参数" && exit 1
            SECRET="$2"
            shift 2
            ;;
        --no-restart)
            NO_RESTART=true
            shift 1
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *) echo "未知选项: $1"; print_usage; exit 1 ;;
    esac
done

# --pkg 必填
if [ -z "$PKG_NAME" ]; then
    echo "❌ 必须指定 --pkg 参数"
    echo ""
    print_usage
    exit 1
fi

if [ -n "$VERSION" ]; then
    INSTALL_SRC="${PKG_NAME}@${VERSION}"
else
    INSTALL_SRC="${PKG_NAME}@latest"
fi

# 环境变量 fallback
APPID="${APPID:-$QQBOT_APPID}"
SECRET="${SECRET:-$QQBOT_SECRET}"
if [ -z "$APPID" ] && [ -z "$SECRET" ] && [ -n "$QQBOT_TOKEN" ]; then
    APPID="${QQBOT_TOKEN%%:*}"
    SECRET="${QQBOT_TOKEN#*:}"
fi

# 检测 CLI（仅用于确定 extensions 目录路径）
CMD=""
for name in openclaw clawdbot moltbot; do
    command -v "$name" &>/dev/null && CMD="$name" && break
done
[ -z "$CMD" ] && echo "❌ 未找到 openclaw / clawdbot / moltbot" && exit 1

EXTENSIONS_DIR="$HOME/.$CMD/extensions"

echo "==========================================="
echo "  qqbot 测试升级: $INSTALL_SRC"
echo "==========================================="
echo ""

# [1/3] 下载并安装新版本到临时目录
echo "[1/3] 下载新版本..."
TMPDIR_PACK=$(mktemp -d)
EXTRACT_DIR=$(mktemp -d)
trap "rm -rf '$TMPDIR_PACK' '$EXTRACT_DIR'" EXIT

cd "$TMPDIR_PACK"
# 多 registry fallback：npmjs.org → npmmirror（国内镜像）→ 默认 registry
PACK_OK=false
for _registry in "https://registry.npmjs.org/" "https://registry.npmmirror.com/" ""; do
    if [ -n "$_registry" ]; then
        echo "  尝试 registry: $_registry"
        npm pack "$INSTALL_SRC" --registry "$_registry" --quiet 2>&1 && PACK_OK=true && break
    else
        echo "  尝试默认 registry..."
        npm pack "$INSTALL_SRC" --quiet 2>&1 && PACK_OK=true && break
    fi
done
$PACK_OK || { echo "❌ npm pack 失败（所有 registry 均不可用）"; exit 1; }
TGZ_FILE=$(ls -1 *.tgz 2>/dev/null | head -1)
[ -z "$TGZ_FILE" ] && echo "❌ 未找到下载的 tgz 文件" && exit 1
echo "  已下载: $TGZ_FILE"

tar xzf "$TGZ_FILE" -C "$EXTRACT_DIR"
PACKAGE_DIR="$EXTRACT_DIR/package"
[ ! -d "$PACKAGE_DIR" ] && echo "❌ 解压失败，未找到 package 目录" && exit 1

# 准备 staging 目录
STAGING_DIR="$(dirname "$EXTENSIONS_DIR")/.qqbot-upgrade-staging"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$PACKAGE_DIR/." "$STAGING_DIR/"

# 依赖处理
if [ -d "$STAGING_DIR/node_modules" ]; then
    BUNDLED_COUNT=$(find "$STAGING_DIR/node_modules" -mindepth 1 -maxdepth 2 -type d | wc -l | tr -d ' ')
    echo "  bundled 依赖已就绪（${BUNDLED_COUNT} 个包）"
else
    echo "  ⚠️  未找到 bundled node_modules，尝试安装依赖..."
    NPM_TMP_CACHE=$(mktemp -d)
    (cd "$STAGING_DIR" && npm install --omit=dev --omit=peer --ignore-scripts --cache="$NPM_TMP_CACHE" --quiet 2>&1) || echo "  ⚠️  依赖安装失败"
    rm -rf "$NPM_TMP_CACHE"
fi

# 清理下载临时文件
rm -rf "$TMPDIR_PACK" "$EXTRACT_DIR"
cd "$HOME"

# [2/3] 原子替换插件目录
echo ""
echo "[2/3] 原子替换插件目录..."
TARGET_DIR="$EXTENSIONS_DIR/openclaw-qqbot"
OLD_DIR="$(dirname "$EXTENSIONS_DIR")/.qqbot-upgrade-old"

rm -rf "$OLD_DIR"

STAGING_IN_EXT="$EXTENSIONS_DIR/.openclaw-qqbot-new"
rm -rf "$STAGING_IN_EXT"
mv "$STAGING_DIR" "$STAGING_IN_EXT"

if [ -d "$TARGET_DIR" ]; then
    mv "$TARGET_DIR" "$OLD_DIR" && mv "$STAGING_IN_EXT" "$TARGET_DIR"
else
    mv "$STAGING_IN_EXT" "$TARGET_DIR"
fi
rm -rf "$OLD_DIR"

# 清理可能残留的旧版 staging 目录
rm -rf "$EXTENSIONS_DIR/openclaw-qqbot.staging"
rm -rf "$EXTENSIONS_DIR/.qqbot-upgrade-staging"
rm -rf "$EXTENSIONS_DIR/.qqbot-upgrade-old"

# 清理历史遗留的其他目录名
for dir_name in qqbot openclaw-qq; do
    [ -d "$EXTENSIONS_DIR/$dir_name" ] && rm -rf "$EXTENSIONS_DIR/$dir_name"
done
echo "  已安装到: $TARGET_DIR"

# [3/3] 输出新版本号和升级报告
echo ""
echo "[3/3] 验证安装..."
NEW_VERSION="$(node -e "
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join('$EXTENSIONS_DIR', 'openclaw-qqbot', 'package.json');
    if (fs.existsSync(p)) {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (v) { process.stdout.write(v); process.exit(0); }
    }
  } catch {}
" 2>/dev/null || true)"
echo "QQBOT_NEW_VERSION=${NEW_VERSION:-unknown}"

if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
    echo "QQBOT_REPORT=✅ QQBot 升级完成 ($PKG_NAME): v${NEW_VERSION}"
else
    echo "QQBOT_REPORT=⚠️ QQBot 升级异常，无法确认新版本"
fi

echo ""
echo "==========================================="
echo "  ✅ 文件安装完成"
echo "==========================================="

# --no-restart 模式
if [ "$NO_RESTART" = "true" ]; then
    echo ""
    echo "[跳过重启] --no-restart 已指定，脚本立即退出以便调用方触发 gateway restart"
    exit 0
fi

# [4/4] 配置 appid/secret（仅在提供了参数时执行）
if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    echo ""
    echo "[配置] 写入 qqbot 通道配置..."
    DESIRED_TOKEN="${APPID}:${SECRET}"

    CURRENT_TOKEN=""
    for _app in openclaw clawdbot moltbot; do
        _cfg="$HOME/.$_app/$_app.json"
        if [ -f "$_cfg" ]; then
            CURRENT_TOKEN=$(node -e "
                const cfg = JSON.parse(require('fs').readFileSync('$_cfg', 'utf8'));
                const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
                for (const key of keys) {
                    const ch = cfg.channels && cfg.channels[key];
                    if (!ch) continue;
                    if (ch.token) { process.stdout.write(ch.token); process.exit(0); }
                    if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); process.exit(0); }
                }
            " 2>/dev/null || true)
            [ -n "$CURRENT_TOKEN" ] && break
        fi
    done

    if [ "$CURRENT_TOKEN" = "$DESIRED_TOKEN" ]; then
        echo "  ✅ 当前配置已是目标值，跳过写入"
    elif $CMD channels add --channel qqbot --token "$DESIRED_TOKEN" 2>&1; then
        echo "  ✅ 通道配置写入成功"
    else
        echo "  ⚠️  $CMD channels add 失败，尝试直接编辑配置文件..."
        CONFIG_FILE="$HOME/.$CMD/$CMD.json"
        if [ -f "$CONFIG_FILE" ] && node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
            if (!cfg.channels) cfg.channels = {};
            if (!cfg.channels.qqbot) cfg.channels.qqbot = {};
            cfg.channels.qqbot.appId = '$APPID';
            cfg.channels.qqbot.clientSecret = '$SECRET';
            fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 4) + '\n');
        " 2>&1; then
            echo "  ✅ 通道配置写入成功（直接编辑配置文件）"
        else
            echo "  ❌ 配置写入失败，请手动配置:"
            echo "     $CMD channels add --channel qqbot --token \"${APPID}:${SECRET}\""
        fi
    fi
elif [ -n "$APPID" ] || [ -n "$SECRET" ]; then
    echo ""
    echo "⚠️  --appid 和 --secret 必须同时提供"
fi

# [5/5] 重启 gateway 使新版本生效
echo ""
echo "[重启] 重启 gateway 使新版本生效..."
if $CMD gateway restart 2>&1; then
    echo "  ✅ gateway 已重启"
else
    echo "  ⚠️  gateway 重启失败，请手动执行: $CMD gateway restart"
fi
