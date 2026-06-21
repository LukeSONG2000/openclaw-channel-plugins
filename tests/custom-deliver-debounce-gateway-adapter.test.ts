import assert from "node:assert";
import { dispatchCustomDebouncedDeliver } from "../src/custom/deliver-debounce-gateway-adapter.js";

const delivered: Array<{ text?: string; kind: string }> = [];
let factoryCalls = 0;
let currentDebouncer: any = null;
const fakeDebouncer = {
  deliver: async (payload: { text?: string }, info: { kind: string }) => {
    delivered.push({ text: payload.text, kind: info.kind });
  },
};

const createdResult = await dispatchCustomDebouncedDeliver({
  accountId: "default",
  payload: { text: "hello" },
  info: { kind: "block" },
  currentDebouncer,
  setDebouncer: (debouncer) => { currentDebouncer = debouncer; },
  debounceConfig: { windowMs: 1 },
  executeDeliver: async () => {
    throw new Error("debounced path should not call direct executor");
  },
  createDebouncer: (_config, _executor, _log, prefix) => {
    factoryCalls += 1;
    assert.equal(prefix, "[qqbot:default:debounce]");
    return fakeDebouncer as any;
  },
});
assert.equal(createdResult.kind, "debounced");
assert.equal(createdResult.kind === "debounced" && createdResult.created, true);
assert.equal(currentDebouncer, fakeDebouncer);
assert.deepEqual(delivered, [{ text: "hello", kind: "block" }]);
assert.equal(factoryCalls, 1);

const reusedResult = await dispatchCustomDebouncedDeliver({
  accountId: "default",
  payload: { text: "again" },
  info: { kind: "block" },
  currentDebouncer,
  setDebouncer: (debouncer) => { currentDebouncer = debouncer; },
  debounceConfig: { windowMs: 1 },
  executeDeliver: async () => {
    throw new Error("reused debouncer should not call direct executor");
  },
  createDebouncer: () => {
    throw new Error("existing debouncer should be reused");
  },
});
assert.equal(reusedResult.kind, "debounced");
assert.equal(reusedResult.kind === "debounced" && reusedResult.created, false);
assert.deepEqual(delivered.at(-1), { text: "again", kind: "block" });

let directText = "";
let setDebouncerCalled = false;
const directResult = await dispatchCustomDebouncedDeliver({
  accountId: "default",
  payload: { text: "direct" },
  info: { kind: "block" },
  currentDebouncer: null,
  setDebouncer: (debouncer) => {
    setDebouncerCalled = true;
    assert.equal(debouncer, null);
  },
  debounceConfig: { enabled: false },
  executeDeliver: async (payload) => { directText = payload.text ?? ""; },
  createDebouncer: () => null,
});
assert.equal(directResult.kind, "direct");
assert.equal(directText, "direct");
assert.equal(setDebouncerCalled, true);

console.log("custom deliver debounce gateway adapter tests passed");
