# OpenClaw Channel Plugins

Luke 的 OpenClaw 渠道插件二开仓库。各渠道共享一个代码入口，但保持独立的包、依赖、版本和部署节奏。

## 渠道

| 渠道 | 目录 | 二开包 | 上游 |
| --- | --- | --- | --- |
| QQ | `plugins/qqbot` | `@lukesong/luke-qqbot` | [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot) |
| 钉钉 | `plugins/dingtalk` | 暂沿用 `@largezhou/ddingtalk`，当前从源码部署 | [largezhou/openclaw-dingtalk](https://github.com/largezhou/openclaw-dingtalk) |

## 本地检查

```bash
npm run bootstrap
npm run check
```

也可以只检查一个渠道：

```bash
npm run check:qqbot
npm run check:dingtalk
```

## 维护规则

- 唯一主仓为 [LukeSONG2000/openclaw-channel-plugins](https://github.com/LukeSONG2000/openclaw-channel-plugins)，分支 `main`；旧个人 QQBot fork 已迁出，不再作为开发、安装或更新入口。见 [仓库迁移与安装](docs/repository-migration.md)。

- 渠道实现只放在对应的 `plugins/<channel>` 目录。
- 每个插件独立维护 `package.json`、插件清单、测试和部署说明。
- 上游更新先审阅差异，再按渠道合并；不自动覆盖二开版本。
- AppID、Secret、Token、Webhook、OpenClaw 配置、会话与运行数据不得提交。
- 一个渠道的发布或部署不要求其他渠道同步升级。

## 自由回复开发入口

后续 Agent 开发或复用群聊自由回复时，先阅读：

1. [QQ 与钉钉自由回复总览](docs/free-reply.md)：共同链路、渠道差异和复用边界。
2. [QQ 自由回复实现](plugins/qqbot/docs/custom-runtime/free-reply.md)：QQ 消息接收、权限分档、未读轮询、主题规划和回复出口。
3. [钉钉自由回复实现](plugins/dingtalk/docs/free-reply.md)：Stream 与 DWS 消息来源、固定轮询和工作场景输出。

这些文档是 2026-10-12 的代码核查快照，只聚焦自由回复。标记为“工作树改动”的功能不能仅凭远端 clone 假定存在；本地代码、Git 提交和线上部署应分别核验。禁止用官方安装或更新覆盖已部署的定制插件。

## 历史

两个插件均以保留提交历史的方式导入。源仓库中的 QQBot 迁移前基线为 `eb966de`，DingTalk 的首个二开基线为 `b12c905`；导入时清除了 IDE 对话记录、临时规划目录和历史打包产物。
