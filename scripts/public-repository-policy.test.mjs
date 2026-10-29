import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
// New GitHub sources require an anonymous-public review before joining this list.
const publicRepos = new Set([
  "lukesong2000/openclaw-channel-plugins",
  "tencent-connect/openclaw-qqbot",
  "largezhou/openclaw-dingtalk",
  "tencent-connect/bot-docs",
  "whiskeysockets/libsignal-node",
  "actions/checkout",
  "actions/setup-node",
]);
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);

function githubRepositories(text) {
  return [...text.matchAll(/(?:https?:\/\/(?:github\.com|raw\.githubusercontent\.com|codeload\.github\.com)\/|git@github\.com:|github:)([\w.-]+)\/([\w.-]+)/g)]
    .map(m => `${m[1]}/${m[2].replace(/\.git$/, "")}`.toLowerCase())
    .filter(repo => !/^(?:sponsors|user-attachments)\//.test(repo));
}

test("first-party GitHub references use only reviewed public sources", () => {
  const failures = [];
  for (const file of files) {
    if (!/\.(?:md|json|[cm]?js|tsx?|ya?ml|toml|sh|py)$/.test(file) || file.endsWith("package-lock.json")) continue;
    for (const repo of githubRepositories(fs.readFileSync(path.join(root, file), "utf8"))) {
      // The retired fork is a rejected classification fixture, not a dependency.
      if (file === "plugins/qqbot/tests/custom-runtime-deploy-preflight.test.mjs"
          && repo === "lukesong2000/openclaw-qqbot") continue;
      if (!publicRepos.has(repo)) failures.push(`${file}: unreviewed GitHub source ${repo}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("package manifests and locks require neither private GitHub registries nor SSH access", () => {
  const failures = [];
  for (const file of files.filter(f => /(?:^|\/)package(?:-lock)?\.json$/.test(f))) {
    const visit = (value, field = "$") => {
      if (typeof value === "string") {
        if (/git\+ssh:|ssh:\/\/|git@github\.com|npm\.pkg\.github\.com/i.test(value)) failures.push(`${file}:${field}: authenticated transport`);
        if (/^(?:git\+|github:)/.test(value)) {
          const repos = githubRepositories(value);
          if (!repos.length || repos.some(repo => !publicRepos.has(repo))) failures.push(`${file}:${field}: unreviewed git dependency`);
        }
      } else if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${field}[${i}]`));
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) visit(v, `${field}.${k}`);
    };
    visit(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
  }
  assert.deepEqual(failures, []);
});

test("public free-reply documentation is self-contained and its local links exist", () => {
  const docs = ["README.md", "docs/free-reply.md", "docs/free-reply-architecture.md",
    "docs/free-reply-development-contract.md", "plugins/qqbot/docs/custom-runtime/free-reply.md",
    "plugins/dingtalk/docs/free-reply.md"];
  for (const file of docs) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(text.length > 500, `${file}: replace link-only stubs with public content`);
    for (const m of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = m[1];
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const resolved = path.resolve(root, path.dirname(file), decodeURIComponent(target.split("#")[0]));
      assert.ok(resolved.startsWith(root + path.sep), `${file}: link outside repository`);
      assert.ok(fs.existsSync(resolved), `${file}: missing ${target}`);
    }
  }
});

test("fork package metadata names the personal public monorepo", () => {
  for (const channel of ["qqbot", "dingtalk"]) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "plugins", channel, "package.json"), "utf8"));
    assert.equal(pkg.repository.url, "git+https://github.com/LukeSONG2000/openclaw-channel-plugins.git");
    assert.equal(pkg.repository.directory, `plugins/${channel}`);
  }
});

test("CI actions use reviewed public sources and channel code is not hidden in submodules", () => {
  for (const file of files.filter(f => f.startsWith(".github/") && /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(/^\s*(?:-\s*)?uses:\s*([\w.-]+)\/([\w.-]+)(?:\/[^@\s]*)?@/gm)) {
      assert.ok(publicRepos.has(`${m[1]}/${m[2]}`.toLowerCase()), `${file}: unreviewed action`);
    }
  }
  const gitlinks = execFileSync("git", ["ls-files", "--stage"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(line => line.startsWith("160000 "));
  assert.deepEqual(gitlinks, []);
});
