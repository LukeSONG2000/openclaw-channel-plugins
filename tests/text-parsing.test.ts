import assert from "node:assert/strict";
import { filterChatMetaNarration, filterInternalMarkers } from "../src/utils/text-parsing.js";

const fallbackNotice = `↪️ Model Fallback: zai/glm-5-turbo (selected zai/glm-5.2; HTTP 429: 该模型当前访问量过大，请您稍后再试)

---

确实绷不住，这不就是电竞圈经典的一冠论 vs 多冠论吗 😂`;

assert.equal(
  filterInternalMarkers(fallbackNotice),
  "确实绷不住，这不就是电竞圈经典的一冠论 vs 多冠论吗 😂",
);

assert.equal(
  filterInternalMarkers("[[reply_to: abc]]\n@image:test.png\n正常内容"),
  "正常内容",
);

assert.equal(filterChatMetaNarration("我接一句：这操作确实离谱"), "这操作确实离谱");
assert.equal(filterChatMetaNarration("这句话是说：他今晚不上线"), "他今晚不上线");
assert.equal(filterChatMetaNarration("我不接这个话题。"), "");
assert.equal(
  filterChatMetaNarration('ツバサ在玩大乱斗，发了一张截图说“我游龙了”（炫耀操作）。上一个话题就是大乱斗。\n\n接一句就行。游龙=操作很秀。\n\n含金量还在上升'),
  "含金量还在上升",
);
assert.equal(filterChatMetaNarration('“只要不倒闭”这句话含金量太高了'), '“只要不倒闭”这句话含金量太高了');
assert.equal(filterChatMetaNarration("第一段。\n\n第二段"), "第一段。\n\n第二段");

console.log("text parsing tests passed");
