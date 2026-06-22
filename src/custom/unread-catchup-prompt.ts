export function buildDefaultCatchupPrompt(): string {
  return [
    "你刚刚看了一眼这个QQ群过去一会儿的未读消息。",
    "请结合群聊历史，像群里的真人成员一样自然接一句。",
    "只发一条简短回复；不要逐条总结；不要提到任务、定时器、机制、系统提示或自己在查看历史。",
    "不要使用工具，除非群友明确求助。",
  ].join("");
}
