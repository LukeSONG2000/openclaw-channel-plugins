import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { dingtalkPlugin } from "./src/channel.js";
import { setDingTalkRuntime } from "./src/runtime.js";

export { dingtalkPlugin } from "./src/channel.js";
export { setDingTalkRuntime } from "./src/runtime.js";

const entry: ReturnType<typeof defineChannelPluginEntry> = defineChannelPluginEntry({
  id: "ddingtalk",
  name: "DingTalk",
  description: "DingTalk (钉钉) enterprise robot channel plugin",
  plugin: dingtalkPlugin,
  setRuntime: setDingTalkRuntime,
});

export default entry;
