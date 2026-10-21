# 仓库迁移与安装

## 唯一开发入口

- 主仓：[LukeSONG2000/openclaw-channel-plugins](https://github.com/LukeSONG2000/openclaw-channel-plugins)，分支 `main`。
- QQ：[plugins/qqbot](../plugins/qqbot)，包名 `@lukesong/luke-qqbot`。
- 钉钉：[plugins/dingtalk](../plugins/dingtalk)，独立构建、测试和部署。
- 重置通知：[monitors/codex-reset-monitor](../monitors/codex-reset-monitor)。
- QQ 官方上游：[tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)。
- 钉钉官方上游：[largezhou/openclaw-dingtalk](https://github.com/largezhou/openclaw-dingtalk)。

2026-10-21 清理原个人 QQBot fork。原 `custom-runtime` 分支的444个文件均已进入统一仓库；统一仓库还包含后续新增的9个文件及15个已更新文件。分支和标签另作完整离线备份，不把未清理的原始历史重新推入公开主仓。旧架构文档、进度日志中的仓库名和 `custom-runtime` 仅为历史记录。

## QQ 安装和更新

统一仓库根目录是管理入口，不是可直接安装的 QQ 插件。不得把仓库根目录传给 `openclaw plugins install` 或当成 QQ npm 包。

```bash
git clone https://github.com/LukeSONG2000/openclaw-channel-plugins.git
cd openclaw-channel-plugins/plugins/qqbot
node scripts/preflight-custom-runtime-deploy.mjs --require-ready
```

生产部署前必须备份配置、插件和数据，独立完成类型检查、测试及人工批准。`npm run build` 的 `postbuild` 可能覆盖本机已安装插件；不要把它当作无副作用检查。已部署实例不得自动更新或切回官方包。

从仓库根目录安装源码时，目标是 `./plugins/qqbot`。以已审核、已构建的插件目录或该目录生成的 tgz 为准，不直接安装整个 GitHub 仓库。

2026-10-21 查询 npm 公共 registry 时 `@lukesong/luke-qqbot` 返回404。因此当前以源码/本地打包部署为准，不能承诺 npm 升级可用。本次迁移不发布 npm 包。只有实际发布并验证后才启用相应 npm 安装说明。

包元信息及远端升级脚本已指向主仓 `main/plugins/qqbot`。`upgradeMode=doc`、`allowUpgradePkgOverride=false` 保持不变；脚本下载地址存在不代表 npm 包已经发布。

## 保持兼容

OpenClaw 插件 ID `openclaw-qqbot`、渠道 ID `qqbot`、扩展目录和数据目录不变。迁移不修改 AppID、Secret、管理员、群绑定、权限、消息队列或历史数据。

旧 npm 包名在预检中仍兼容既有配置，但它不是继续依赖旧 GitHub 仓库的理由。维护时以 `package.json` 的实际名称为准，不自行推断 GitHub 简写等同可安装的 npm 包。

## 官方变更审查

从统一仓库使用 QQ 专用的上游 remote，例如 `qqbot-upstream`，不要把主仓 `origin` 改回旧 fork。保留人工差异审阅，不自动合并或部署。

```bash
git remote add qqbot-upstream https://github.com/tencent-connect/openclaw-qqbot.git
node plugins/qqbot/scripts/inspect-upstream-updates.mjs --upstream qqbot-upstream/main
```

脚本在统一仓库中比较 `HEAD:plugins/qqbot` 与上游根目录，仅报告文件树差异，不能把迁移后不同的提交历史解释为所有官方提交都未合入。单仓模式仍支持有共同祖先的历史比较。
