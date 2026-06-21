import assert from "node:assert";
import { runQQBotGatewayStartupPreflight } from "../src/custom/startup-preflight-gateway-adapter.js";

{
  const logs: string[] = [];
  let apiLoggerSet = false;
  let markdownSupport: boolean | undefined;
  const result = await runQQBotGatewayStartupPreflight({
    account: {
      accountId: "default",
      markdownSupport: true,
      imageServerBaseUrl: "https://img.example.test",
    },
    cfg: { tts: true },
    log: {
      info: (msg) => logs.push(`info:${msg}`),
      error: (msg) => logs.push(`error:${msg}`),
    },
    getRuntime: () => ({
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: () => {},
        },
      },
    }),
    runDiagnostics: async () => ({ warnings: ["diagnostic warning"] }) as any,
    setApiLogger: () => { apiLoggerSet = true; },
    initApiConfig: (options) => { markdownSupport = options.markdownSupport; },
    resolveTTSConfig: () => ({
      apiKey: "abcd1234wxyz",
      model: "tts-model",
      voice: "voice-a",
      authStyle: "query",
      baseUrl: "https://tts.example.test",
      queryParams: { region: "test" },
      speed: 1.2,
    }) as any,
    ensureImageServer: async (_log, publicBaseUrl) => publicBaseUrl ?? null,
  });

  assert.deepEqual(result, { imageServerBaseUrl: "https://img.example.test", hasTTS: true });
  assert.equal(apiLoggerSet, true);
  assert.equal(markdownSupport, true);
  assert.equal(logs.some((line) => line.includes("diagnostic warning")), true);
  assert.equal(logs.some((line) => line.includes("Runtime module preflight: OK")), true);
  assert.equal(logs.some((line) => line.includes("abcd****wxyz")), true);
  assert.equal(logs.some((line) => line.includes("Image server enabled with URL: https://img.example.test")), true);
}

{
  const logs: string[] = [];
  const result = await runQQBotGatewayStartupPreflight({
    account: {
      accountId: "default",
      markdownSupport: false,
    },
    cfg: {},
    log: {
      info: (msg) => logs.push(`info:${msg}`),
      error: (msg) => logs.push(`error:${msg}`),
    },
    getRuntime: () => {
      throw new Error("runtime unavailable");
    },
    runDiagnostics: async () => ({ warnings: [] }) as any,
    setApiLogger: () => {},
    initApiConfig: () => {},
    resolveTTSConfig: () => null,
  });

  assert.deepEqual(result, { imageServerBaseUrl: null, hasTTS: false });
  assert.equal(logs.some((line) => line.includes("Runtime preflight failed: Error: runtime unavailable")), true);
  assert.equal(logs.some((line) => line.includes("TTS not configured")), true);
  assert.equal(logs.some((line) => line.includes("Image server disabled")), true);
}

console.log("custom startup preflight gateway adapter tests passed");
