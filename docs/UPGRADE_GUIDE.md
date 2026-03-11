# QQBot Plugin Upgrade Guide

If you previously installed QQBot but are not familiar with `openclaw plugins` commands or npm operations, use the built-in scripts first.

## Option 1: Recommended (Script-based upgrade)

### 1) Upgrade via npm package (easiest)

```bash
# Upgrade to latest
bash ./scripts/upgrade-via-npm.sh

# Upgrade to a specific version
bash ./scripts/upgrade-via-npm.sh --version 1.5.6
```

### 2) One-click upgrade from local source and restart

```bash
# Run directly if you already have config
bash ./scripts/upgrade-via-source.sh

# First install / first-time config (AppID and Secret are required)
bash ./scripts/upgrade-via-source.sh --appid YOUR_APPID --secret YOUR_SECRET
```

> Note: For first-time installation, you must provide `AppID` and `Secret` (or set `QQBOT_APPID` / `QQBOT_SECRET`).

---

## Option 2: Manual upgrade (for users familiar with openclaw / npm)

### A. Install latest from npm directly

```bash
# Optional: uninstall old plugins first (based on your actual installation)
# Run `openclaw plugins list` to check installed plugin IDs
# Common legacy plugin IDs: qqbot / openclaw-qqbot
openclaw plugins uninstall qqbot
openclaw plugins uninstall openclaw-qqbot

# If you installed other QQBot-related plugins, uninstall them as well
# openclaw plugins uninstall <other-plugin-id>

# Install latest
openclaw plugins install @tencent-connect/openclaw-qqbot@latest

# Or install a specific version
openclaw plugins install @tencent-connect/openclaw-qqbot@1.5.6
```

### B. Install from source directory

```bash
cd /path/to/openclaw-qqbot
npm install --omit=dev
openclaw plugins install .
```

### C. Configure channel (required for first install)

```bash
openclaw channels add --channel qqbot --token "AppID:AppSecret"
```

### D. Restart gateway

```bash
openclaw gateway restart
```

### E. Verify

```bash
openclaw plugins list
openclaw channels list
openclaw logs --follow
```
