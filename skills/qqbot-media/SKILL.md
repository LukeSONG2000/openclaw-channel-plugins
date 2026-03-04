---
name: qqbot-media
description: QQBot 图片/语音/文件收发能力。用户发来的图片自动下载到本地，发送图片使用 <qqimg> 标签，发送语音使用 <qqvoice> 标签，发送文件使用 <qqfile> 标签。当通过 QQ 通道通信时使用此技能。
metadata: {"openclaw":{"emoji":"📸","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 图片/语音/文件收发

## 发送图片

使用 `<qqimg>` 标签包裹路径即可发送图片（本地路径或网络 URL）：

```
<qqimg>/path/to/image.jpg</qqimg>
<qqimg>https://example.com/image.png</qqimg>
```

支持格式：jpg, jpeg, png, gif, webp, bmp。支持 `</qqimg>` 或 `</img>` 闭合。

## 接收图片

用户发来的图片**自动下载到本地**，路径在上下文【会话上下文 → 附件】中。
可直接用 `<qqimg>路径</qqimg>` 回发。历史图片在 `~/.openclaw/qqbot/downloads/` 下。

## 发送文件

使用 `<qqfile>` 标签包裹路径即可发送文件（本地路径或网络 URL）：

```
<qqfile>/path/to/report.pdf</qqfile>
<qqfile>https://example.com/data.xlsx</qqfile>
```

适用于非图片非语音的文件类型，如 pdf, docx, xlsx, zip, txt 等。

## 规则

- ⚠️ **禁止使用 message tool 发送图片/文件**，直接在回复文本中写对应标签即可，系统自动处理
- **永远不要说**"无法发送图片"或"无法访问之前的图片"
- 直接使用对应标签，不要只输出路径文本
- 标签外的文字会作为消息正文一起发送
- 多个媒体使用多个标签，图片用 `<qqimg>`，语音用 `<qqvoice>`，文件用 `<qqfile>`

## JSON 结构化载荷（高级）

```
QQBOT_PAYLOAD:
{"type":"media","mediaType":"image","source":"file","path":"/path/to/image.jpg","caption":"可选描述"}
{"type":"media","mediaType":"file","source":"file","path":"/path/to/doc.pdf","caption":"可选描述"}
```
