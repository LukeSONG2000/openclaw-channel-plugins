# 钉钉自由回复开发入口

本文是个人公开主仓中的钉钉实现说明。设计资料均在本仓：

- [自由回复总览](../../../docs/free-reply.md)
- [通用架构](../../../docs/free-reply-architecture.md)
- [开发复用契约](../../../docs/free-reply-development-contract.md)

## 两种消息来源

[monitor.ts](../src/monitor.ts)接收机器人Stream事件，并接入未读调度。
[dws-history.ts](../src/dws-history.ts)通过DWS CLI读取已授权群历史并下载媒体。
机器人事件和DWS账号的访问范围不同：机器人在群内，不代表个人读取账号也在群内。
出现`OpendId is not in conversation`时，不能通过开放自由回复或替换身份绕过。

## 默认自由回复与鉴权

`channels.ddingtalk.groupPolicy="open"`允许群入口；每群`enabled=false`仍可单独禁用。
R2的默认群交流规则由[configure-dingtalk-free-reply.mjs](../../../scripts/configure-dingtalk-free-reply.mjs)
写入实例工作区规则，并不随clone自动获得平台权限或部署配置。
不@消息进入未读轮询，@消息走当前回复入口；自由交流不放开工具与管理员操作。
鉴权实现在[authorization.ts](../src/authorization.ts)，工作群不使用QQ动物园词表。

## 状态机与会话

[chat-runtime.ts](../src/chat-runtime.ts)按群保存未读消息、历史游标、已见消息ID、定时器和历史失败计数。
正常轮询固定为一分钟；历史读取失败使用单独的退避周期，不能将失败解释为群里没有新消息。
[message-queue.ts](../src/message-queue.ts)隔离各群/私聊的处理队列，不能跨群复用上下文。

@回复与轮询是两种入口，不能假定@入口已经自动拉齐所有历史。
引用对象需要显式提取和关联，历史图片需成功下载并进入`MediaPaths/MediaTypes`等模型上下文字段。
当前源码不能仅凭Stream接收成功就保证引用与历史图片完整。
排查时分别证明：接口返回、附件下载、模型输入、最终回复。

## 输出与验证

[reply-filter.ts](../src/reply-filter.ts)处理可见回复边界；思考、工具过程和是否接话的判断不应发到群里。
[member-directory.ts](../src/member-directory.ts)提供成员名称与提及关联。
[tests/custom-runtime.test.ts](../tests/custom-runtime.test.ts)覆盖定制运行时相关行为。

从仓库根执行`npm run check:dingtalk`可构建并测试本地代码；不代表已经部署或群内验收。
新增真实测试消息必须先确认目标和授权，不能靠重复发消息检查历史投递是否成功。

源码仍在本仓 `plugins/dingtalk`，官方参考为 [largezhou/openclaw-dingtalk](https://github.com/largezhou/openclaw-dingtalk)。

机器人事件与个人 DWS 历史读取是不同消息来源，不能假定具有相同访问范围。包目录无产物检查为 `npm exec -- tsc --noEmit -p tsconfig.json`，测试为 `npm test`；本入口不代表任何真实群已配置完成。
