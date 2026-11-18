---
name: imagen
description: 在已开放的 QQ 和钉钉会话生成图片、动图、插画、海报，或按当前附件精修与参考图创作。用户明确说“画一张”“做个动图”“把这张图的背景换掉”“参考这张重新做”时适用，不要求说出技能名或输入指令。只聊天、看图、找图或问教程时不使用。
---

# Imagen

Adapted from OpenAI Codex's bundled `imagegen` skill. The upstream skill and prompt references are preserved under [references](references/upstream-skill.md) with their [Apache-2.0 license](LICENSE.txt). This port replaces Codex's embedded image tool with the permission-gated OpenAI API path used by the QQ and DingTalk plugins.

由频道入口识别当前消息里的明确请求，使用同一个有权限校验的 Imagen 渲染流程。不要求用户再发一遍命令；不要用 shell、其他图像工具或重放消息绕过权限。机器人的群聊轮询不发起生图。

- **文生图**：给出明确主体和用途，例如「生成一张飞船穿过云海的海报」。
- **动图**：「生成一张动态图」「做个循环 GIF」输出 GIF。附图或引用图片时说「改成 GIF」，将那张图做成短循环，保留原有主体。明确要求视频文件时，说明不支持视频，不擅自替换成 GIF。
- **精修**：附原图，或在 QQ 明确引用它，例如「把这张图的背景换成雪山，人物不变」。按原图锁定身份、毛色等可见特征，只有指定项可以变。
- **参考图**：同一条消息附参考图，例如「参考这张的配色，做一张全新的海报」；借鉴相关特征，不当作原图精修。
- **群聊主题**：只有明确要求根据本群创作时才采用同群的有限近期上下文；不借用其他群或私聊的信息。

在私聊直接描述即可；群里用原生 @ 明确在叫机器人。QQ 可在请求明确指向「刚才那张」时使用同一会话的近期图片；如果取不到正确原图，就请用户引用或补图。将需求整理为场景、主体、细节、限制和输出目标；越详细的需求越少增加新设定。确需显式控制时，用 `/imagen gif`、`/imagen edit`、`/imagen ref` 或 `/imagen studio`。

应用 [官方提示词规范](references/prompting.md)；需要细化构图时参考 [官方示例](references/sample-prompts.md)。只发送成品或必要的补充问题；不要发内部分析或绘图简报。
