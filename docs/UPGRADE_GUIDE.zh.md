# QQBot 插件升级指南

如果你之前安装过 QQBot 插件，但不熟悉 `openclaw plugins` 升级命令或 `npm` 操作，建议优先使用项目内置脚本。

## 方式一：推荐（脚本升级）

### 1) 通过 npm 包升级（最省事）

```bash
# 升级到 latest
bash ./scripts/upgrade-via-npm.sh

# 指定版本
bash ./scripts/upgrade-via-npm.sh --version 1.5.6
```

### 2) 通过源码一键升级并重启

```bash
# 已有配置时可直接执行
bash ./scripts/upgrade-via-source.sh

# 首次安装/首次配置（必须提供 AppID 和 Secret）
bash ./scripts/upgrade-via-source.sh --appid YOUR_APPID --secret YOUR_SECRET
```

> 注意：首次安装必须设置 `AppID` 和 `Secret`（或设置环境变量 `QQBOT_APPID` / `QQBOT_SECRET`）。

---

## 方式二：手动升级（适合熟悉 openclaw / npm 的用户）

### A. 直接从 npm 安装最新版本

```bash
# 可选：先卸载旧插件（按实际安装情况执行）
# 可先执行 `openclaw plugins list` 查看已安装插件 ID
# 常见历史插件 ID：qqbot / openclaw-qqbot
openclaw plugins uninstall qqbot
openclaw plugins uninstall openclaw-qqbot

# 如果你还安装过其它 QQBot 相关插件，也请一并 uninstall
# openclaw plugins uninstall <其它插件ID>

# 安装最新版本
openclaw plugins install @tencent-connect/openclaw-qqbot@latest

# 或安装指定版本
openclaw plugins install @tencent-connect/openclaw-qqbot@1.5.6
```

### B. 从源码目录安装

```bash
cd /path/to/openclaw-qqbot
npm install --omit=dev
openclaw plugins install .
```

### C. 配置通道（首次安装必做）

```bash
openclaw channels add --channel qqbot --token "AppID:AppSecret"
```

### D. 重启网关

```bash
openclaw gateway restart
```

### E. 验证

```bash
openclaw plugins list
openclaw channels list
openclaw logs --follow
```
