import assert from "node:assert";
import { CustomFallbackDispatchState } from "../src/custom/fallback-dispatch-state.js";

const state = new CustomFallbackDispatchState();
assert.equal(state.hasResponse, false);
assert.equal(state.shouldSendToolFallbackOnComplete(), false);

state.markResponse();
assert.equal(state.hasResponse, true);
assert.equal(state.snapshot().hasBlockResponse, false);

const firstTool = state.observeToolDeliver({
  text: "  tool text  ",
  mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
  mediaUrl: "https://example.com/a.png",
});
assert.equal(firstTool.toolDeliverCount, 1);
assert.equal(firstTool.toolTextChars, 9);
assert.equal(firstTool.toolMediaCount, 2);
assert.deepEqual(state.toolTexts, ["tool text"]);
assert.deepEqual(state.toolMediaUrls, ["https://example.com/a.png", "https://example.com/b.png"]);
assert.equal(state.shouldSendToolFallbackOnComplete(), true);

const secondTool = state.observeToolDeliver({});
assert.equal(secondTool.toolDeliverCount, 2);
assert.equal(state.snapshot().toolTextCount, 1);
assert.equal(state.snapshot().toolMediaCount, 2);

assert.deepEqual(state.shouldRenewToolOnlyTimer(2), { renew: true, renewalCount: 1 });
assert.deepEqual(state.shouldRenewToolOnlyTimer(2), { renew: true, renewalCount: 2 });
assert.deepEqual(state.shouldRenewToolOnlyTimer(2), { renew: false, renewalCount: 2 });

state.recordBlockDeliveredMedia({ mediaUrl: "https://example.com/a.png" });
state.markBlockResponse();
assert.equal(state.hasBlockResponse, true);
assert.equal(state.hasModelBlockOutput, true);
assert.equal(state.shouldSendToolFallbackOnComplete(), false);

const consumed = state.consumeToolMediaForImmediateForward();
assert.deepEqual(consumed.urlsToSend, ["https://example.com/b.png"]);
assert.equal(consumed.skippedCount, 1);
assert.deepEqual(state.toolMediaUrls, []);

state.markDispatchTimedOut();
assert.equal(state.dispatchTimedOut, true);

state.markToolFallbackSent();
assert.equal(state.toolFallbackSent, true);
assert.equal(state.snapshot().toolFallbackSent, true);

const noModelOutput = new CustomFallbackDispatchState();
noModelOutput.markBlockResponse({ modelOutput: false });
assert.equal(noModelOutput.hasBlockResponse, true);
assert.equal(noModelOutput.hasModelBlockOutput, false);

const modelSkip = new CustomFallbackDispatchState();
modelSkip.markModelSkipOutput();
assert.equal(modelSkip.hasResponse, true);
assert.equal(modelSkip.hasModelSkipOutput, true);
assert.equal(modelSkip.hasModelBlockOutput, false);

console.log("custom fallback dispatch state tests passed");
