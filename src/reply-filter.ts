export interface DingTalkReplyPayloadFlags {
  isReasoning?: boolean;
  isStatusNotice?: boolean;
  isFallbackNotice?: boolean;
  isCompactionNotice?: boolean;
}

export function shouldDeliverDingTalkReply(
  payload: DingTalkReplyPayloadFlags,
  kind: "tool" | "block" | "final" | string,
): boolean {
  return (kind === "block" || kind === "final")
    && payload.isReasoning !== true
    && payload.isStatusNotice !== true
    && payload.isFallbackNotice !== true
    && payload.isCompactionNotice !== true;
}

export interface DingTalkReplySanitizeOptions {
  requireTaggedFinal?: boolean;
}

function normalizeDingTalkControlTags(text: string): string {
  return text
    .replace(/&lt;\s*(\/?)\s*dingtalk_final\s*&gt;/gi, "<$1dingtalk_final>")
    .replace(/\\<\s*(\/?)\s*dingtalk_final\s*\\>/gi, "<$1dingtalk_final>")
    .replace(/`+\s*(<\s*\/?\s*dingtalk_final\s*>)\s*`+/gi, "$1");
}

export function stripDingTalkControlTags(text: string): string {
  return normalizeDingTalkControlTags(text)
    .replace(/<\s*\/?\s*dingtalk_final\s*>/gi, "")
    .trim();
}

export function sanitizeDingTalkReplyText(
  text: string,
  options: DingTalkReplySanitizeOptions = {},
): string {
  if (!text) return text;

  let result = normalizeDingTalkControlTags(text).trim();
  const taggedFinal = result.match(/<dingtalk_final>\s*([\s\S]*?)\s*<\/dingtalk_final>/i);
  const hadTaggedFinal = taggedFinal !== null;
  if (options.requireTaggedFinal && !hadTaggedFinal) return "";
  if (taggedFinal) result = taggedFinal[1]?.trim() ?? "";
  result = stripDingTalkControlTags(result);
  if (
    /(?:^|\n)\s*(?:NO_REPLY|HEARTBEAT_OK)\s*$/.test(result)
    || /^\[assistant turn failed before producing content\]$/.test(result)
  ) {
    return "";
  }
  if (hadTaggedFinal) return result;
  if (
    /(?:我(?:不需要|无需)(?:回复|回应)|不需要我(?:回复|回应)|无需我(?:回复|回应)|不是在(?:向我)?求助我)/.test(result)
    || /(?:我需要(?:先|去)(?:下载|读取|查看|检查|调用|使用|分析|设置|创建)|让我(?:先|来)?(?:下载|读取|查看|检查|调用|分析)|我先(?:下载|读取|查看|检查|调用|分析))/.test(result)
    || /^(?:The user\b|Let me\b|I need to\b|I should\b|Looking at\b|This (?:is|has)\b)/i.test(result)
  ) {
    return "";
  }

  const original = result;
  result = result.replace(
    /^(?:我(?:来|先|就)?接(?:一)?句(?:话)?|(?:这句话|这话)(?:是说|的意思是|意思是|说的是|是在说))\s*[：:,，。-]*\s*/,
    "",
  );
  if (/^我(?:就)?不接(?:这个|这茬|这话题|这个话题)?\s*[。.!！]?\s*$/.test(result)) {
    return "";
  }

  const sentences = result.match(/[^。！？!?\n]+[。！？!?]?/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
  const metaPattern = /^(?:上一个|当前|这个)(?:话题|消息)(?:就是|是|说的是)|^(?:我(?:来|先|就)?接(?:一)?句(?:话)?|接(?:一)?句(?:就行|即可)|我(?:就)?不接(?:这个|这茬|这话题|这个话题)?|(?:简单)?总结一下)/;
  let lastMetaIndex = -1;
  for (let index = 0; index < sentences.length; index += 1) {
    if (metaPattern.test(sentences[index]!)) lastMetaIndex = index;
  }
  if (lastMetaIndex < 0) return result === original ? text : result;

  const selected = lastMetaIndex >= 0 && lastMetaIndex < sentences.length - 1
    ? sentences.slice(lastMetaIndex + 1)
    : sentences.filter((sentence) => !metaPattern.test(sentence));
  return selected
    .filter((sentence) => !/^[^=＝\n]{1,24}[=＝][^=＝\n]+[。.!！]?$/.test(sentence))
    .join("")
    .trim();
}
