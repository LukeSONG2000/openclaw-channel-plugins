import assert from "node:assert/strict";
import {
  mapQQBotGroupToolPolicy,
  QQBOT_RESTRICTED_TOOL_DENY,
} from "../src/group-tool-policy.js";

assert.equal(mapQQBotGroupToolPolicy("full"), undefined);
assert.deepEqual(mapQQBotGroupToolPolicy("none"), {
  allow: [],
  deny: ["*"],
});
assert.deepEqual(mapQQBotGroupToolPolicy("restricted"), {
  allow: [],
  deny: ["image", "zai-vision__*"],
});

const restricted = mapQQBotGroupToolPolicy("restricted");
assert.ok(restricted?.deny?.includes("image"));
assert.ok(restricted?.deny?.includes("zai-vision__*"));
assert.deepEqual(QQBOT_RESTRICTED_TOOL_DENY, ["image", "zai-vision__*"]);
