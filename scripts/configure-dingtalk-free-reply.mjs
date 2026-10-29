import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HEADING = "## DingTalk Default Group Replies";
const RULES = `${HEADING}

仅对 ddingtalk（钉钉）渠道的群聊生效：R2 默认自由交流，所有已接入群及以后新接入的群均无需先 @ 才能参与讨论。
被 @ 时回复当前消息；未被 @ 时沿用一分钟未读轮询，根据上下文参与有价值的话题，无需回复时静默。
只使用实际收到或有权限读取的消息，不猜测不可见历史，不绕过群成员身份和平台访问限制。
采用自然、专业的工作交流方式，不加载动物园词表或套用 QQ 玩梗风格，不输出思考或“是否接话”的解释。
自由交流只改变聊天参与策略，不授予工具、规则修改、定时任务或管理权限；原有管理员与授权流程保持不变。
不改变 QQ、飞书、网页或其他渠道的群聊策略，也不改变私聊规则。
`;

export function configureFreeReply(config) {
  const next = structuredClone(config);
  const channel = next.channels?.ddingtalk;
  if (!channel?.enabled) throw new Error("Enabled DingTalk channel required");
  if (Object.keys(channel.accounts ?? {}).length) throw new Error("Resolve R2 account before multi-account changes");
  channel.groupPolicy = "open";
  for (const group of Object.values(channel.groups ?? {})) group.enabled = true;
  return next;
}

export function scopeDefaultRules(text) {
  const start = text.indexOf(HEADING + "\n");
  if (start < 0) return text.trimEnd() + "\n\n" + RULES;
  const end = text.indexOf("\n## ", start + HEADING.length);
  return text.slice(0, start) + RULES + (end < 0 ? "" : text.slice(end));
}

export function applyDefaultFreeReply(root) {
  const configFile = join(root, "openclaw.json");
  const agentsFile = join(root, "workspace/AGENTS.md");
  const originals = [readFileSync(configFile, "utf8"), readFileSync(agentsFile, "utf8")];
  const config = configureFreeReply(JSON.parse(originals[0]));
  const outputs = [JSON.stringify(config, null, 2) + "\n", scopeDefaultRules(originals[1])];
  const backup = join(root, "backups", `dingtalk-default-free-${Date.now()}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  [configFile, agentsFile].forEach((file, i) => copyFileSync(file, join(backup, i === 0 ? "openclaw.json" : "AGENTS.md")));
  const installed = [];
  try {
    [configFile, agentsFile].forEach((file, i) => {
      if (readFileSync(file, "utf8") !== originals[i]) throw new Error("Concurrent configuration edit");
      const temp = file + ".dingtalk-free.tmp";
      writeFileSync(temp, outputs[i], { mode: 0o600 });
      renameSync(temp, file);
      installed.push(i);
    });
  } catch (error) {
    for (const i of installed.reverse()) {
      const file = i === 0 ? configFile : agentsFile;
      const temp = file + ".dingtalk-free.rollback.tmp";
      writeFileSync(temp, originals[i], { mode: 0o600 });
      renameSync(temp, file);
    }
    throw error;
  }
  return { groupPolicy: config.channels.ddingtalk.groupPolicy,
    configuredGroups: Object.keys(config.channels.ddingtalk.groups ?? {}).length,
    futureGroups: "free-by-default", authorizationChanged: false, backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== "--apply" || !process.argv[3]) throw new Error("Usage: --apply <openclaw-root>; stop gateway first");
  console.log(JSON.stringify(applyDefaultFreeReply(resolve(process.argv[3]))));
}
