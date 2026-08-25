import assert from "node:assert";
import {
  buildUpstreamReviewMarkdown,
  classifyUpstreamChangedFile,
  parseCliArgs,
  parseNameStatus,
  parseRevListLeftRightCount,
} from "../scripts/inspect-upstream-updates.mjs";

assert.deepEqual(parseRevListLeftRightCount("92\t0\n"), {
  baseOnly: 92,
  upstreamOnly: 0,
});
assert.deepEqual(parseRevListLeftRightCount("bad value"), {
  baseOnly: 0,
  upstreamOnly: 0,
});

assert.deepEqual(parseNameStatus("M\tsrc/gateway.ts\nA\tsrc/custom/foo.ts\nR100\told.ts\tnew.ts\n"), [
  { status: "M", paths: ["src/gateway.ts"] },
  { status: "A", paths: ["src/custom/foo.ts"] },
  { status: "R100", paths: ["old.ts", "new.ts"] },
]);

assert.deepEqual(classifyUpstreamChangedFile(["src/gateway.ts"]), {
  path: "src/gateway.ts",
  risk: "gateway/slash/config surface",
});
assert.deepEqual(classifyUpstreamChangedFile(["docs/readme.md"]), {
  path: "docs/readme.md",
  risk: "docs only",
});

const noUpdate = buildUpstreamReviewMarkdown({
  baseRef: "custom-runtime",
  upstreamRef: "upstream/main",
  mergeBase: "7ceb7f0",
  generatedAt: "2026-06-21T00:00:00.000Z",
  baseOnly: 92,
  upstreamOnly: 0,
});
assert.equal(noUpdate.includes("No upstream-only commits were detected"), true);
assert.equal(noUpdate.includes("Custom branch only commits: 92"), true);
assert.equal(noUpdate.includes("Merge base: `7ceb7f0`"), true);

const update = buildUpstreamReviewMarkdown({
  baseRef: "custom-runtime",
  upstreamRef: "upstream/main",
  generatedAt: "2026-06-21T00:00:00.000Z",
  baseOnly: 3,
  upstreamOnly: 2,
  commits: ["abc123 fix gateway", "def456 update docs"],
  changedFiles: [
    { status: "M", paths: ["src/gateway.ts"] },
    { status: "M", paths: ["package.json"] },
  ],
});
assert.equal(update.includes("Upstream-Only Commits"), true);
assert.equal(update.includes("abc123 fix gateway"), true);
assert.equal(update.includes("src/gateway.ts: gateway/slash/config surface"), true);
assert.equal(update.includes("package.json: package/plugin identity"), true);
assert.equal(update.includes("do not merge or deploy automatically"), true);

assert.deepEqual(parseCliArgs([
  "--base", "custom-runtime",
  "--upstream=upstream/main",
  "--no-fetch",
  "--max-commits", "5",
  "--output", "report.md",
]), {
  baseRef: "custom-runtime",
  upstreamRef: "upstream/main",
  fetch: false,
  output: "report.md",
  maxCommits: 5,
  help: false,
});

console.log("upstream review script tests passed");
