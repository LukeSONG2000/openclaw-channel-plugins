import assert from "node:assert";
import {
  getUpdatePackageName,
  normalizeNpmPackageName,
  resolveConfiguredUpgradePackage,
} from "../src/update-checker.js";

assert.equal(normalizeNpmPackageName("lukesong/openclaw-qqbot"), "@lukesong/openclaw-qqbot");
assert.equal(normalizeNpmPackageName("@lukesong/openclaw-qqbot"), "@lukesong/openclaw-qqbot");
assert.equal(normalizeNpmPackageName("   "), null);

assert.equal(resolveConfiguredUpgradePackage(null), "@lukesong/luke-qqbot");
assert.equal(
  resolveConfiguredUpgradePackage({ upgradePkg: "custom/openclaw-qqbot" } as any),
  "@custom/openclaw-qqbot",
);

assert.equal(getUpdatePackageName(), "@lukesong/luke-qqbot");

console.log("update checker tests passed");
