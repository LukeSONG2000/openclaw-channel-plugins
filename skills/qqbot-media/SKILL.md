---
name: qqbot-media
description: QQBot 富媒体收发能力。推荐使用 <qqmedia> 统一标签，系统根据文件扩展名自动识别类型（图片/语音/视频/文件），也兼容 <qqimg>/<qqvoice>/<qqvideo>/<qqfile> 旧标签。
metadata: {"openclaw":{"emoji":"📸","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 富媒体收发

## 推荐用法（统一标签）

```
<qqmedia>路径或URL</qqmedia>
```

系统根据文件扩展名自动识别类型并路由：
- `.jpg/.png/.gif/.webp/.bmp` → 图片
- `.silk/.wav/.mp3/.ogg/.aac/.flac` 等 → 语音
- `.mp4/.mov/.avi/.mkv/.webm` 等 → 视频
- 其他扩展名 → 文件
- 无扩展名的 URL → 默认按图片处理

## 兼容旧标签

| 类型 | 标签 |
|------|------|
| 图片 | `<qqimg>路径或URL</qqimg>` |
| 语音 | `<qqvoice>音频路径</qqvoice>` |
| 视频 | `<qqvideo>路径或URL</qqvideo>` |
| 文件 | `<qqfile>路径或URL</qqfile>` |

旧标签完全兼容，系统按标签名指定的类型处理。

## 接收媒体

- 用户发来的**图片**自动下载到本地，路径在上下文【附件】中，可直接用 `<qqmedia>路径</qqmedia>` 回发
- 用户发来的**语音**路径在上下文中；若有 STT 能力则优先转写

## 规则

1. **路径必须是绝对路径**（以 `/` 或 `http` 开头）
2. **标签必须闭合**：`<qqmedia>...</qqmedia>`
3. **文件大小上限 20MB**
4. **你有能力发送本地图片/文件**——直接用标签包裹路径即可，**不要说"无法发送"**
5. 发送语音时不要重复语音中已朗读的文字
6. 多个媒体用多个标签
7. 以会话上下文中的能力说明为准（如未启用语音则不要发语音）

## 示例

```
这是你要的图片：
<qqmedia>/Users/xxx/photo.jpg</qqmedia>
```

```
<qqmedia>/tmp/tts/output.mp3</qqmedia>
```

```
视频在这里：
<qqmedia>https://example.com/video.mp4</qqmedia>
```

```
文件已准备好：
<qqmedia>/tmp/report.pdf</qqmedia>
```
