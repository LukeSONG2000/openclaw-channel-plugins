# QQ 自由回复开发入口

自由回复的设计与复用资料统一维护在团队仓库：

- [Agent Conversation Design](https://github.com/ciqtek-aitea/agent-conversation-design)
- [QQ 实现与复用契约](https://github.com/ciqtek-aitea/agent-conversation-design/blob/main/docs/qqbot-free-reply.md)
- [通用 Agent 设计](https://github.com/ciqtek-aitea/agent-conversation-design/blob/main/docs/architecture.md)

团队仓库为私有，需要对应访问权限。本文件只保留入口，避免两处维护不同版本正文。

源码仍在本仓 `plugins/qqbot`，官方参考为 [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)。

开发时区分当前工作树、已提交版本和线上部署；保留无关改动，不用官方安装覆盖定制插件。严格检查入口为主仓根目录 `npm run check:qqbot`。
