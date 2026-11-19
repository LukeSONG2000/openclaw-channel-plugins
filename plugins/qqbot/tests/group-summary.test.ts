import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadGroupSummaryPrompt, parseGroupSummaryHours } from "../src/custom/group-summary.js";
import { boundConversationContext, loadGroupTextContext } from "../src/custom/group-text-context.js";

test("the context reader accepts arbitrary intervals and clamps end to the request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qq-context-"));
  try {
    const now = Date.parse("2026-11-19T16:03:00Z");
    const since = Date.parse("2026-11-20T00:00:00+08:00");
    const bound = boundConversationContext({ since, through: now + 5_000 }, now);
    assert.deepEqual(bound, { since, through: now });
    assert.equal(boundConversationContext({ since: now - 86_400_001 }, now), undefined);
    assert.equal(boundConversationContext({ since: now }, now), undefined);
    assert.deepEqual(boundConversationContext({ since: since + 5_000, through: since + 60_000 }, now),
      { since: since + 5_000, through: since + 60_000 });
    const line = (id: string, at: number, text: string, group = "local") => JSON.stringify({
      time: new Date(at).toISOString(),
      "1": `[qqbot:default] Dispatch event: t=GROUP_MESSAGE_CREATE, d=${JSON.stringify({ id, group_openid: group, content: text })}`,
    });
    const path = join(dir, "openclaw-2026-11-19.log");
    await writeFile(path, [
      line("prior", since - 1, "prior day"),
      line("today", since, "first minute"),
      line("other", since, "other group", "other"),
      line("source", now - 1, "the request"),
      line("later", now, "after or at request"),
    ].join("\n"));
    await utimes(path, new Date(now), new Date(now));
    const result = await loadGroupTextContext({ accountId: "default", groupOpenid: "local",
      requestMessageId: "source", since, through: now, logDir: dir });
    assert.deepEqual(result, { messages: [{ at: "00:00", text: "first minute" }], count: 1, limited: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
