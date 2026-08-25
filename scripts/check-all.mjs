import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const selected = process.argv[2];
const known = new Set(["qqbot", "dingtalk"]);

if (selected && !known.has(selected)) {
  console.error(`Unknown channel: ${selected}`);
  process.exit(2);
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function checkQQBot() {
  const cwd = path.join(root, "plugins", "qqbot");
  console.log("\n[qqbot] strict TypeScript check");
  run("npm", ["exec", "--", "tsc", "--noEmit"], cwd);

  console.log("\n[qqbot] tests");
  const testsDir = path.join(cwd, "tests");
  const tests = fs.readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.mjs"))
    .sort();
  const tsx = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  for (const test of tests) run(tsx, [path.join(testsDir, test)], cwd);
  console.log(`[qqbot] ${tests.length} test files passed`);
}

function checkDingTalk() {
  const cwd = path.join(root, "plugins", "dingtalk");
  console.log("\n[dingtalk] build and tests");
  run("npm", ["run", "build"], cwd);
  run("npm", ["test"], cwd);
}

if (!selected || selected === "qqbot") checkQQBot();
if (!selected || selected === "dingtalk") checkDingTalk();
