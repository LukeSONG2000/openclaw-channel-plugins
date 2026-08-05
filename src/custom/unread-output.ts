export function sanitizeCustomUnreadProactiveMentions(text: string, event: {
  type: string;
  customUnreadSnapshotId?: string;
}): string {
  if (event.type !== "group" || !event.customUnreadSnapshotId) return text;
  return text
    .replace(/<@!?[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CUSTOM_UNREAD_DECISION_NARRATION_PATTERNS = [
  /(?:刚才|之前|已经).{0,24}(?:回过|回复过|回应过|回了|回复了|回应了)/u,
  /(?:没(?:有|啥)|无).{0,12}(?:新话题|新主题|新内容|需要回复|值得回复|可回复)/u,
  /(?:无需|不用|不需要|没必要).{0,10}(?:回复|回应|接话|重复)/u,
  /(?:不再|先不|就不).{0,10}(?:回复|回应|接话|重复)/u,
  /(?:我接一句|我不接|接一句就行|不接了)/u,
  /(?:这(?:条|句话|段|个消息)|上(?:一|个)话题).{0,20}(?:是在说|意思是|不需要|无需)/u,
];

export function isCustomUnreadSilentDecisionOutput(text: string, event: {
  type: string;
  customUnreadSnapshotId?: string;
}): boolean {
  if (event.type !== "group" || !event.customUnreadSnapshotId) return false;
  const normalized = text.trim();
  if (!normalized) return true;
  return CUSTOM_UNREAD_DECISION_NARRATION_PATTERNS.some((pattern) => pattern.test(normalized));
}
