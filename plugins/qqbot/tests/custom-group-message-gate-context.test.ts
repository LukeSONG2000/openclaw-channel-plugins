import assert from "node:assert";
import {
  buildCustomGroupMessageGateContext,
  hasAnyCustomGroupMention,
  normalizeGroupMessageContentForCommand,
  resolveCustomGroupImplicitMention,
  shouldHandleCustomTextCommands,
} from "../src/custom/group-message-gate-context.js";

assert.equal(normalizeGroupMessageContentForCommand("  /bot-ping  "), "/bot-ping");
assert.equal(shouldHandleCustomTextCommands({}), true);
assert.equal(shouldHandleCustomTextCommands({ commands: { text: false } }), false);
assert.equal(shouldHandleCustomTextCommands({ commands: { text: true } }), true);

assert.equal(hasAnyCustomGroupMention({ mentions: [{ member_openid: "MEMBER" }] }), true);
assert.equal(hasAnyCustomGroupMention({ content: "hi <@!12345>" }), true);
assert.equal(hasAnyCustomGroupMention({ content: "plain text" }), false);

assert.equal(resolveCustomGroupImplicitMention({
  refMsgIdx: "REF_BOT",
  getRefEntry: (idx) => idx === "REF_BOT" ? { isBot: true } : null,
}), true);
assert.equal(resolveCustomGroupImplicitMention({
  refMsgIdx: "REF_HUMAN",
  getRefEntry: () => ({ isBot: false }),
}), false);
assert.equal(resolveCustomGroupImplicitMention({ getRefEntry: () => ({ isBot: true }) }), false);

const baseGateParams = {
  content: "hello",
  wasMentioned: false,
  implicitMention: false,
  ignoreOtherMentions: false,
  allowTextCommands: true,
  isControlCommand: false,
  commandAuthorized: true,
  requireMention: true,
};

const noMention = buildCustomGroupMessageGateContext(baseGateParams);
assert.equal(noMention.contentForCommand, "hello");
assert.equal(noMention.hasAnyMention, false);
assert.equal(noMention.gate.action, "skip_no_mention");

const otherMention = buildCustomGroupMessageGateContext({
  ...baseGateParams,
  mentions: [{ member_openid: "OTHER_MEMBER" }],
  ignoreOtherMentions: true,
});
assert.equal(otherMention.hasAnyMention, true);
assert.equal(otherMention.gate.action, "drop_other_mention");

const unauthorizedCommand = buildCustomGroupMessageGateContext({
  ...baseGateParams,
  content: "/bot-scene set chat",
  isControlCommand: true,
  commandAuthorized: false,
});
assert.equal(unauthorizedCommand.gate.action, "block_unauthorized_command");

const authorizedCommandBypass = buildCustomGroupMessageGateContext({
  ...baseGateParams,
  content: "/bot-ping",
  isControlCommand: true,
  commandAuthorized: true,
});
assert.equal(authorizedCommandBypass.gate.action, "pass");
assert.equal(authorizedCommandBypass.gate.effectiveWasMentioned, true);
assert.equal(authorizedCommandBypass.gate.shouldBypassMention, true);

const implicitReply = buildCustomGroupMessageGateContext({
  ...baseGateParams,
  implicitMention: true,
});
assert.equal(implicitReply.gate.action, "pass");
assert.equal(implicitReply.gate.effectiveWasMentioned, true);

const syntheticCatchup = buildCustomGroupMessageGateContext({
  ...baseGateParams,
  mentions: [{ member_openid: "OTHER_MEMBER" }],
  ignoreOtherMentions: true,
  isCustomUnreadSynthetic: true,
});
assert.equal(syntheticCatchup.wasMentionedForGate, true);
assert.equal(syntheticCatchup.ignoreOtherMentionsForGate, false);
assert.equal(syntheticCatchup.requireMentionForGate, false);
assert.equal(syntheticCatchup.gate.action, "pass");

console.log("custom group message gate context tests passed");
