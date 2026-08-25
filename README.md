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

- 渠道实现只放在对应的 `plugins/<channel>` 目录。
- 每个插件独立维护 `package.json`、插件清单、测试和部署说明。
- 上游更新先审阅差异，再按渠道合并；不自动覆盖二开版本。
- AppID、Secret、Token、Webhook、OpenClaw 配置、会话与运行数据不得提交。
- 一个渠道的发布或部署不要求其他渠道同步升级。

## 历史

两个插件均以保留提交历史的方式导入。源仓库中的 QQBot 迁移前基线为 `eb966de`，DingTalk 的首个二开基线为 `b12c905`；导入时清除了 IDE 对话记录、临时规划目录和历史打包产物。
