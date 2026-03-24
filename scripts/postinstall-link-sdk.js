#!/usr/bin/env node

// When installed as an openclaw extension under ~/.openclaw/extensions/,
// the plugin needs access to `openclaw/plugin-sdk` at runtime.
// openclaw's jiti loader resolves this via alias by walking up from the plugin
// path to find the openclaw package root — but ~/.openclaw/extensions/ is not
// under the openclaw package tree, so the alias lookup fails.
//
// This script creates a symlink from the plugin's node_modules/openclaw to the
// globally installed openclaw package, allowing Node's native ESM resolver
// (used by jiti with tryNative:true for .js files) to find `openclaw/plugin-sdk`.

import { existsSync, symlinkSync, mkdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, "..");

// Only run when installed under .openclaw/extensions/
if (!pluginRoot.includes(".openclaw") && !pluginRoot.includes("extensions")) {
  process.exit(0);
}

const linkTarget = join(pluginRoot, "node_modules", "openclaw");

// Already linked or exists
if (existsSync(linkTarget)) {
  process.exit(0);
}

// Find the global openclaw installation
let openclawRoot = null;
try {
  // Try require.resolve from global context
  const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
  const candidate = join(globalRoot, "openclaw");
  if (existsSync(join(candidate, "package.json"))) {
    openclawRoot = candidate;
  }
} catch {}

if (!openclawRoot) {
  try {
    // Try resolving from the openclaw CLI binary
    const bin = execSync("which openclaw", { encoding: "utf-8" }).trim();
    // bin is typically <prefix>/bin/openclaw -> ../lib/node_modules/openclaw/...
    const candidate = resolve(dirname(bin), "..", "lib", "node_modules", "openclaw");
    if (existsSync(join(candidate, "package.json"))) {
      openclawRoot = candidate;
    }
  } catch {}
}

if (!openclawRoot) {
  // Not fatal — plugin may work if openclaw loads it with proper alias resolution
  process.exit(0);
}

try {
  mkdirSync(join(pluginRoot, "node_modules"), { recursive: true });
  symlinkSync(openclawRoot, linkTarget, "junction");
} catch {
  // Silently ignore — symlink creation may fail on some systems
}
