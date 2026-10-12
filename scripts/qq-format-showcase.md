# QQ 消息样式实测

日期：2026-10-12。仅向当前配置绑定的唯一管理员发送 QQ 私聊，不改线上配置、不重启 Gateway、不向群发送。

## 实测结果

15 类样式最终均由平台返回消息 ID 与发送时间；另有 1 条纯文本开场消息。发送成功不等于 QQ 客户端渲染或点击已验收。

| 样式 | 发送结果 | 展示边界 |
| --- | --- | --- |
| Markdown 标题、粗体、斜体、删除线、引用、列表、分割线 | 成功 | 客户端待确认 |
| 网页外链 | 成功 | 实际点击待确认；域名受平台配置约束 |
| 命令蓝链 | 修正后成功 | 输入框填入与直接发送 `/help`；后者不能带 `show` |
| 自定义交互按钮 | 成功 | 填入帮助、发送帮助、网页跳转；不创建任务、不修改设置 |
| Markdown 表格语法 | 成功 | 仅语法探针，不证明支持原生表格 |
| LaTeX 公式语法 | 成功 | 仅语法探针，不证明支持原生数学排版 |
| 行内代码、代码块 | 成功 | 仅语法探针，不证明支持代码高亮 |
| ARK 23 文本列表卡片 | 成功 | 包含文本列表和网页链接 |
| ARK 24 缩略图外链卡片 | 成功 | 缩略图加载、点击待确认 |
| ARK 37 大图外链卡片 | 成功 | 图片加载、点击待确认 |
| Markdown 文字与图片混排 | 成功 | 图片加载待确认 |
| 图片版表格 | 成功 | 栅格和文字均渲染为图片，不可编辑 |
| 图片版公式 | 成功 | 数学式排版在图片中，不依赖 QQ LaTeX |
| 图片简报与同条消息说明 | 成功 | 图片中绘制的内容不是可点击控件 |
| GIF 动图 | 成功 | 上传并发送成功，客户端动画播放待确认 |

群 @ 通知没有在本轮私聊测试中验证，不能把私聊示例当作群通知验收。没有真实目标小程序的跳转地址，本轮没有伪造小程序示例。音频、视频、文件虽有插件发送链路，本轮未实发。

首轮命令蓝链失败：HTTP 400 / `40034108` / `qqbot-cmd-enter不支持show`。仅修正此示例并单独补发，没有重发其余样式。生产插件的现有 `slashCommandEnter` helper 仍生成 `show`，本次未修改或部署该 helper；不要复制其旧写法。

## 复用

```sh
python3 scripts/render-qq-format-showcase.py /path/to/assets --font /path/to/cjk-font.ttc
node --test scripts/send-qq-format-showcase.test.mjs
node scripts/send-qq-format-showcase.mjs
node scripts/send-qq-format-showcase.mjs --send --root /home/user/.openclaw --assets /path/to/assets
```

默认仅预览。`--send` 才读取部署配置并发送。管理员不是唯一一个时拒绝自动选人。报告文件已存在时阻止整批重复发送；定向补测可用 `--only command-links --report /path/to/new-report.json`。没有自动重试，以免网络超时后重复投递。配置密钥不输出、不写入仓库，报告仅记录脱敏错误与消息发送结果。

该脚本通过部署插件的 API 模块实测消息协议；不会修改 Gateway 的 `markdownSupport`。因此这些结果不代表现有 Agent 出站流程已经默认启用所有格式，也不代表群聊权限与私聊相同。

## 官方资料

- [发送消息](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)
- [Markdown 协议](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/type/markdown.md)
- [按钮协议](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/trans/msg-btn.md)
- [ARK 卡片](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/type/ark.md)

文档支持列表未明确列出表格、LaTeX、行内代码或代码块。主动推送的旧公告与当前账号实测不一致，不能套用旧公告推断此账号的真实发送限额，也不能以一次成功推断无限制。
