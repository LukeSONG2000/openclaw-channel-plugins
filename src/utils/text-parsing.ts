/**
 * QQ Bot 文本解析工具函数
 */

import type { RefAttachmentSummary } from "../ref-index-store.js";
import { inferAttachmentType } from "../group-history.js";
import { MSG_TYPE_QUOTE } from "../types.js";

/**
 * 解析 QQ 表情标签，将 <faceType=1,faceId="13",ext="base64..."> 格式
 * 替换为 【表情: 中文名】 格式
 * ext 字段为 Base64 编码的 JSON，格式如 {"text":"呲牙"}
 */
export function parseFaceTags(text: string): string {
  if (!text) return text;

  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
    try {
      const decoded = Buffer.from(ext, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      const faceName = parsed.text || "未知表情";
      return `【表情: ${faceName}】`;
    } catch {
      return _match;
    }
  });
}

/**
 * 过滤内部标记（如 [[reply_to: xxx]]）
 * 这些标记可能被 AI 错误地学习并输出，需要在发送前移除
 */
export function filterInternalMarkers(text: string): string {
  if (!text) return text;
  
  let result = text.replace(/\[\[[a-z_]+:\s*[^\]]*\]\]/gi, "");
  // OpenClaw may prepend model fallback diagnostics; chat users only need the answer.
  result = result.replace(/^↪️\s*Model Fallback:[\s\S]*?(?:\n\s*---\s*\n+|\n{2,})(?=\S)/, "");
  // 过滤框架内部图片引用标记：@image:image_xxx.png、@voice:voice_xxx.silk 等
  result = result.replace(/@(?:image|voice|video|file):[a-zA-Z0-9_.-]+/g, "");
  result = filterChatMetaNarration(result);
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  
  return result;
}

/**
 * Remove occasional model narration about how it plans to answer a chat.
 * This is deliberately limited to unmistakable meta phrases and short
 * "term = explanation" notes so ordinary conversational prose is preserved.
 */
export function filterChatMetaNarration(text: string): string {
  if (!text) return text;

  let result = text.trim();
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

/** 从 ext 和 msg_elements 中解析引用索引，仅 MSG_TYPE_QUOTE 时取 msg_elements */
export function parseRefIndices(
  ext?: string[],
  messageType?: number,
  msgElements?: Array<{ msg_idx?: string }>,
): { refMsgIdx?: string; msgIdx?: string } {
  let refMsgIdx: string | undefined;
  let msgIdx: string | undefined;
  if (ext && ext.length > 0) {
    for (const item of ext) {
      if (item.startsWith("ref_msg_idx=")) {
        refMsgIdx = item.slice("ref_msg_idx=".length);
      } else if (item.startsWith("msg_idx=")) {
        msgIdx = item.slice("msg_idx=".length);
      }
    }
  }
  // 仅当 message_type=MSG_TYPE_QUOTE（引用消息）时，msg_elements[0].msg_idx 更权威，有值时覆盖 ext 解析结果
  if (messageType === MSG_TYPE_QUOTE) {
    const refElement = msgElements?.[0];
    if (refElement?.msg_idx) {
      refMsgIdx = refElement.msg_idx;
    }
  }
  return { refMsgIdx, msgIdx };
}

/**
 * 从附件列表中构建附件摘要（用于引用索引缓存）
 */
export function buildAttachmentSummaries(
  attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string }>,
  localPaths?: Array<string | null>,
): RefAttachmentSummary[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((att, idx) => ({
    type: inferAttachmentType(att.content_type),
    filename: att.filename,
    contentType: att.content_type,
    localPath: localPaths?.[idx] ?? undefined,
  }));
}
