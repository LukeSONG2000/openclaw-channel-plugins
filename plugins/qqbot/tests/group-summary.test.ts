import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadGroupSummaryPrompt, parseGroupSummaryHours } from "../src/custom/group-summary.js";

test("group history summary recognizes an explicit, bounded current-group window", () => {
  assert.equal(parseGroupSummaryHours("总结一下 24h 内群里的聊天内容"), 24);
  assert.equal(parseGroupSummaryHours("帮我概括本群过去 6 小时的讨论"), 6);
  assert.equal(parseGroupSummaryHours("总结一下 25 小时群里的聊天"), undefined);
  assert.equal(parseGroupSummaryHours("总结我的私聊和其他群 24 小时的内容"), undefined);
});

test("group summary scopes account, group and time and caps what reaches the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qq-summary-"));
  try {
    const now = Date.now();
    function line(id: string, text: string, options?: { account?: string; group?: string; ageMs?: number; bot?: boolean }) {
      const message = { id, group_openid: options?.group ?? "peer-a", content: text, author: { bot: options?.bot } };
      return JSON.stringify({
        time: new Date(now - (options?.ageMs ?? 3_000)).toISOString(),
        "1": `[qqbot:${options?.account ?? "default"}] Dispatch event: t=GROUP_MESSAGE_CREATE, d=${JSON.stringify(message)}`,
      });
    }
    const latest = line("valid", "保留这一条 https://example.org/private");
    const lines = [
      ...Array.from({ length: 90 }, (_, i) => line(`id-${i}`, "字".repeat(500), { ageMs: 80_000 - i * 500 })),
      latest, latest, line("wrong-group", "GROUP_SECRET", { group: "peer-b" }),
      line("wrong-account", "ACCOUNT_SECRET", { account: "not-default" }),
      line("outside", "EXPIRED_TEXT", { ageMs: 25 * 60 * 60_000 }),
      line("is-bot", "BOT_TEXT", { bot: true }),
      line("self-request", "ORIGINAL_REQUEST"),
      line("credential", "我的密码是 private"),
    ];
    await writeFile(join(dir, "openclaw-2026-11-19.log"), lines.join("\n"));
    const result = await loadGroupSummaryPrompt({ accountId: "default", groupOpenid: "PEER-A",
      now, hours: 24, requestMessageId: "self-request", logDir: dir });
    assert.equal(result.count, 91);
    assert.equal(result.sampled, 6);
    assert.match(result.prompt, /保留这一条/);
    assert.doesNotMatch(result.prompt, /GROUP_SECRET|ACCOUNT_SECRET|EXPIRED_TEXT|BOT_TEXT|ORIGINAL_REQUEST|example\.org|我的密码/);
    assert.ok(result.prompt.length < 1200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
