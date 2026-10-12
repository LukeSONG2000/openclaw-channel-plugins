import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const GROUP_ID = "cidP9iui5pxwqeOqU++SQu5Ug==";
const FREE_GROUP_POLICY = "本群为工作场景自由回复群，不要求成员先 @ 机器人。根据实际收到或有权限读取的未读消息参与有价值的话题，无需回复时静默；不得猜测不可见的历史。采用自然、专业、清晰的工作用语，不使用动物园梗或 QQ 的玩梗风格。工具调用和管理操作仍遵守原有鉴权，不因自由回复获得额外权限。";
const SCOPE = "OpenClaw 中本技能仅适用于 `qqbot` 的群聊、私聊和主动轮询回复。钉钉、飞书、网页及其他渠道不得加载词表或沿用 QQ 的动物园表达；已有会话曾使用本技能也不能绕过渠道限制。渠道未知时不启用。以下理解与生成流程仅在 QQ 渠道生效，不改变其他运行环境的使用方式。";

export function configureChannels(config) {
  const next = structuredClone(config);
  if (!next.channels?.ddingtalk) throw new Error("Missing ddingtalk channel");
  const channel = next.channels.ddingtalk;
  channel.groups ??= {};
  const group = channel.groups[GROUP_ID] ?? {};
  channel.groups[GROUP_ID] = {
    ...group,
    enabled: true,
    systemPrompt: group.systemPrompt?.includes(FREE_GROUP_POLICY)
      ? group.systemPrompt
      : [group.systemPrompt, FREE_GROUP_POLICY].filter(Boolean).join("\n\n"),
  };
  next.skills ??= {};
  next.skills.entries ??= {};
  // QQ's preflight reads the files directly; do not advertise them globally.
  next.skills.entries["dongwuyuan-skill"] = {
    ...next.skills.entries["dongwuyuan-skill"], enabled: false,
  };
  return next;
}

export function scopeAgentsRules(text) {
  const start = text.indexOf("## Mandatory Dongwuyuan Preflight\n");
  if (start < 0) throw new Error("Missing mandatory preflight section");
  const end = text.indexOf("\n## ", start + 1);
  if (end < 0) throw new Error("Missing next AGENTS section");
  const section = [
    "## Mandatory Dongwuyuan Preflight",
    "",
    "This preflight applies ONLY to the qqbot channel (group chat, private chat, and polling).",
    "For QQ Chinese replies, read `skills/dongwuyuan/SKILL.md` and follow its current",
    "understanding and generation workflow using `references/lexicon.md`.",
    "Never expose lookup, candidate selection, or reasoning in the visible reply.",
    "",
    "For DingTalk, Feishu, webchat, and all other channels, DO NOT load or use this skill",
    "or lexicon. Use natural, professional workplace language. Old QQ examples, skill",
    "reads, conversation summaries, and earlier meme-style replies do not override",
    "this channel restriction. An unknown channel must not enable this preflight.",
    "",
  ].join("\n");
  return text.slice(0, start) + section + text.slice(end);
}

export function scopeSkill(text) {
  if (text.includes("## OpenClaw 渠道范围")) return text;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Missing skill frontmatter boundary");
  const offset = end + "\n---\n".length;
  return text.slice(0, offset) + `\n## OpenClaw 渠道范围\n\n${SCOPE}\n` + text.slice(offset);
}

export function clearNonQQSnapshots(sessions) {
  const next = structuredClone(sessions);
  let cleared = 0;
  for (const [key, session] of Object.entries(next)) {
    if (/^agent:[^:]+:qqbot:/i.test(key)) continue;
    if (JSON.stringify(session.skillsSnapshot ?? {}).includes("dongwuyuan")) {
      delete session.skillsSnapshot;
      cleared++;
    }
  }
  return { sessions: next, cleared };
}

export function applyConfiguration(root) {
  const paths = ["openclaw.json", "workspace/AGENTS.md", "workspace/skills/dongwuyuan/SKILL.md", "agents/main/sessions/sessions.json"];
  const originals = paths.map((path) => readFileSync(join(root, path), "utf8"));
  const result = clearNonQQSnapshots(JSON.parse(originals[3]));
  const outputs = [
    JSON.stringify(configureChannels(JSON.parse(originals[0])), null, 2) + "\n",
    scopeAgentsRules(originals[1]),
    scopeSkill(originals[2]),
    JSON.stringify(result.sessions, null, 2) + "\n",
  ];
  const backup = join(root, "backups", `dingtalk-channel-scope-${Date.now()}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  paths.forEach((path, index) => {
    mkdirSync(dirname(join(backup, path)), { recursive: true, mode: 0o700 });
    copyFileSync(join(root, path), join(backup, path));
    const temporary = join(root, `${path}.channel-scope.tmp`);
    writeFileSync(temporary, outputs[index], { mode: 0o600 });
    renameSync(temporary, join(root, path));
  });
  return { groupId: GROUP_ID, clearedSnapshots: result.cleared, backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes("--apply")) throw new Error("Stop the gateway first, then pass --apply [openclaw-root]");
  const root = process.argv[process.argv.indexOf("--apply") + 1] ?? join(homedir(), ".openclaw");
  console.log(JSON.stringify(applyConfiguration(root)));
}
