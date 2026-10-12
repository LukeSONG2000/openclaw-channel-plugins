# 钉钉自由回复开发入口

自由回复的设计与复用资料统一维护在团队仓库：

- [Agent Conversation Design](https://github.com/ciqtek-aitea/agent-conversation-design)
- [钉钉实现与复用说明](https://github.com/ciqtek-aitea/agent-conversation-design/blob/main/docs/dingtalk-free-reply.md)
- [通用 Agent 设计](https://github.com/ciqtek-aitea/agent-conversation-design/blob/main/docs/architecture.md)

团队仓库为私有，需要对应访问权限。本文件只保留入口，避免两处维护不同版本正文。

源码仍在本仓 `plugins/dingtalk`，官方参考为 [largezhou/openclaw-dingtalk](https://github.com/largezhou/openclaw-dingtalk)。

机器人事件与个人 DWS 历史读取是不同消息来源，不能假定具有相同访问范围。包目录无产物检查为 `npm exec -- tsc --noEmit -p tsconfig.json`，测试为 `npm test`；本入口不代表任何真实群已配置完成。
