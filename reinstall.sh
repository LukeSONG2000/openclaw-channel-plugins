#!/bin/bash
# 脚本名称：openclaw_uninstall_reinstall.sh
# 适配场景：macOS 本地开发、OpenClaw 源码克隆+编译安装（含QQBot Channel插件）
# 功能：一键卸载OpenClaw（彻底清理残留）+ 重新克隆源码+编译+安装+配置基础插件
# 作者：适配本地开发场景定制
# 注意：运行前请确认已安装 Homebrew、Node.js 22+、pnpm，否则脚本会自动提示安装

##############################################################################
# 操作确认
##############################################################################
echo ""
printf "%b\n" "\033[33m⚠️  此脚本将执行以下操作：\033[0m"
echo ""
echo "  1. 彻底卸载 OpenClaw（停止服务、删除源码、清理配置）"
echo "  2. 重新克隆源码并编译安装 OpenClaw"
echo "  3. 安装 QQBot Channel 插件"
echo "  4. 配置网关和 QQ 机器人凭据"
echo ""
printf "%b\n" "\033[31m  将被删除的目录：\033[0m"
echo "    ~/openclaw          (OpenClaw 源码)"
echo "    ~/qqbot             (QQBot 插件源码)"
echo "    ~/.openclaw         (配置及数据)"
echo "    ~/.clawdbot         (旧版残留)"
echo "    ~/.moltbot          (旧版残留)"
echo "    ~/.molthub          (旧版残留)"
echo ""
read -p "确认继续？(y/N): " CONFIRM_CHOICE
if [ "$CONFIRM_CHOICE" != "y" ] && [ "$CONFIRM_CHOICE" != "Y" ]; then
    echo "已取消操作。"
    exit 0
fi
echo ""

# 询问是否继承旧配置
INHERIT_CONFIG=""
BACKUP_CONFIG_FILE="/tmp/openclaw-config-backup-$$.json"
OPENCLAW_CONFIG_SRC="$HOME/.openclaw/openclaw.json"

if [ -f "$OPENCLAW_CONFIG_SRC" ]; then
    echo "检测到已有配置文件: $OPENCLAW_CONFIG_SRC"
    read -p "是否继承现有配置（gateway、channels 等）？(Y/n): " INHERIT_CHOICE
    INHERIT_CHOICE="${INHERIT_CHOICE:-Y}"
    if [ "$INHERIT_CHOICE" = "y" ] || [ "$INHERIT_CHOICE" = "Y" ]; then
        cp "$OPENCLAW_CONFIG_SRC" "$BACKUP_CONFIG_FILE"
        if [ -f "$BACKUP_CONFIG_FILE" ]; then
            INHERIT_CONFIG="yes"
            echo "✅ 已备份配置到临时文件"
        else
            printf "%b\n" "\033[33m⚠️  备份失败，安装后需手动重新配置\033[0m"
        fi
    else
        echo "⏭  不继承旧配置，安装后重新配置"
    fi
else
    echo "ℹ️  未检测到已有配置文件，将全新安装"
fi
echo ""

##############################################################################
# 第一步：一键卸载 OpenClaw（彻底无残留，适配源码安装）
##############################################################################
printf "%b\n" "\033[32m=====================================\033[0m"
printf "%b\n" "\033[32m开始卸载 OpenClaw（彻底清理残留）...\033[0m"
printf "%b\n" "\033[32m=====================================\033[0m"

# 1. 停止后台网关服务及自启服务
printf "%b\n" "\033[34m1. 停止 OpenClaw 后台服务及自启项...\033[0m"

# 先尝试正常停止
openclaw gateway stop >/dev/null 2>&1 || true
sleep 1

# 卸载所有 launchd 自启服务（含新旧版本）
for svc in ai.openclaw.gateway ai.clawdbot.gateway ai.moltbot.gateway bot.molt.gateway; do
    launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
done

# 终止所有相关后台进程
ps aux | grep -E "(openclaw|moltbot|clawdbot)" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null || true
sleep 1

# 检查默认端口是否仍被占用，强杀
PORT_PID=$(lsof -ti:18789 2>/dev/null || true)
if [ -n "$PORT_PID" ]; then
    printf "%b\n" "\033[33m⚠️  端口 18789 仍被占用 [PID: $PORT_PID]，强制终止...\033[0m"
    kill -9 $PORT_PID 2>/dev/null || true
    sleep 1
fi

# 2. 删除自启服务配置文件（含旧版本残留）
printf "%b\n" "\033[34m2. 删除自启服务配置文件...\033[0m"
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
rm -f ~/Library/LaunchAgents/com.openclaw.*.plist
rm -f ~/Library/LaunchAgents/com.clawdbot.*.plist
rm -f ~/Library/LaunchAgents/ai.openclaw.*.plist
rm -f ~/Library/LaunchAgents/ai.moltbot.*.plist
rm -f ~/Library/LaunchAgents/com.moltbot.*.plist

# 3. 卸载全局 CLI（npm/pnpm 双适配）
printf "%b\n" "\033[34m3. 卸载全局 OpenClaw CLI...\033[0m"
npm uninstall -g openclaw >/dev/null 2>&1
pnpm remove -g openclaw >/dev/null 2>&1

# 4. 删除源码目录（默认路径，可根据实际修改）
printf "%b\n" "\033[34m4. 删除 OpenClaw 源码目录...\033[0m"
OPENCLAW_SOURCE_DIR=~/openclaw  # 默认克隆路径，若修改过请替换此处
if [ -d "$OPENCLAW_SOURCE_DIR" ]; then
    rm -rf "$OPENCLAW_SOURCE_DIR"
    echo "✅ 源码目录 $OPENCLAW_SOURCE_DIR 已删除"
else
    echo "ℹ️  未找到 OpenClaw 源码目录，跳过删除"
fi

# 5. 删除 QQBot 插件源码目录（默认路径，可修改）
printf "%b\n" "\033[34m5. 删除 QQBot Channel 插件源码目录...\033[0m"
QQBOT_SOURCE_DIR=~/qqbot  # 默认克隆路径，若修改过请替换此处
if [ -d "$QQBOT_SOURCE_DIR" ]; then
    rm -rf "$QQBOT_SOURCE_DIR"
    echo "✅ QQBot 插件目录 $QQBOT_SOURCE_DIR 已删除"
else
    echo "ℹ️  未找到 QQBot 插件目录，跳过删除"
fi

# 6. 删除配置及残留目录（核心清理）
printf "%b\n" "\033[34m6. 删除配置及残留文件...\033[0m"
rm -rf ~/.openclaw
rm -rf ~/.clawdbot
rm -rf ~/.moltbot
rm -rf ~/.molthub

# 7. 清理依赖缓存（释放空间，可选，不影响其他应用）
printf "%b\n" "\033[34m7. 清理 npm/pnpm 依赖缓存...\033[0m"
pnpm store prune 2>/dev/null
npm cache clean --force 2>/dev/null

# 卸载验证
printf "%b\n" "\033[34m8. 验证卸载结果...\033[0m"
if ! command -v openclaw &> /dev/null && [ ! -d ~/.openclaw ]; then
    printf "%b\n" "\033[32m✅ OpenClaw 卸载完成，无残留！\033[0m"
else
    printf "%b\n" "\033[31m⚠️  卸载可能不彻底，建议手动执行验证命令（脚本末尾有验证步骤）\033[0m"
fi

##############################################################################
# 第二步：环境检查（自动检测依赖，缺失则提示安装）
##############################################################################
printf "%b\n" "\n\033[32m=====================================\033[0m"
printf "%b\n" "\033[32m开始环境检查（依赖：Homebrew、Node.js 22+、pnpm）...\033[0m"
printf "%b\n" "\033[32m=====================================\033[0m"

# 检查 Homebrew
if ! command -v brew &> /dev/null; then
    printf "%b\n" "\033[31m❌ 未检测到 Homebrew，需先安装 Homebrew！\033[0m"
    read -p "是否立即安装 Homebrew？(y/n)：" BREW_INSTALL
    if [ "$BREW_INSTALL" = "y" ] || [ "$BREW_INSTALL" = "Y" ]; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        brew update
    else
        printf "%b\n" "\033[31m❌ 未安装 Homebrew，脚本终止！\033[0m"
        exit 1
    fi
else
    echo "✅ Homebrew 已安装"
fi

# 检查 Node.js（要求 v22+）
if ! command -v node &> /dev/null; then
    printf "%b\n" "\033[31m❌ 未检测到 Node.js，需安装 Node.js 22+！\033[0m"
    read -p "是否通过 Homebrew 安装 Node.js 22？(y/n)：" NODE_INSTALL
    if [ "$NODE_INSTALL" = "y" ] || [ "$NODE_INSTALL" = "Y" ]; then
        brew install node@22
        source ~/.bashrc  # 刷新环境变量
    else
        printf "%b\n" "\033[31m❌ 未安装 Node.js，脚本终止！\033[0m"
        exit 1
    fi
else
    NODE_VERSION=$(node --version | cut -d 'v' -f 2 | cut -d '.' -f 1)
    if [ "$NODE_VERSION" -lt 22 ]; then
        printf "%b\n" "\033[31m❌ Node.js 版本过低（当前 v$NODE_VERSION），需升级至 v22+！\033[0m"
        read -p "是否通过 Homebrew 升级 Node.js 22？(y/n)：" NODE_UPGRADE
        if [ "$NODE_UPGRADE" = "y" ] || [ "$NODE_UPGRADE" = "Y" ]; then
            brew install node@22
            source ~/.bashrc
        else
            printf "%b\n" "\033[31m❌ Node.js 版本不满足要求，脚本终止！\033[0m"
            exit 1
        fi
    else
        echo "✅ Node.js 版本满足要求（当前 v$(node --version)）"
    fi
fi

# 检查 pnpm（优先使用 pnpm，无则安装）
if ! command -v pnpm &> /dev/null; then
    printf "%b\n" "\033[31m❌ 未检测到 pnpm，需安装 pnpm！\033[0m"
    read -p "是否通过 npm 安装 pnpm？(y/n)：" PNPM_INSTALL
    if [ "$PNPM_INSTALL" = "y" ] || [ "$PNPM_INSTALL" = "Y" ]; then
        npm install -g pnpm
    else
        printf "%b\n" "\033[31m❌ 未安装 pnpm，脚本终止！\033[0m"
        exit 1
    fi
else
    echo "✅ pnpm 已安装"
fi

# 检查 git（克隆源码需要）
if ! command -v git &> /dev/null; then
    printf "%b\n" "\033[31m❌ 未检测到 git，需安装 git！\033[0m"
    read -p "是否通过 Homebrew 安装 git？(y/n)：" GIT_INSTALL
    if [ "$GIT_INSTALL" = "y" ] || [ "$GIT_INSTALL" = "Y" ]; then
        brew install git
    else
        printf "%b\n" "\033[31m❌ 未安装 git，脚本终止！\033[0m"
        exit 1
    fi
else
    echo "✅ git 已安装"
fi

printf "%b\n" "\033[32m✅ 所有依赖环境检查通过，开始重新安装 OpenClaw...\033[0m"

##############################################################################
# 第三步：重新安装 OpenClaw（源码克隆+编译+全局安装）
##############################################################################
printf "%b\n" "\n\033[32m=====================================\033[0m"
printf "%b\n" "\033[32m开始重新安装 OpenClaw（源码版）...\033[0m"
printf "%b\n" "\033[32m=====================================\033[0m"

# 1. 克隆 OpenClaw 源码（默认用户目录，可修改路径）
OPENCLAW_SOURCE_DIR=~/openclaw
printf "%b\n" "\033[34m1. 克隆 OpenClaw 源码到 $OPENCLAW_SOURCE_DIR...\033[0m"
git clone https://github.com/openclaw/openclaw.git "$OPENCLAW_SOURCE_DIR"
cd "$OPENCLAW_SOURCE_DIR" || { printf "%b\n" "\033[31m❌ 进入源码目录失败，脚本终止！\033[0m"; exit 1; }

# （可选）切换指定版本（默认最新版，如需指定版本，取消注释并修改版本号）
# git checkout v2026.2.25

# 2. 安装 OpenClaw 依赖
printf "%b\n" "\033[34m2. 安装 OpenClaw 项目依赖...\033[0m"
pnpm install
if [ $? -ne 0 ]; then
    printf "%b\n" "\033[31m❌ pnpm 安装依赖失败，尝试用 npm 安装...\033[0m"
    npm install
    if [ $? -ne 0 ]; then
        printf "%b\n" "\033[31m❌ npm 安装依赖也失败，脚本终止！\033[0m"
        exit 1
    fi
fi

# 3. 编译 OpenClaw
printf "%b\n" "\033[34m3. 编译 OpenClaw 项目...\033[0m"
pnpm build
if [ $? -ne 0 ]; then
    printf "%b\n" "\033[31m❌ 编译 OpenClaw 失败，脚本终止！\033[0m"
    exit 1
fi

# 4. 全局安装 OpenClaw（方便终端直接调用）
printf "%b\n" "\033[34m4. 全局安装 OpenClaw...\033[0m"
if npm install -g 2>&1; then
    : # npm 安装成功
elif pnpm install -g 2>/dev/null; then
    : # pnpm fallback 成功
else
    printf "%b\n" "\033[31m❌ 全局安装失败，脚本终止！\033[0m"
    exit 1
fi

# 验证 OpenClaw 安装
printf "%b\n" "\033[34m5. 验证 OpenClaw 安装结果...\033[0m"
if command -v openclaw &> /dev/null; then
    printf "%b\n" "\033[32m✅ OpenClaw 安装成功，版本：$(openclaw --version)\033[0m"
else
    printf "%b\n" "\033[31m❌ OpenClaw 安装失败，脚本终止！\033[0m"
    exit 1
fi

##############################################################################
# 第四步：安装 QQBot Channel 插件（源码版，官方推荐 @sliverp/qqbot）
##############################################################################
printf "%b\n" "\n\033[32m=====================================\033[0m"
printf "%b\n" "\033[32m开始安装 QQBot Channel 插件...\033[0m"
printf "%b\n" "\033[32m=====================================\033[0m"

# 1. 克隆 QQBot 插件源码（默认用户目录）
QQBOT_SOURCE_DIR=~/qqbot
printf "%b\n" "\033[34m1. 克隆 QQBot 插件源码到 $QQBOT_SOURCE_DIR...\033[0m"
git clone https://github.com/sliverp/qqbot.git "$QQBOT_SOURCE_DIR"
cd "$QQBOT_SOURCE_DIR" || { printf "%b\n" "\033[31m❌ 进入 QQBot 插件目录失败，脚本终止！\033[0m"; exit 1; }

# 2. 安装 QQBot 插件依赖
printf "%b\n" "\033[34m2. 安装 QQBot 插件依赖...\033[0m"
pnpm install
if [ $? -ne 0 ]; then
    printf "%b\n" "\033[31m❌ pnpm 安装插件依赖失败，尝试用 npm 安装...\033[0m"
    npm install
    if [ $? -ne 0 ]; then
        printf "%b\n" "\033[31m❌ npm 安装插件依赖也失败，脚本终止！\033[0m"
        exit 1
    fi
fi

# 3. 将 QQBot 插件安装到 OpenClaw
printf "%b\n" "\033[34m3. 安装 QQBot 插件到 OpenClaw...\033[0m"
PLUGIN_INSTALL_OUTPUT=$(openclaw plugins install . 2>&1)
PLUGIN_INSTALL_RC=$?
echo "$PLUGIN_INSTALL_OUTPUT" | grep -v "WARNING.*dangerous code patterns"
if [ $PLUGIN_INSTALL_RC -ne 0 ]; then
    printf "%b\n" "\033[33m⚠️  插件自动安装失败，尝试手动安装...\033[0m"
    mkdir -p ~/.openclaw/plugins/qqbot
    cp -r . ~/.openclaw/plugins/qqbot
    if [ $? -eq 0 ]; then
        echo "✅ 手动安装 QQBot 插件成功"
    else
        printf "%b\n" "\033[31m❌ QQBot 插件手动安装也失败，脚本终止！\033[0m"
        exit 1
    fi
else
    echo "✅ QQBot 插件自动安装成功"
fi

# 验证插件安装
printf "%b\n" "\033[34m4. 验证 QQBot 插件安装结果...\033[0m"
PLUGIN_STATUS=$(openclaw plugins list | grep qqbot | awk '{print $2}')
if [ "$PLUGIN_STATUS" = "enabled" ]; then
    printf "%b\n" "\033[32m✅ QQBot Channel 插件安装成功，状态：启用\033[0m"
else
    printf "%b\n" "\033[33m⚠️  QQBot 插件已安装，但未启用，需手动执行：openclaw plugins enable qqbot\033[0m"
fi

##############################################################################
# 第五步：配置 gateway.mode 和 QQ 机器人凭据，一步到位
##############################################################################
printf "%b\n" "\n\033[32m=====================================\033[0m"
printf "%b\n" "\033[32m开始配置 OpenClaw 和 QQBot 插件...\033[0m"
printf "%b\n" "\033[32m=====================================\033[0m"

OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

# --- 5a. 恢复备份配置（如有） ---
if [ "$INHERIT_CONFIG" = "yes" ] && [ -f "$BACKUP_CONFIG_FILE" ]; then
    printf "%b\n" "\033[34m恢复备份的配置文件...\033[0m"
    cp "$BACKUP_CONFIG_FILE" "$OPENCLAW_CONFIG"
    if [ $? -eq 0 ]; then
        echo "✅ 已恢复旧配置"
        rm -f "$BACKUP_CONFIG_FILE"
    else
        printf "%b\n" "\033[33m⚠️  恢复失败，将全新配置\033[0m"
    fi
fi

# --- 5b. 设置 gateway.mode=local ---
printf "%b\n" "\033[34m1. 设置网关模式 gateway.mode=local ...\033[0m"
if openclaw config set gateway.mode local 2>&1; then
    echo "✅ 网关模式已设置为 local"
else
    printf "%b\n" "\033[33m⚠️  自动设置失败，尝试直接写入配置文件...\033[0m"
    if [ -f "$OPENCLAW_CONFIG" ]; then
        node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG', 'utf8'));
            cfg.gateway = cfg.gateway || {};
            cfg.gateway.mode = 'local';
            fs.writeFileSync('$OPENCLAW_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        " 2>/dev/null && echo "✅ 网关模式已写入配置文件" || printf "%b\n" "\033[31m❌ 写入失败，请手动执行: openclaw config set gateway.mode local\033[0m"
    fi
fi

# --- 5c. 配置 QQ 机器人 AppID 和 AppSecret ---
echo ""
printf "%b\n" "\033[34m2. 配置 QQ 机器人凭据...\033[0m"
echo ""

# 从现有配置读取旧值（如果有）
OLD_APPID=""
OLD_SECRET=""
if [ -f "$OPENCLAW_CONFIG" ]; then
    OLD_APPID=$(node -e "
        try {
            const c = JSON.parse(require('fs').readFileSync('$OPENCLAW_CONFIG','utf8'));
            process.stdout.write((c.channels && c.channels.qqbot && c.channels.qqbot.appId) || '');
        } catch(e) {}
    " 2>/dev/null)
    OLD_SECRET=$(node -e "
        try {
            const c = JSON.parse(require('fs').readFileSync('$OPENCLAW_CONFIG','utf8'));
            process.stdout.write((c.channels && c.channels.qqbot && c.channels.qqbot.secret) || '');
        } catch(e) {}
    " 2>/dev/null)
fi

if [ -n "$OLD_APPID" ]; then
    MASKED_SECRET="${OLD_SECRET:0:4}****"
    echo "检测到已有凭据:"
    echo "  AppID:  $OLD_APPID"
    echo "  Secret: $MASKED_SECRET"
    echo ""
    echo "直接回车保留现有值，输入新值则覆盖。"
    echo ""
    read -p "QQ 机器人 AppID [$OLD_APPID]: " QQ_APPID
    QQ_APPID=$(echo "$QQ_APPID" | xargs)
    QQ_APPID="${QQ_APPID:-$OLD_APPID}"

    read -p "QQ 机器人 AppSecret [$MASKED_SECRET]: " QQ_SECRET
    QQ_SECRET=$(echo "$QQ_SECRET" | xargs)
    QQ_SECRET="${QQ_SECRET:-$OLD_SECRET}"
else
    echo "请在 QQ 开放平台 (https://q.qq.com) 获取以下信息："
    echo ""
    read -p "请输入 QQ 机器人 AppID（留空跳过）: " QQ_APPID
    QQ_APPID=$(echo "$QQ_APPID" | xargs)

    if [ -n "$QQ_APPID" ]; then
        read -p "请输入 QQ 机器人 AppSecret: " QQ_SECRET
        QQ_SECRET=$(echo "$QQ_SECRET" | xargs)
    fi
fi

if [ -n "$QQ_APPID" ] && [ -n "$QQ_SECRET" ]; then
    echo ""
    echo "  写入通道配置..."
    if node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG', 'utf8'));
        cfg.channels = cfg.channels || {};
        cfg.channels.qqbot = cfg.channels.qqbot || {};
        cfg.channels.qqbot.appId = '$QQ_APPID';
        cfg.channels.qqbot.secret = '$QQ_SECRET';
        fs.writeFileSync('$OPENCLAW_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
    " 2>/dev/null; then
        echo "✅ QQ 机器人凭据已写入配置"
        echo "   AppID:  $QQ_APPID"
        echo "   Secret: ${QQ_SECRET:0:4}****"
    else
        printf "%b\n" "\033[31m❌ 写入配置失败\033[0m"
        echo ""
        echo "请手动配置:"
        echo "  openclaw channels add --channel qqbot --token '$QQ_APPID:$QQ_SECRET'"
    fi
elif [ -n "$QQ_APPID" ] && [ -z "$QQ_SECRET" ]; then
    printf "%b\n" "\033[31m❌ AppSecret 不能为空，跳过凭据配置\033[0m"
    echo ""
    echo "后续手动配置:"
    echo "  openclaw channels add --channel qqbot --token 'YOUR_APPID:YOUR_SECRET'"
else
    echo "⏭  已跳过凭据配置"
    echo ""
    echo "后续配置方法:"
    echo "  openclaw channels add --channel qqbot --token 'YOUR_APPID:YOUR_SECRET'"
fi

# --- 5c. 启动网关 ---
echo ""
printf "%b\n" "\033[34m3. 启动 OpenClaw 网关...\033[0m"
echo ""
echo "请选择启动方式:"
echo ""
echo "  1) 后台重启 (推荐)"
echo "     重启后台服务，自动跟踪日志输出"
echo ""
echo "  2) 不启动"
echo "     稍后自己手动启动"
echo ""
read -p "请输入选择 [1/2] (默认 1): " start_choice
start_choice="${start_choice:-1}"

case "$start_choice" in
    1)
        echo ""
        echo "正在启动 OpenClaw 网关服务..."
        # 先确保 LaunchAgent 已安装（restart 在服务未安装时会静默失败）
        openclaw gateway install 2>&1 || true
        sleep 1
        if openclaw gateway restart 2>&1; then
            echo ""
            # 等待 gateway 真正就绪（RPC probe ok），而不是盲等固定秒数
            echo "等待网关就绪..."
            _ready=0
            for i in 1 2 3 4 5 6 7 8 9 10; do
                sleep 2
                if openclaw gateway status 2>&1 | grep -q "RPC probe: ok"; then
                    _ready=1
                    break
                fi
                printf "  等待中... (%s/10)\n" "$i"
            done

            if [ "$_ready" -eq 1 ]; then
                printf "%b\n" "\033[32m✅ OpenClaw 网关已启动\033[0m"
                echo ""
                echo "正在跟踪日志输出（按 Ctrl+C 停止查看，不影响后台服务）..."
                echo "========================================="
                openclaw logs --follow 2>&1 || {
                    echo ""
                    echo "⚠️  无法连接日志流，请手动执行: openclaw logs --follow"
                }
            else
                printf "%b\n" "\033[33m⚠️  网关启动超时（20s），可能仍在加载中\033[0m"
                echo ""
                echo "请手动检查:"
                echo "  openclaw gateway status    # 查看运行状态"
                echo "  openclaw logs --follow     # 跟踪日志"
            fi
        else
            echo ""
            printf "%b\n" "\033[33m⚠️  网关启动失败\033[0m"
            echo ""
            echo "请手动启动:"
            echo "  1. 安装服务: openclaw gateway install"
            echo "  2. 启动网关: openclaw gateway"
            echo "  3. 查看日志: openclaw logs --follow"
        fi
        ;;
    2)
        echo ""
        printf "%b\n" "\033[32m✅ 安装完毕，未启动服务\033[0m"
        echo ""
        echo "后续手动启动:"
        echo "  openclaw gateway restart    # 重启后台服务"
        echo "  openclaw logs --follow      # 跟踪日志"
        ;;
    *)
        echo "无效选择，跳过启动"
        ;;
esac

##############################################################################
# 完成
##############################################################################
echo ""
printf "%b\n" "\033[32m=========================================\033[0m"
printf "%b\n" "\033[32m✅ OpenClaw + QQBot 全流程安装配置完成！\033[0m"
printf "%b\n" "\033[32m=========================================\033[0m"
echo ""
echo "常用命令:"
echo "  openclaw logs --follow        # 跟踪日志"
echo "  openclaw gateway restart      # 重启服务"
echo "  openclaw plugins list         # 查看插件列表"
echo "  openclaw config set gateway.mode local  # 设置网关模式"
echo ""

exit 0
