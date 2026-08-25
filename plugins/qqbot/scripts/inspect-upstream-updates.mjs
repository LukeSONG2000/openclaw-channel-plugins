#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_REF = "custom-runtime";
const DEFAULT_UPSTREAM_REF = "upstream/main";

export function parseRevListLeftRightCount(raw) {
  const [leftRaw = "0", rightRaw = "0"] = String(raw ?? "").trim().split(/\s+/);
  const left = Number.parseInt(leftRaw, 10);
  const right = Number.parseInt(rightRaw, 10);
  return {
    baseOnly: Number.isFinite(left) ? left : 0,
    upstreamOnly: Number.isFinite(right) ? right : 0,
  };
}

export function parseNameStatus(raw) {
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status = "", ...paths] = line.split(/\t+/);
      return { status, paths };
    });
}

export function classifyUpstreamChangedFile(paths) {
  const joined = paths.join(" -> ");
  if (paths.some((p) => p === "package.json" || p === "openclaw.plugin.json")) return { path: joined, risk: "package/plugin identity" };
  if (paths.some((p) => p.startsWith("src/custom/"))) return { path: joined, risk: "custom runtime overlap" };
  if (paths.some((p) => p === "src/gateway.ts" || p === "src/slash-commands.ts" || p === "src/types.ts")) return { path: joined, risk: "gateway/slash/config surface" };
  if (paths.some((p) => p === "src/api.ts" || p === "src/outbound.ts" || p === "src/outbound-deliver.ts" || p.startsWith("src/transport/"))) return { path: joined, risk: "QQ transport/send surface" };
  if (paths.some((p) => p.startsWith("scripts/upgrade-"))) return { path: joined, risk: "upgrade script" };
  if (paths.some((p) => p.startsWith("docs/"))) return { path: joined, risk: "docs only" };
  return { path: joined, risk: "review" };
}

export function buildUpstreamReviewMarkdown(input) {
  const baseRef = input.baseRef || DEFAULT_BASE_REF;
  const upstreamRef = input.upstreamRef || DEFAULT_UPSTREAM_REF;
  const generatedAt = input.generatedAt || new Date().toISOString();
  const baseOnly = input.baseOnly ?? 0;
  const upstreamOnly = input.upstreamOnly ?? 0;
  const mergeBase = input.mergeBase;
  const commits = input.commits ?? [];
  const files = input.changedFiles ?? [];
  const risks = files
    .map((file) => classifyUpstreamChangedFile(file.paths))
    .filter((item, index, all) => all.findIndex((other) => other.path === item.path) === index);

  const lines = [
    `# QQBot Official Upstream Review`,
    ``,
    `Generated at: ${generatedAt}`,
    `Base ref: \`${baseRef}\``,
    `Upstream ref: \`${upstreamRef}\``,
    ...(mergeBase ? [`Merge base: \`${mergeBase}\``] : []),
    ``,
    `## Summary`,
    ``,
    `- Custom branch only commits: ${baseOnly}`,
    `- Upstream-only commits: ${upstreamOnly}`,
    `- Safe default: do not merge or deploy automatically.`,
    ``,
  ];

  if (upstreamOnly === 0) {
    lines.push(
      `## Decision`,
      ``,
      `No upstream-only commits were detected. No official update merge is needed right now.`,
      ``,
    );
  } else {
    lines.push(
      `## Decision Checklist`,
      ``,
      `- Read the upstream-only commit list and changed-file risk hints.`,
      `- Decide whether any official change is worth adopting into \`${baseRef}\`.`,
      `- Prefer cherry-pick for small safe fixes; use merge only after reviewing conflicts.`,
      `- Preserve \`src/custom/*\`, personal package identity, and the no-auto-install update policy.`,
      `- Run build/tests before publishing a new personal package.`,
      ``,
      `## Upstream-Only Commits`,
      ``,
      ...commits.map((commit) => `- ${commit}`),
      ...(commits.length ? [] : [`- (commit list not available)`]),
      ``,
      `## Changed Files`,
      ``,
      ...files.map((file) => `- ${file.status} ${file.paths.join(" -> ")}`),
      ...(files.length ? [] : [`- (changed-file list not available)`]),
      ``,
      `## Risk Hints`,
      ``,
      ...risks.map((risk) => `- ${risk.path}: ${risk.risk}`),
      ...(risks.length ? [] : [`- (no changed files to classify)`]),
      ``,
    );
  }

  lines.push(
    `## Commands`,
    ``,
    "```bash",
    `git fetch ${remoteNameFromRef(upstreamRef)} --prune`,
    `git merge-base ${baseRef} ${upstreamRef}`,
    `git log --oneline --decorate ${baseRef}..${upstreamRef}`,
    `git diff --stat $(git merge-base ${baseRef} ${upstreamRef})..${upstreamRef}`,
    "```",
    ``,
  );

  return `${lines.join("\n")}\n`;
}

export function parseCliArgs(argv) {
  const args = {
    baseRef: DEFAULT_BASE_REF,
    upstreamRef: DEFAULT_UPSTREAM_REF,
    fetch: true,
    output: "",
    maxCommits: 30,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--base") args.baseRef = readValue();
    else if (arg.startsWith("--base=")) args.baseRef = arg.slice("--base=".length);
    else if (arg === "--upstream") args.upstreamRef = readValue();
    else if (arg.startsWith("--upstream=")) args.upstreamRef = arg.slice("--upstream=".length);
    else if (arg === "--output" || arg === "-o") args.output = readValue();
    else if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
    else if (arg === "--max-commits") args.maxCommits = Number.parseInt(readValue(), 10);
    else if (arg.startsWith("--max-commits=")) args.maxCommits = Number.parseInt(arg.slice("--max-commits=".length), 10);
    else if (arg === "--no-fetch") args.fetch = false;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isFinite(args.maxCommits) || args.maxCommits < 1) args.maxCommits = 30;
  return args;
}

export function usage() {
  return [
    `Usage: node scripts/inspect-upstream-updates.mjs [options]`,
    ``,
    `Options:`,
    `  --base <ref>          Local custom branch/ref. Default: ${DEFAULT_BASE_REF}`,
    `  --upstream <ref>      Official upstream ref. Default: ${DEFAULT_UPSTREAM_REF}`,
    `  --no-fetch            Use existing local refs without fetching upstream first.`,
    `  --max-commits <n>     Max upstream-only commits to list. Default: 30`,
    `  --output <path>       Write markdown report to a file instead of stdout.`,
    ``,
  ].join("\n");
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (args.fetch) {
    git(["fetch", remoteNameFromRef(args.upstreamRef), "--prune"]);
  }
  const counts = parseRevListLeftRightCount(git(["rev-list", "--left-right", "--count", `${args.baseRef}...${args.upstreamRef}`]));
  const mergeBase = git(["merge-base", args.baseRef, args.upstreamRef]);
  const commits = git(["log", "--oneline", "--decorate", `--max-count=${args.maxCommits}`, `${args.baseRef}..${args.upstreamRef}`])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const changedFiles = parseNameStatus(git(["diff", "--name-status", `${mergeBase}..${args.upstreamRef}`]));
  const markdown = buildUpstreamReviewMarkdown({
    baseRef: args.baseRef,
    upstreamRef: args.upstreamRef,
    mergeBase,
    generatedAt: new Date().toISOString(),
    baseOnly: counts.baseOnly,
    upstreamOnly: counts.upstreamOnly,
    commits,
    changedFiles,
  });
  if (args.output) {
    fs.writeFileSync(args.output, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
  return 0;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function remoteNameFromRef(ref) {
  const value = String(ref ?? "").trim();
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : "upstream";
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
