import type { ToolPolicy } from "./types.js";

export interface QQBotGroupToolPolicyConfig {
  allow: string[];
  deny?: string[];
}

/**
 * QQ group images are already attached to native multimodal model input.
 * Re-analyzing them through legacy vision tools adds a second model request and
 * can outlive QQ's reply window, so keep those tools out of restricted groups.
 */
export const QQBOT_RESTRICTED_TOOL_DENY = ["image", "zai-vision__*"];

export function mapQQBotGroupToolPolicy(
  policy: ToolPolicy,
): QQBotGroupToolPolicyConfig | undefined {
  if (policy === "full") return undefined;
  if (policy === "none") return { allow: [], deny: ["*"] };
  return { allow: [], deny: [...QQBOT_RESTRICTED_TOOL_DENY] };
}
