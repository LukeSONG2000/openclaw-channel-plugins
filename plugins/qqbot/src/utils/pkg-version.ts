/**
 * 从 import.meta.url 向上遍历目录树查找 package.json 并读取包信息。
 * 不依赖硬编码的 "../" 层级，无论编译输出结构如何变化都能可靠找到。
 */

import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

/** 已定位到的 package.json 路径，避免重复遍历目录树 */
let _resolvedPkgPath: string | null = null;

export interface PackageInfo {
  name: string;
  version: string;
  path?: string;
}

function normalizePackageInfo(pkg: unknown, pkgPath?: string): PackageInfo | null {
  if (!pkg || typeof pkg !== "object") return null;
  const record = pkg as { name?: unknown; version?: unknown };
  const name = typeof record.name === "string" ? record.name : "";
  const version = typeof record.version === "string" ? record.version : "";
  if (!version) return null;
  return { name, version, path: pkgPath };
}

export function getPackageInfo(metaUrl?: string): PackageInfo {
  // 如果之前已定位到 package.json 路径，直接重新读取（快速路径）
  if (_resolvedPkgPath) {
    try {
      const pkg = JSON.parse(fs.readFileSync(_resolvedPkgPath, "utf8"));
      const info = normalizePackageInfo(pkg, _resolvedPkgPath);
      if (info) return info;
    } catch {
      // 文件可能已被删除（升级过程中），清除路径缓存，走完整查找
      _resolvedPkgPath = null;
    }
  }

  // Strategy 1: 从调用者的 import.meta.url（或本模块）向上遍历找 package.json
  const startFile = metaUrl ? fileURLToPath(metaUrl) : fileURLToPath(import.meta.url);
  let dir = path.dirname(startFile);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, "package.json");
    try {
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
        const info = normalizePackageInfo(pkg, candidate);
        if (info) {
          _resolvedPkgPath = candidate;
          return info;
        }
      }
    } catch {
      // ignore and try parent
    }
    dir = path.dirname(dir);
  }

  // Strategy 2: fallback 用 createRequire 尝试常见相对路径
  try {
    const require = createRequire(metaUrl ?? import.meta.url);
    for (const rel of ["../../package.json", "../package.json", "./package.json"]) {
      try {
        const pkg = require(rel);
        const info = normalizePackageInfo(pkg);
        if (info) return info;
      } catch { /* next */ }
    }
  } catch { /* fallback */ }

  return { name: "", version: "unknown" };
}

export function getPackageVersion(metaUrl?: string): string {
  return getPackageInfo(metaUrl).version;
}

export function getPackageName(metaUrl?: string): string {
  return getPackageInfo(metaUrl).name;
}
