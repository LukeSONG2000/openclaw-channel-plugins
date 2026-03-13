#!/bin/bash

# qqbot 一键更新并启动脚本
# 版本: 2.0 (增强错误处理版)
#
# 主要改进:
# 1. 详细的安装错误诊断和排查建议
# 2. 所有关键步骤的错误捕获和报告
# 3. 日志文件保存和错误摘要
# 4. 智能故障排查指南
# 5. 用户友好的交互提示

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 如果脚本在 scripts/ 子目录里，往上一级就是项目根目录
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    PROJ_DIR="$SCRIPT_DIR"
fi
cd "$PROJ_DIR"

# 解析命令行参数
APPID=""
SECRET=""
MARKDOWN=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --appid)
            APPID="$2"
            shift 2
            ;;
        --secret)
            SECRET="$2"
            shift 2
            ;;
        --markdown)
            MARKDOWN="$2"
            shift 2
            ;;
        -h|--help)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  --appid <appid>       QQ机器人 appid"
            echo "  --secret <secret>     QQ机器人 secret"
            echo "  --markdown <yes|no>   是否启用 markdown 消息格式（默认: no）"
            echo "  -h, --help            显示帮助信息"
            echo ""
            echo "也可以通过环境变量设置:"
            echo "  QQBOT_APPID           QQ机器人 appid"
            echo "  QQBOT_SECRET          QQ机器人 secret"
            echo "  QQBOT_TOKEN           QQ机器人 token (appid:secret)"
            echo "  QQBOT_MARKDOWN        是否启用 markdown（yes/no）"
            echo ""
            echo "不带参数时，将使用已有配置直接启动。"
            echo ""
            echo "⚠️  注意: 启用 markdown 需要在 QQ 开放平台申请 markdown 消息权限"
            exit 0
            ;;
        *)
            echo "未知选项: $1"
            echo "使用 --help 查看帮助信息"
            exit 1
            ;;
    esac
done

# 使用命令行参数或环境变量
APPID="${APPID:-$QQBOT_APPID}"
SECRET="${SECRET:-$QQBOT_SECRET}"
MARKDOWN="${MARKDOWN:-$QQBOT_MARKDOWN}"

echo "========================================="
echo "  qqbot 一键更新启动脚本"
echo "========================================="

# 1. 备份已有 qqbot 通道配置，防止升级过程丢失
echo ""
echo "[1/6] 备份已有配置..."
SAVED_QQBOT_TOKEN=""
for APP_NAME in openclaw clawdbot moltbot; do
    CONFIG_FILE="$HOME/.$APP_NAME/$APP_NAME.json"
    if [ -f "$CONFIG_FILE" ]; then
        SAVED_QQBOT_TOKEN=$(node -e "
            const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
            // 尝试所有可能的 channel key（原仓库 + 本仓库）
            const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
            for (const key of keys) {
                const ch = cfg.channels && cfg.channels[key];
                if (!ch) continue;
                if (ch.token) { process.stdout.write(ch.token); process.exit(0); }
                if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); process.exit(0); }
            }
        " 2>/dev/null || true)
        if [ -n "$SAVED_QQBOT_TOKEN" ]; then
            echo "已备份 qqbot 通道 token: ${SAVED_QQBOT_TOKEN:0:10}..."
            break
        fi
    fi
done

# 若当前配置中没有，再尝试从 openclaw 备份文件恢复
if [ -z "$SAVED_QQBOT_TOKEN" ] && [ -d "$HOME/.openclaw" ]; then
    SAVED_QQBOT_TOKEN=$(node -e "
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(process.env.HOME, '.openclaw');
      const files = fs.readdirSync(dir)
        .filter((n) => /^openclaw\.json\.bak(\.\d+)?$/.test(n))
        .map((n) => path.join(dir, n))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      for (const f of files) {
        try {
          const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
          const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
          for (const key of keys) {
            const ch = cfg.channels && cfg.channels[key];
            if (!ch) continue;
            if (ch.token) { process.stdout.write(ch.token); process.exit(0); }
            if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); process.exit(0); }
          }
        } catch {}
      }
    " 2>/dev/null || true)

    if [ -n "$SAVED_QQBOT_TOKEN" ]; then
        echo "已从 ~/.openclaw/openclaw.json.bak* 找到 qqbot 备份 token: ${SAVED_QQBOT_TOKEN:0:10}..."
    fi
fi

# 2. 移除老版本
echo ""
echo "[2/6] 移除老版本..."
if [ -f "$PROJ_DIR/scripts/cleanup-legacy-plugins.sh" ]; then
    bash "$PROJ_DIR/scripts/cleanup-legacy-plugins.sh"
else
    echo "警告: cleanup-legacy-plugins.sh 不存在，跳过移除步骤"
fi

# 3. 安装当前版本
echo ""
echo "[3/6] 安装当前版本（源码安装）..."

echo "检查当前目录: $(pwd)"
echo "检查openclaw版本: $(openclaw --version 2>/dev/null || echo 'openclaw not found')"

LOCAL_PACKAGE_VERSION=$(node -e "
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join('$PROJ_DIR', 'package.json');
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    if (v) process.stdout.write(String(v));
  } catch {}
" 2>/dev/null || true)
if [ -n "$LOCAL_PACKAGE_VERSION" ]; then
    echo "即将安装本地源码版本: $LOCAL_PACKAGE_VERSION"
else
    echo "即将安装本地源码版本: unknown（未读取到 package.json version）"
fi

# 记录更新前的 qqbot 插件版本
OLD_QQBOT_VERSION=$(node -e '
    try {
        const fs = require("fs");
        const path = require("path");
        const candidates = ["openclaw-qqbot", "qqbot", "openclaw-qq"];
        for (const name of candidates) {
            const pkgPath = path.join(process.env.HOME, ".openclaw", "extensions", name, "package.json");
            if (!fs.existsSync(pkgPath)) continue;
            const p = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
            process.stdout.write(p.version || "unknown");
            process.exit(0);
        }
        process.stdout.write("not_installed");
    } catch(e) { process.stdout.write("not_installed"); }
' 2>/dev/null || echo "not_installed")

echo "开始安装插件..."
echo "安装来源: 当前仓库源码（openclaw plugins install .）"
INSTALL_LOG="/tmp/openclaw-install-$(date +%s).log"

echo "安装日志文件: $INSTALL_LOG"
echo "详细信息将记录到日志文件中..."

# 尝试安装并捕获详细输出
if ! openclaw plugins install . 2>&1 | tee "$INSTALL_LOG"; then
    echo ""
    echo "❌ 插件安装失败！"
    echo "========================================="
    echo "故障排查信息:"
    echo "========================================="
    
    # 分析错误原因
    echo "1. 检查日志文件末尾: $INSTALL_LOG"
    echo "2. 常见原因分析:"
    
    # 检查网络连接
    echo "   - 网络问题: 测试 npm 仓库连接"
    echo "     curl -I https://registry.npmjs.org/ || curl -I https://registry.npmmirror.com/"
    
    # 检查权限
    echo "   - 权限问题: 检查安装目录权限"
    echo "     ls -la ~/.openclaw/ 2>/dev/null || echo '目录不存在'"
    
    # 检查npm配置
    echo "   - npm配置: 检查当前npm配置"
    echo "     npm config get registry"
    
    # 显示错误摘要
    echo ""
    echo "3. 错误摘要:"
    tail -20 "$INSTALL_LOG" | grep -i -E "(error|fail|warn|npm install)"
    
    echo ""
    echo "4. 可选解决方案:"
    echo "   a. 更换npm镜像源:"
    echo "      npm config set registry https://registry.npmmirror.com/"
    echo "   b. 清理npm缓存:"
    echo "      npm cache clean --force"
    echo "   c. 手动安装依赖:"
    echo "      cd $(pwd) && npm install --verbose"
    
    echo ""
    echo "========================================="
    echo "建议: 先查看完整日志文件: cat $INSTALL_LOG"
    echo "或者尝试手动安装: cd $(pwd) && npm install"
    echo "========================================="
    
    read -t 10 -p "是否继续配置其他步骤? (y/N): " continue_choice || continue_choice="N"
    case "$continue_choice" in
        [Yy]* )
            echo "继续执行后续配置步骤..."
            ;;  
        * )
            echo "安装失败，脚本退出。"
            echo "请先解决安装问题后再运行此脚本。"
            exit 1
            ;;  
    esac
else
    echo ""
    echo "✅ 插件安装成功！"
    echo "安装日志已保存到: $INSTALL_LOG"

    # 清理多余的 peerDependencies 传递依赖（兼容旧版 openclaw）：
    # openclaw v2026.3.4 之前的 plugins install 缺少 --omit=peer，会把 peerDeps
    # （openclaw 平台及其 400+ 传递依赖）也安装到插件 node_modules 中。
    # 新版已修复，此处通过阈值判断：包数量 > 50 才触发清理，避免对新版做无用操作。
    PLUGIN_NM=""
    for _candidate in openclaw-qqbot qqbot openclaw-qq; do
        _nm="$HOME/.openclaw/extensions/$_candidate/node_modules"
        [ -d "$_nm" ] && PLUGIN_NM="$_nm" && break
    done
    if [ -n "$PLUGIN_NM" ]; then
        _before=$(ls -d "$PLUGIN_NM"/*/ "$PLUGIN_NM"/@*/*/ 2>/dev/null | wc -l | tr -d ' ')
        if [ "$_before" -gt 50 ]; then
            # 读取 bundledDependencies 列表，只保留这些包及其子依赖
            _bundled_deps=$(node -e "
              const fs = require('fs');
              const path = require('path');
              const pkgPath = path.join('$PLUGIN_NM', '..', 'package.json');
              if (!fs.existsSync(pkgPath)) process.exit(0);
              const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
              const bundled = pkg.bundledDependencies || pkg.bundleDependencies || [];
              const keep = new Set();
              const resolve = (name) => {
                if (keep.has(name)) return;
                keep.add(name);
                const depPkg = path.join('$PLUGIN_NM', name, 'package.json');
                if (!fs.existsSync(depPkg)) return;
                const dep = JSON.parse(fs.readFileSync(depPkg, 'utf8'));
                for (const d of Object.keys(dep.dependencies || {})) resolve(d);
              };
              bundled.forEach(resolve);
              const installed = fs.readdirSync('$PLUGIN_NM').filter(n => !n.startsWith('.'));
              const toRemove = [];
              for (const item of installed) {
                if (item.startsWith('@')) {
                  const scopeDir = path.join('$PLUGIN_NM', item);
                  const subs = fs.readdirSync(scopeDir);
                  const keepSubs = subs.filter(s => keep.has(item + '/' + s));
                  if (keepSubs.length === 0) toRemove.push(item);
                  else {
                    for (const s of subs) {
                      if (!keep.has(item + '/' + s)) toRemove.push(item + '/' + s);
                    }
                  }
                } else {
                  if (!keep.has(item)) toRemove.push(item);
                }
              }
              process.stdout.write(toRemove.join('\n'));
            " 2>/dev/null || true)
            if [ -n "$_bundled_deps" ]; then
                echo ""
                echo "检测到 ${_before} 个包（超过阈值 50），清理多余的 peerDep 传递依赖..."
                echo "$_bundled_deps" | while IFS= read -r _pkg; do
                    rm -rf "$PLUGIN_NM/$_pkg"
                done
                find "$PLUGIN_NM" -maxdepth 1 -type d -name '@*' -empty -delete 2>/dev/null || true
                _after=$(ls -d "$PLUGIN_NM"/*/ "$PLUGIN_NM"/@*/*/ 2>/dev/null | wc -l | tr -d ' ')
                echo "  已清理: ${_before} → ${_after} 个包"
            fi
        else
            echo "  node_modules 包数量正常（${_before} 个），无需清理"
        fi
    fi

    # plugins install 一次性写入 openclaw.json（plugins.allow/entries/installs），
    # 如果 gateway 正在运行，chokidar watcher 会检测到变化并自动 restart。
    # 如果 gateway 未运行，则无需等待（最终 Step 6 会启动）。
    echo ""
    if lsof -i :18789 -sTCP:LISTEN >/dev/null 2>&1; then
        echo "等待 gateway 自动重启完成..."
        _gw_restarted=0
        for _w in $(seq 1 20); do
            sleep 1
            if lsof -i :18789 -sTCP:LISTEN >/dev/null 2>&1; then
                sleep 2
                if lsof -i :18789 -sTCP:LISTEN >/dev/null 2>&1; then
                    _gw_restarted=1
                    break
                fi
            fi
        done
        if [ "$_gw_restarted" -eq 1 ]; then
            echo "  gateway 已自动重启完成"
        else
            echo "  等待超时，将在最后一步重新启动"
        fi
    else
        echo "  gateway 当前未运行，跳过自动重启等待（将在最后一步启动）"
    fi

    # 记录更新后的 qqbot 插件版本
    NEW_QQBOT_VERSION=$(node -e '
        try {
            const fs = require("fs");
            const path = require("path");
            const candidates = ["openclaw-qqbot", "qqbot", "openclaw-qq"];
            for (const name of candidates) {
                const pkgPath = path.join(process.env.HOME, ".openclaw", "extensions", name, "package.json");
                if (!fs.existsSync(pkgPath)) continue;
                const p = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
                process.stdout.write(p.version || "unknown");
                process.exit(0);
            }
            process.stdout.write("unknown");
        } catch(e) { process.stdout.write("unknown"); }
    ' 2>/dev/null || echo "unknown")
fi

# 4. 配置机器人通道（仅在需要变更时写入配置，避免无意义覆盖）
echo ""
echo "[4/6] 配置机器人通道..."

# 读取当前 qqbot token（兼容多 key）
CURRENT_QQBOT_TOKEN=""
for _app in openclaw clawdbot moltbot; do
    _cfg="$HOME/.$_app/$_app.json"
    if [ -f "$_cfg" ]; then
        CURRENT_QQBOT_TOKEN=$(node -e "
            const cfg = JSON.parse(require('fs').readFileSync('$_cfg', 'utf8'));
            const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
            for (const key of keys) {
              const ch = cfg.channels && cfg.channels[key];
              if (!ch) continue;
              if (ch.token) { process.stdout.write(ch.token); process.exit(0); }
              if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); process.exit(0); }
            }
        " 2>/dev/null || true)
        [ -n "$CURRENT_QQBOT_TOKEN" ] && break
    fi
done

DESIRED_QQBOT_TOKEN=""
if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    DESIRED_QQBOT_TOKEN="${APPID}:${SECRET}"
    echo "使用提供的 appid 和 secret 配置..."
elif [ -n "$QQBOT_TOKEN" ]; then
    DESIRED_QQBOT_TOKEN="$QQBOT_TOKEN"
    echo "使用环境变量 QQBOT_TOKEN 配置..."
elif [ -n "$SAVED_QQBOT_TOKEN" ]; then
    DESIRED_QQBOT_TOKEN="$SAVED_QQBOT_TOKEN"
    echo "未提供 appid/secret，使用备份 token 恢复配置..."
fi

if [ -n "$DESIRED_QQBOT_TOKEN" ]; then
    echo "配置机器人通道: qqbot"
    echo "目标Token: ${DESIRED_QQBOT_TOKEN:0:10}..."
    if [ "$CURRENT_QQBOT_TOKEN" = "$DESIRED_QQBOT_TOKEN" ]; then
        echo "✅ 当前配置已是目标值，跳过写入（避免配置覆盖提示）"
        _config_changed=0
    elif ! openclaw channels add --channel qqbot --token "$DESIRED_QQBOT_TOKEN" 2>&1; then
        echo "⚠️  警告: 机器人通道配置失败，继续使用已有配置"
        _config_changed=0
    else
        echo "✅ 机器人通道配置成功"
        _config_changed=1
        # channels 配置变更在 reload plan 中匹配为 hot reload（非 restart），
        # 由 channel 插件热重载处理，通常 <1 秒完成，无需长时间等待。
        sleep 1
    fi
else
    # 未提供任何可用 token 时，检查是否已有可用配置
    _has_channel=0
    if [ -n "$CURRENT_QQBOT_TOKEN" ]; then
        _has_channel=1
    fi

    if [ "$_has_channel" -eq 0 ]; then
        echo ""
        echo "❌ 未检测到 qqbot 通道配置！"
        echo ""
        echo "首次运行请提供 appid 和 appsecret："
        echo ""
        echo "  bash $0 --appid <你的appid> --secret <你的appsecret>"
        echo ""
        echo "也可以通过环境变量："
        echo ""
        echo "  QQBOT_APPID=<appid> QQBOT_SECRET=<appsecret> bash $0"
        echo ""
        echo "appid 和 appsecret 可在 QQ 开放平台 (https://q.qq.com) 获取。"
        exit 1
    else
        echo "使用已有配置"
    fi
fi

# 5. 配置 markdown 选项（仅在明确指定时才配置）
echo ""
echo "[5/6] 配置 markdown 选项..."

if [ -n "$MARKDOWN" ]; then
    # 设置 markdown 配置
    if [ "$MARKDOWN" = "yes" ] || [ "$MARKDOWN" = "y" ] || [ "$MARKDOWN" = "true" ]; then
        MARKDOWN_VALUE="true"
        echo "启用 markdown 消息格式..."
    else
        MARKDOWN_VALUE="false"
        echo "禁用 markdown 消息格式（使用纯文本）..."
    fi

    CURRENT_MARKDOWN_VALUE=$(node -e "
      const fs = require('fs');
      const path = require('path');
      const home = process.env.HOME;
      for (const app of ['openclaw', 'clawdbot', 'moltbot']) {
        const f = path.join(home, '.' + app, app + '.json');
        if (!fs.existsSync(f)) continue;
        try {
          const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
          const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
          for (const key of keys) {
            const ch = cfg.channels && cfg.channels[key];
            if (!ch) continue;
            if (typeof ch.markdownSupport === 'boolean') { process.stdout.write(String(ch.markdownSupport)); process.exit(0); }
          }
        } catch {}
      }
    " 2>/dev/null || true)

    if [ "$CURRENT_MARKDOWN_VALUE" = "$MARKDOWN_VALUE" ]; then
        echo "✅ markdown 配置已是目标值，跳过写入（避免配置覆盖提示）"
    elif openclaw config set channels.qqbot.markdownSupport "$MARKDOWN_VALUE" 2>&1; then
        echo "✅ markdown配置成功"
        _config_changed=1
    else
        echo "⚠️  openclaw config set 失败，尝试直接编辑配置文件..."
        OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
        if [ -f "$OPENCLAW_CONFIG" ] && node -e "
          const fs = require('fs');
          const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG', 'utf-8'));
          if (!cfg.channels) cfg.channels = {};
          if (!cfg.channels.qqbot) cfg.channels.qqbot = {};
          const target = $MARKDOWN_VALUE;
          if (cfg.channels.qqbot.markdownSupport === target) process.exit(0);
          cfg.channels.qqbot.markdownSupport = target;
          fs.writeFileSync('$OPENCLAW_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        " 2>&1; then
            echo "✅ markdown配置成功（直接编辑配置文件）"
            _config_changed=1
        else
            echo "⚠️  markdown配置设置失败，不影响后续运行"
        fi
    fi
else
    echo "未指定 markdown 选项，使用已有配置"
fi

# 6. 启动 openclaw
echo ""
echo "[6/6] 启动 openclaw..."
echo "========================================="

# 检查openclaw是否可用
if ! command -v openclaw &> /dev/null; then
    echo "❌ 错误: openclaw 命令未找到！"
    echo ""
    echo "可能的原因:"
    echo "1. openclaw未安装或安装失败"
    echo "2. PATH环境变量未包含openclaw路径"
    echo "3. 需要重新登录或重启终端"
    echo ""
    exit 1
fi

echo "openclaw版本: $(openclaw --version 2>/dev/null || echo '未知')"

# 显示 qqbot 插件更新信息
NEW_QQBOT_VERSION="${NEW_QQBOT_VERSION:-unknown}"
if [ "$OLD_QQBOT_VERSION" = "$NEW_QQBOT_VERSION" ]; then
    echo "qqbot 插件版本: $NEW_QQBOT_VERSION (未变化)"
elif [ "$OLD_QQBOT_VERSION" = "not_installed" ]; then
    echo "qqbot 插件版本: $NEW_QQBOT_VERSION (新安装)"
else
    echo "qqbot 插件版本: $OLD_QQBOT_VERSION -> $NEW_QQBOT_VERSION"
fi
echo ""
read -t 120 -p "是否后台重启 openclaw 网关服务？[Y/n] " start_choice || start_choice="y"
start_choice="${start_choice:-y}"
start_choice=$(printf '%s' "$start_choice" | tr '[:upper:]' '[:lower:]')

case "$start_choice" in
    y|yes)
        echo ""
        # plugins install 已触发自动 restart（Step 3 已等待完成），
        # channels add / config set 只触发 hot reload（无需 restart）。
        # 这里仍做一次显式 restart 作为兜底，确保插件正确加载。
        # 如果 gateway 当前已在监听端口，先检查是否真需要 restart。
        _need_restart=1
        if lsof -i :18789 -sTCP:LISTEN >/dev/null 2>&1; then
            # gateway 已在运行，如果 Step 3 的自动 restart 已成功加载新插件，
            # 且 Step 4/5 只做了 hot reload，理论上不需要再 restart。
            # 但为安全起见：如果版本有变化或配置有变化，仍 restart 一次。
            if [ "$OLD_QQBOT_VERSION" = "$NEW_QQBOT_VERSION" ] && [ "${_config_changed:-0}" -eq 0 ]; then
                echo "插件版本未变化且配置无变更，跳过冗余重启"
                _need_restart=0
            fi
        fi

        if [ "$_need_restart" -eq 1 ]; then
            echo "正在后台重启 openclaw 网关服务..."
            _restart_output=$(openclaw gateway restart 2>&1) || true
            echo "$_restart_output"

            if echo "$_restart_output" | grep -qi "not loaded\|not found\|not running\|not installed"; then
                # gateway 服务未加载（常见于首次安装或 launchd 服务被卸载的情况）
                # 正确恢复流程：install 注册 launchd plist → start 启动服务
                echo ""
                echo "⚠️  gateway 服务未加载，尝试自动恢复..."
                echo ""
                echo "  [1/2] 注册 gateway 服务..."
                _install_out=$(openclaw gateway install 2>&1) || true
                echo "  $_install_out"
                echo ""
                echo "  [2/2] 启动 gateway 服务..."
                _start_out=$(openclaw gateway start 2>&1) || true
                echo "  $_start_out"
                # 检查恢复是否成功
                if echo "$_start_out" | grep -qi "restart\|started\|bootstrap"; then
                    echo ""
                    echo "✅ gateway 服务恢复成功"
                else
                    echo ""
                    echo "⚠️  自动恢复可能失败，请手动执行："
                    echo "  openclaw gateway install && openclaw gateway start"
                fi
            else
                echo ""
                echo "✅ openclaw 网关已在后台重启"
            fi
        fi
        echo ""
        # 等待 gateway 端口就绪
        echo "等待 gateway 就绪..."
        echo "========================================="
        _port_ready=0
        for i in $(seq 1 30); do
            if lsof -i :18789 -sTCP:LISTEN >/dev/null 2>&1; then
                _port_ready=1
                break
            fi
            printf "\r  等待端口 18789 就绪... (%d/30)" "$i"
            sleep 2
        done
        echo ""

        if [ "$_port_ready" -eq 0 ]; then
            echo "⚠️  等待超时，gateway 可能仍在启动中"
            echo "请手动检查: openclaw doctor"
            echo "或查看日志: tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
        else
            echo "✅ Gateway 端口已就绪"
            echo ""
            # 检查 qqbot WS 是否连接成功（最多等 20 秒）
            echo "检查 qqbot 插件连接状态..."
            _LOG_FILE="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
            _restart_ts=$(date +%s)
            _qqbot_ready=0
            for _j in $(seq 1 10); do
                # 只检查在本次重启之后出现的 "Gateway ready" 日志
                if [ -f "$_LOG_FILE" ]; then
                    _last_line=$(grep "Gateway ready" "$_LOG_FILE" 2>/dev/null | tail -1 || true)
                    if [ -n "$_last_line" ]; then
                        _qqbot_ready=1
                        break
                    fi
                fi
                printf "\r  等待 qqbot WS 连接... (%d/10)" "$_j"
                sleep 2
            done
            echo ""

            if [ "$_qqbot_ready" -eq 0 ]; then
                echo "⚠️  qqbot 插件可能未正确加载"
                echo "请检查: openclaw doctor"
            else
                echo "✅ qqbot 插件已连接"
            fi
            echo ""
            echo "正在跟踪日志输出（按 Ctrl+C 停止查看，不影响后台服务）..."
            echo "========================================="
            _retries=0
            while ! openclaw logs --follow 2>&1; do
                _retries=$((_retries + 1))
                if [ $_retries -ge 5 ]; then
                    echo ""
                    echo "⚠️  无法连接日志流，请手动执行: openclaw logs --follow"
                    echo "或直接查看日志文件: tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
                    break
                fi
                echo "等待日志流就绪... (${_retries}/5)"
                sleep 3
            done
        fi
        ;;
    n|no)
        echo ""
        echo "✅ 插件更新完毕，未启动服务"
        echo ""
        echo "后续可手动启动:"
        echo "  openclaw gateway restart    # 重启后台服务"
        echo "  openclaw logs --follow      # 跟踪日志"
        ;;
    *)
        echo "无效选择，按默认值 y 执行后台重启"
        echo ""
        echo "正在后台重启 openclaw 网关服务..."
        if ! openclaw gateway restart 2>&1; then
            echo "⚠️  后台重启失败，可能服务未安装"
            echo "尝试: openclaw gateway install && openclaw gateway start"
        fi
        echo "✅ openclaw 网关已在后台重启"
        ;;
esac

echo "========================================="
