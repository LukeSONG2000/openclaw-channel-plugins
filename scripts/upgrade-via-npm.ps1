# qqbot 通过 npm 包升级（Windows PowerShell 版本）
#
# 与 upgrade-via-npm.sh 功能对等的 Windows 原生脚本。
# 不依赖 bash / Git Bash / WSL。
#
# 用法:
#   .\upgrade-via-npm.ps1                                    # 升级到 latest（默认）
#   .\upgrade-via-npm.ps1 -Version <version>                 # 升级到指定版本
#   .\upgrade-via-npm.ps1 -SelfVersion                       # 升级到当前仓库 package.json 版本
#   .\upgrade-via-npm.ps1 -AppId <appid> -Secret <secret>    # 首次安装时配置
#   .\upgrade-via-npm.ps1 -NoRestart                         # 只做文件替换（供热更指令使用）

param(
    [string]$Version = "",
    [switch]$SelfVersion,
    [string]$AppId = "",
    [string]$Secret = "",
    [switch]$NoRestart,
    [string]$Tag = "",
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$PKG_NAME = "@tencent-connect/openclaw-qqbot"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PROJECT_DIR = Split-Path -Parent $SCRIPT_DIR

# 读取本地版本号
$LOCAL_VERSION = ""
try {
    $pkgPath = Join-Path $PROJECT_DIR "package.json"
    if (Test-Path $pkgPath) {
        $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
        $LOCAL_VERSION = $pkg.version
    }
} catch {}

if ($Help) {
    Write-Host "用法:"
    Write-Host "  .\upgrade-via-npm.ps1                              # 升级到 latest（默认）"
    Write-Host "  .\upgrade-via-npm.ps1 -Version <版本号>            # 升级到指定版本"
    Write-Host "  .\upgrade-via-npm.ps1 -SelfVersion                 # 升级到当前仓库版本 ($LOCAL_VERSION)"
    Write-Host ""
    Write-Host "  -AppId <appid>       QQ机器人 appid（首次安装时必填）"
    Write-Host "  -Secret <secret>     QQ机器人 secret（首次安装时必填）"
    exit 0
}

# 确定安装源
$INSTALL_SRC = ""
if ($Tag) {
    $INSTALL_SRC = "${PKG_NAME}@${Tag}"
} elseif ($Version) {
    $INSTALL_SRC = "${PKG_NAME}@${Version}"
} elseif ($SelfVersion) {
    if (-not $LOCAL_VERSION) {
        Write-Host "❌ 无法从 package.json 读取版本" -ForegroundColor Red
        exit 1
    }
    $INSTALL_SRC = "${PKG_NAME}@${LOCAL_VERSION}"
} else {
    $INSTALL_SRC = "${PKG_NAME}@latest"
}

# 环境变量 fallback
if (-not $AppId) { $AppId = $env:QQBOT_APPID }
if (-not $Secret) { $Secret = $env:QQBOT_SECRET }
if ((-not $AppId) -and (-not $Secret) -and $env:QQBOT_TOKEN) {
    $parts = $env:QQBOT_TOKEN -split ":", 2
    $AppId = $parts[0]
    $Secret = $parts[1]
}

# 检测 CLI
$CMD = ""
foreach ($name in @("openclaw", "clawdbot", "moltbot")) {
    try {
        $null = Get-Command $name -ErrorAction Stop
        $CMD = $name
        break
    } catch {}
}
if (-not $CMD) {
    Write-Host "❌ 未找到 openclaw / clawdbot / moltbot" -ForegroundColor Red
    exit 1
}

$HOME_DIR = $env:USERPROFILE
if (-not $HOME_DIR) { $HOME_DIR = [Environment]::GetFolderPath("UserProfile") }
$EXTENSIONS_DIR = Join-Path $HOME_DIR ".$CMD" "extensions"

Write-Host "==========================================="
Write-Host "  qqbot npm 升级: $INSTALL_SRC"
Write-Host "==========================================="
Write-Host ""

# [1/3] 下载并安装新版本到临时目录
Write-Host "[1/3] 下载新版本..."
$TMPDIR_PACK = Join-Path ([System.IO.Path]::GetTempPath()) "qqbot-pack-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$EXTRACT_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "qqbot-extract-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $TMPDIR_PACK -Force | Out-Null
New-Item -ItemType Directory -Path $EXTRACT_DIR -Force | Out-Null

try {
    Push-Location $TMPDIR_PACK

    # 多 registry fallback
    $PACK_OK = $false
    $registries = @("https://registry.npmjs.org/", "https://registry.npmmirror.com/", "")
    foreach ($registry in $registries) {
        try {
            if ($registry) {
                Write-Host "  尝试 registry: $registry"
                & npm pack $INSTALL_SRC --registry $registry --quiet 2>&1 | Out-Null
            } else {
                Write-Host "  尝试默认 registry..."
                & npm pack $INSTALL_SRC --quiet 2>&1 | Out-Null
            }
            if ($LASTEXITCODE -eq 0) {
                $PACK_OK = $true
                break
            }
        } catch {}
    }

    if (-not $PACK_OK) {
        Write-Host "❌ npm pack 失败（所有 registry 均不可用）" -ForegroundColor Red
        exit 1
    }

    $TGZ_FILE = Get-ChildItem -Path $TMPDIR_PACK -Filter "*.tgz" | Select-Object -First 1
    if (-not $TGZ_FILE) {
        Write-Host "❌ 未找到下载的 tgz 文件" -ForegroundColor Red
        exit 1
    }
    Write-Host "  已下载: $($TGZ_FILE.Name)"

    # 解压 tgz（tar 在 Windows 10+ 内置可用）
    & tar xzf $TGZ_FILE.FullName -C $EXTRACT_DIR
    $PACKAGE_DIR = Join-Path $EXTRACT_DIR "package"
    if (-not (Test-Path $PACKAGE_DIR)) {
        Write-Host "❌ 解压失败，未找到 package 目录" -ForegroundColor Red
        exit 1
    }

    Pop-Location

    # 准备 staging 目录
    $STAGING_DIR = Join-Path (Split-Path $EXTENSIONS_DIR -Parent) ".qqbot-upgrade-staging"
    if (Test-Path $STAGING_DIR) { Remove-Item -Recurse -Force $STAGING_DIR }
    Copy-Item -Recurse -Force $PACKAGE_DIR $STAGING_DIR

    # 检查 bundled 依赖
    $nmDir = Join-Path $STAGING_DIR "node_modules"
    if (Test-Path $nmDir) {
        $bundledCount = (Get-ChildItem -Directory $nmDir -ErrorAction SilentlyContinue | Measure-Object).Count
        # 计入 scoped 包
        Get-ChildItem -Directory $nmDir -Filter "@*" -ErrorAction SilentlyContinue | ForEach-Object {
            $bundledCount += (Get-ChildItem -Directory $_.FullName -ErrorAction SilentlyContinue | Measure-Object).Count - 1
        }
        Write-Host "  bundled 依赖已就绪（${bundledCount} 个包）"
    } else {
        Write-Host "  ⚠️  未找到 bundled node_modules，尝试安装依赖..."
        Push-Location $STAGING_DIR
        try { & npm install --omit=dev --omit=peer --ignore-scripts --quiet 2>&1 | Out-Null } catch {}
        Pop-Location
    }

} finally {
    # 清理下载临时文件
    if (Test-Path $TMPDIR_PACK) { Remove-Item -Recurse -Force $TMPDIR_PACK -ErrorAction SilentlyContinue }
    if (Test-Path $EXTRACT_DIR) { Remove-Item -Recurse -Force $EXTRACT_DIR -ErrorAction SilentlyContinue }
}

# [2/3] 替换插件目录
Write-Host ""
Write-Host "[2/3] 替换插件目录..."
$TARGET_DIR = Join-Path $EXTENSIONS_DIR "openclaw-qqbot"
$OLD_DIR = Join-Path (Split-Path $EXTENSIONS_DIR -Parent) ".qqbot-upgrade-old"

if (Test-Path $OLD_DIR) { Remove-Item -Recurse -Force $OLD_DIR }

# Windows 无法做真正的原子 rename，但尽量缩短时间窗口
$STAGING_IN_EXT = Join-Path $EXTENSIONS_DIR ".openclaw-qqbot-new"
if (Test-Path $STAGING_IN_EXT) { Remove-Item -Recurse -Force $STAGING_IN_EXT }
Move-Item -Path $STAGING_DIR -Destination $STAGING_IN_EXT

if (Test-Path $TARGET_DIR) {
    Rename-Item -Path $TARGET_DIR -NewName (Split-Path $OLD_DIR -Leaf)
    # old dir 现在在 extensions 父目录的同级
    $actualOld = Join-Path (Split-Path $TARGET_DIR -Parent) (Split-Path $OLD_DIR -Leaf)
    if ((Test-Path $actualOld) -and ($actualOld -ne $OLD_DIR)) {
        Move-Item -Path $actualOld -Destination $OLD_DIR -ErrorAction SilentlyContinue
    }
}
Move-Item -Path $STAGING_IN_EXT -Destination $TARGET_DIR

if (Test-Path $OLD_DIR) { Remove-Item -Recurse -Force $OLD_DIR -ErrorAction SilentlyContinue }

# 清理残留目录
foreach ($leftover in @("openclaw-qqbot.staging", ".qqbot-upgrade-staging", ".qqbot-upgrade-old")) {
    $p = Join-Path $EXTENSIONS_DIR $leftover
    if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}
foreach ($legacyName in @("qqbot", "openclaw-qq")) {
    $p = Join-Path $EXTENSIONS_DIR $legacyName
    if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}
Write-Host "  已安装到: $TARGET_DIR"

# [3/3] 验证安装
Write-Host ""
Write-Host "[3/3] 验证安装..."
$NEW_VERSION = "unknown"
try {
    $newPkgPath = Join-Path $TARGET_DIR "package.json"
    if (Test-Path $newPkgPath) {
        $newPkg = Get-Content $newPkgPath -Raw | ConvertFrom-Json
        if ($newPkg.version) { $NEW_VERSION = $newPkg.version }
    }
} catch {}

Write-Host "QQBOT_NEW_VERSION=$NEW_VERSION"

if ($NEW_VERSION -ne "unknown") {
    Write-Host "QQBOT_REPORT=✅ QQBot 升级完成: v${NEW_VERSION}"
} else {
    Write-Host "QQBOT_REPORT=⚠️ QQBot 升级异常，无法确认新版本"
}

Write-Host ""
Write-Host "==========================================="
Write-Host "  ✅ 文件安装完成"
Write-Host "==========================================="

# --NoRestart 模式
if ($NoRestart) {
    Write-Host ""
    Write-Host "[跳过重启] -NoRestart 已指定，脚本立即退出以便调用方触发 gateway restart"
    exit 0
}

# [4/4] 配置 appid/secret
if ($AppId -and $Secret) {
    Write-Host ""
    Write-Host "[配置] 写入 qqbot 通道配置..."
    $DESIRED_TOKEN = "${AppId}:${Secret}"

    try {
        & $CMD channels add --channel qqbot --token $DESIRED_TOKEN 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✅ 通道配置写入成功"
        } else { throw "channels add failed" }
    } catch {
        Write-Host "  ⚠️  $CMD channels add 失败，尝试直接编辑配置文件..."
        $CONFIG_FILE = Join-Path $HOME_DIR ".$CMD" "$CMD.json"
        if (Test-Path $CONFIG_FILE) {
            try {
                $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
                if (-not $cfg.channels) { $cfg | Add-Member -NotePropertyName channels -NotePropertyValue @{} }
                if (-not $cfg.channels.qqbot) { $cfg.channels | Add-Member -NotePropertyName qqbot -NotePropertyValue @{} }
                $cfg.channels.qqbot | Add-Member -NotePropertyName appId -NotePropertyValue $AppId -Force
                $cfg.channels.qqbot | Add-Member -NotePropertyName clientSecret -NotePropertyValue $Secret -Force
                $cfg | ConvertTo-Json -Depth 10 | Set-Content $CONFIG_FILE -Encoding UTF8
                Write-Host "  ✅ 通道配置写入成功（直接编辑配置文件）"
            } catch {
                Write-Host "  ❌ 配置写入失败，请手动配置:" -ForegroundColor Red
                Write-Host "     $CMD channels add --channel qqbot --token `"${AppId}:${Secret}`""
            }
        }
    }
} elseif ($AppId -or $Secret) {
    Write-Host ""
    Write-Host "⚠️  -AppId 和 -Secret 必须同时提供" -ForegroundColor Yellow
}

# [5/5] 重启 gateway
Write-Host ""
Write-Host "[重启] 重启 gateway 使新版本生效..."
try {
    & $CMD gateway restart 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ gateway 已重启"
    } else { throw "restart failed" }
} catch {
    Write-Host "  ⚠️  gateway 重启失败，请手动执行: $CMD gateway restart" -ForegroundColor Yellow
}
