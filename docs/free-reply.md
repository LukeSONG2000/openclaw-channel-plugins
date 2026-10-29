# QQ 与钉钉群聊自由回复

这是后续 Agent 的开发入口，只聚焦自由回复：获取群消息、未读与已读上下文、触发和调度、选择回复主题、生成与发送。投票、定时任务、完整授权体系等不在本文展开。

所有必需资料均在个人公开主仓内维护，不依赖组织私仓：

- [通用架构](free-reply-architecture.md)：消息来源、会话隔离、上下文与输出边界。
- [QQ 实现](../plugins/qqbot/docs/custom-runtime/free-reply.md)：群权限、未读状态机和回复入口。
- [钉钉实现](../plugins/dingtalk/docs/free-reply.md)：Stream、DWS、默认自由回复和平台权限。
- [开发复用契约](free-reply-development-contract.md)：修改范围、测试、部署与验收。

## 文档与代码范围

- 主仓：`LukeSONG2000/openclaw-channel-plugins`，分支 `main`。
- QQ：[实现与复用说明](../plugins/qqbot/docs/custom-runtime/free-reply.md)，代码 `plugins/qqbot`。
- 钉钉：[实现与复用说明](../plugins/dingtalk/docs/free-reply.md)，代码 `plugins/dingtalk`。
- 文档维护日期：2026-10-29，依据本仓源码重新整理；未复制组织私有文档。
- 不同渠道独立维护包、依赖和运行状态，不应把它们合并成同一个群会话或共享未读队列。
- 本次公开边界整理不修改线上配置、不重启服务、不发消息。

## 能力与权限边界

自由回复不是“每条消息都回复”，而是获取可见消息后按上下文选择有价值的内容；没有必要发言时静默。
群聊参与策略、工具执行权限和平台读取权限是三件不同的事：打开自由回复，不代表获得管理权限，
也不代表平台会补发机器人看不到的历史。图片标记或引用ID的存在，不代表像素已进入模型。

## 验证边界

先运行根目录 `npm run check:public`，再按修改范围运行 `npm run check:qqbot` 或 `npm run check:dingtalk`。
测试数量随版本变化，以本次实际输出为准；通过编译不能代替群内消息、图片上下文与发送回执的验收。

QQ 的 `build` 命令可能掩盖 TypeScript 错误，且 `postbuild` 可能同步本机 `~/.openclaw/extensions/openclaw-qqbot`。自由回复开发先用无产物类型检查与定向测试，不要盲目构建覆盖部署。
