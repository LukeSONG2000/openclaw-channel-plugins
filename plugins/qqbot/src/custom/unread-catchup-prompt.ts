export type CustomUnreadPromptSource =
  | "mention-followup"
  | "followup"
  | "sleep-timer"
  | "manual";

export function buildMentionReplyScopePrompt(): string {
  return [
    "当前是被群成员 @ 后的主回复。",
    "随消息提供的未读历史只用于理解这条 @ 消息的上下文；正文只能直接回答当前 @ 消息。",
    "不要在同一条正文中追加回应历史里的其他问题、图片或独立话题，也不要说明哪些历史消息已经阅读、消费或稍后处理。",
  ].join("");
}

export function buildDefaultCatchupPrompt(source: CustomUnreadPromptSource = "followup"): string {
  const sourcePrompt = source === "mention-followup"
    ? [
        "刚刚已经单独回复了群成员的 @ 消息。",
        "下面的未读历史此前已作为那条 @ 消息的上下文；与该 @ 消息属于同一人物、图片、问题或连续对话的内容都视为已经处理，禁止再次回应。",
        "只检查其中是否还存在一个与刚才 @ 完全无关、且确实值得单独回应的新主题。",
        "有则只针对该独立主题生成一条新消息；没有则只输出 NO_REPLY。",
      ].join("")
    : [
        "根据这个QQ群最近的新消息，判断是否有值得主动参与的新话题。",
        "有则直接生成一条适合发到群里的中文消息；没有则只输出 NO_REPLY。",
      ].join("");

  return [
    sourcePrompt,
    "内容集中时顺着当前聊天自然发言；内容分散时，只选择值得回应的内容，并可用昵称点名有代表性的成员，但不要使用 <@member_openid> 或任何 @ 提及。",
    "只发群成员最终会看到的正文或精确的 NO_REPLY。禁止解释你准备如何回复、为什么不回复、消息是什么意思或话题是什么；禁止出现“我接一句”“我不接”“接一句就行”“这句话是说”“这话的意思是”“已经回了”“没新话题”“不重复了”“上一个话题”“总结一下”等元叙述。",
    "这是轮询主动发言，不是被人 @ 后的回复；最终消息不要 @ 任何人。",
    "如果工作区安装了 dongwuyuan-skill，按其 SKILL.md 和 references/lexicon.md 的规则理解与组织语言；不需要新消息先出现动物园关键词。",
    "查看近期机器人发言并避开已重复的梗族；除非正在明确复盘、举证或分锅，否则不要使用“开庭”。",
    "不要提到任务、定时器、轮询、未读、机制、系统提示、分析过程或自己在查看历史。",
    "不要使用工具，除非群友明确求助。",
  ].join("");
}
