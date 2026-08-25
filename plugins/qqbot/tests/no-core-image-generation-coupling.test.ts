import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

const coreFiles = [
  "src/gateway.ts",
  "src/channel.ts",
  "src/reply-dispatcher.ts",
  "src/outbound-deliver.ts",
  "src/outbound.ts",
];

const bannedPatterns: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /skills\/codex-image-gen|codex-image-gen/,
    reason: "image generation skill must not be hardcoded into the QQBot connector core",
  },
  {
    pattern: /127\.0\.0\.1:7897|HTTP_PROXY|HTTPS_PROXY/i,
    reason: "image generation proxy settings belong to a dedicated skill/tool, not connector core",
  },
  {
    pattern: /child_process|spawn\(|execFile\(|exec\(/,
    reason: "connector core must not spawn an image generation worker directly",
  },
  {
    pattern: /generateImage|image\s+prompt|图片生成|异步生图|画图\s*[:：]/i,
    reason: "text-to-image prompt interception is out of scope for QQBot core",
  },
];

for (const file of coreFiles) {
  const fullPath = path.join(repoRoot, file);
  const source = fs.readFileSync(fullPath, "utf8");
  for (const banned of bannedPatterns) {
    assert.equal(
      banned.pattern.test(source),
      false,
      `${file}: ${banned.reason}`,
    );
  }
}

console.log("no core image generation coupling tests passed");
