import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), "utf8");
const pkg = JSON.parse(read("package.json"));
assert.equal(pkg.name, "@lukesong/luke-qqbot");
assert.equal(pkg.openclaw.id, "openclaw-qqbot");
assert.equal(pkg.openclaw.channel.id, "qqbot");
assert.equal(pkg.repository.url, "git+https://github.com/LukeSONG2000/openclaw-channel-plugins.git");
assert.equal(pkg.repository.directory, "plugins/qqbot");
assert.equal(pkg.homepage, "https://github.com/LukeSONG2000/openclaw-channel-plugins/tree/main/plugins/qqbot");
const source = read("src/slash-commands.ts");
for (const extension of ["sh", "ps1"]) {
  assert.ok(source.includes(`https://raw.githubusercontent.com/LukeSONG2000/openclaw-channel-plugins/main/plugins/qqbot/scripts/upgrade-via-npm.${extension}`));
  assert.ok(fs.existsSync(fileURLToPath(new URL(`scripts/upgrade-via-npm.${extension}`, root))));
}
assert.ok(!source.includes("LukeSONG2000/openclaw-qqbot"));
assert.ok(source.includes("/docs/repository-migration.md"));
assert.ok(!read("scripts/upgrade-via-npm.ps1").includes('$PKG_NAME = "@tencent-connect/openclaw-qqbot"'));
assert.ok(read("scripts/upgrade-via-npm.sh").includes("${LOCAL_PKG_NAME:-@lukesong/luke-qqbot}"));
console.log("repository migration metadata and upgrade routing tests passed");
