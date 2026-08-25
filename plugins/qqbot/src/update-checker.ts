/**
 * 版本检查器
 *
 * - triggerUpdateCheck(): gateway 启动时调用，后台预热缓存
 * - getUpdateInfo(): 每次实时查询 npm registry，返回最新结果
 *
 * 使用 HTTPS 直接请求 npm registry API（不依赖 npm CLI），
 * 支持多 registry fallback：npmjs.org → npmmirror.com，解决国内网络问题。
 */

import https from "node:https";
import { getPackageInfo } from "./utils/pkg-version.js";
import type { QQBotAccountConfig } from "./types.js";

const DEFAULT_OFFICIAL_PKG_NAME = "@tencent-connect/openclaw-qqbot";
const packageInfo = getPackageInfo(import.meta.url);
let CURRENT_VERSION = packageInfo.version;
let CURRENT_PKG_NAME = packageInfo.name || DEFAULT_OFFICIAL_PKG_NAME;

export interface UpdateInfo {
  packageName: string;
  current: string;
  /** 最佳升级目标（prerelease 用户优先 alpha，稳定版用户取 latest） */
  latest: string | null;
  /** 稳定版 dist-tag */
  stable: string | null;
  /** alpha dist-tag */
  alpha: string | null;
  hasUpdate: boolean;
  checkedAt: number;
  error?: string;
}

let _log: { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void } | undefined;
let _configuredPackageName: string | null = null;

function fetchJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { Accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`timeout fetching ${url}`)); });
  });
}

async function fetchDistTags(pkgName = getUpdatePackageName()): Promise<Record<string, string>> {
  for (const url of buildRegistries(pkgName)) {
    try {
      const json = await fetchJson(url, 10_000);
      const tags = json["dist-tags"];
      if (tags && typeof tags === "object") return tags;
    } catch (e: any) {
      _log?.debug?.(`[qqbot:update-checker] ${url} failed: ${e.message}`);
    }
  }
  throw new Error("all registries failed");
}

function buildUpdateInfo(tags: Record<string, string>, pkgName = getUpdatePackageName()): UpdateInfo {
  const currentIsPrerelease = CURRENT_VERSION.includes("-");
  const stableTag = tags.latest || null;
  const alphaTag = tags.alpha || null;

  // alpha 用户优先跟 alpha；普通二开后缀（如 luke.1）如果没有 alpha tag，仍跟 latest。
  const compareTarget = currentIsPrerelease && alphaTag ? alphaTag : stableTag;

  const hasUpdate = typeof compareTarget === "string"
    && compareTarget !== CURRENT_VERSION
    && compareVersions(compareTarget, CURRENT_VERSION) > 0;

  return {
    packageName: pkgName,
    current: CURRENT_VERSION,
    latest: compareTarget,
    stable: stableTag,
    alpha: alphaTag,
    hasUpdate,
    checkedAt: Date.now(),
  };
}

export function normalizeNpmPackageName(pkgName?: string | null): string | null {
  const trimmed = String(pkgName ?? "").trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

export function getUpdatePackageName(): string {
  return _configuredPackageName || CURRENT_PKG_NAME || DEFAULT_OFFICIAL_PKG_NAME;
}

export function resolveConfiguredUpgradePackage(accountConfig?: QQBotAccountConfig | null): string {
  return normalizeNpmPackageName(accountConfig?.upgradePkg) || CURRENT_PKG_NAME || DEFAULT_OFFICIAL_PKG_NAME;
}

/** gateway 启动时调用，保存 log 引用并设置当前实例的检查包名 */
export function triggerUpdateCheck(log?: {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}, accountConfig?: QQBotAccountConfig | null): void {
  if (log) _log = log;
  _configuredPackageName = resolveConfiguredUpgradePackage(accountConfig);
  // 预热：fire-and-forget
  getUpdateInfo().then((info) => {
    if (info.hasUpdate) {
      _log?.info?.(`[qqbot:update-checker] new ${info.packageName} version available: ${info.latest} (current: ${CURRENT_VERSION})`);
    }
  }).catch(() => {});
}

/** 每次实时查询 npm registry */
export async function getUpdateInfo(pkgName?: string | null): Promise<UpdateInfo> {
  const resolvedPkgName = normalizeNpmPackageName(pkgName) || getUpdatePackageName();
  try {
    const tags = await fetchDistTags(resolvedPkgName);
    return buildUpdateInfo(tags, resolvedPkgName);
  } catch (err: any) {
    _log?.debug?.(`[qqbot:update-checker] check failed: ${err.message}`);
    return { packageName: resolvedPkgName, current: CURRENT_VERSION, latest: null, stable: null, alpha: null, hasUpdate: false, checkedAt: Date.now(), error: err.message };
  }
}

/**
 * 检查指定版本是否存在于 npm registry
 * 用于 /bot-upgrade --version 的前置校验
 * @param version 要检查的版本号
 * @param pkgName 可选的包名（如 "@ryantest/openclaw-qqbot"），默认使用内置包名
 */
export async function checkVersionExists(version: string, pkgName?: string): Promise<boolean> {
  const registries = buildRegistries(normalizeNpmPackageName(pkgName) || getUpdatePackageName());
  for (const baseUrl of registries) {
    try {
      const url = `${baseUrl}/${version}`;
      const json = await fetchJson(url, 10_000);
      if (json && json.version === version) return true;
    } catch {
      // try next registry
    }
  }
  return false;
}

/** 根据自定义包名构建 registry URL 列表 */
function buildRegistries(pkgName: string): string[] {
  const encoded = encodeURIComponent(pkgName);
  return [
    `https://registry.npmjs.org/${encoded}`,
    `https://registry.npmmirror.com/${encoded}`,
  ];
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.replace(/^v/, "");
    const [main, pre] = clean.split("-", 2);
    return { parts: main.split(".").map(Number), pre: pre || null };
  };
  const pa = parse(a);
  const pb = parse(b);
  // 先比主版本号
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff;
  }
  // 主版本号相同：正式版 > prerelease
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && !pb.pre) return 0;
  // 都是 prerelease：按段逐一比较（alpha.1 vs alpha.2）
  const aParts = pa.pre!.split(".");
  const bParts = pb.pre!.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aP = aParts[i] ?? "";
    const bP = bParts[i] ?? "";
    const aNum = Number(aP);
    const bNum = Number(bP);
    // 都是数字则按数字比较
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      // 字符串比较
      if (aP < bP) return -1;
      if (aP > bP) return 1;
    }
  }
  return 0;
}
