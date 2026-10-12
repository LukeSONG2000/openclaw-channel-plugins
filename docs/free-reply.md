# QQ 与钉钉群聊自由回复

这是后续 Agent 的开发入口，只聚焦自由回复：获取群消息、未读与已读上下文、触发和调度、选择回复主题、生成与发送。投票、定时任务、完整授权体系等不在本文展开。

设计正文统一维护在团队私有仓库 [ciqtek-aitea/agent-conversation-design](https://github.com/ciqtek-aitea/agent-conversation-design)：[通用设计](https://github.com/ciqtek-aitea/agent-conversation-design/blob/main/docs/architecture.md)、[QQ 实现](https://github.com/ciqtek-aitea/agent-conversation-design/blob/main/docs/qqbot-free-reply.md)、[钉钉实现](https://github.com/ciqtek-aitea/agent-conversation-design/blob/main/docs/dingtalk-free-reply.md)、[开发复用契约](https://github.com/ciqtek-aitea/agent-conversation-design/blob/main/docs/development-contract.md)。本仓保留源码和入口，不复制维护另一份设计正文。

## 文档与代码范围

- 主仓：`LukeSONG2000/openclaw-channel-plugins`，分支 `main`。
- QQ：[实现与复用说明](../plugins/qqbot/docs/custom-runtime/free-reply.md)，代码 `plugins/qqbot`。
- 钉钉：[实现与复用说明](../plugins/dingtalk/docs/free-reply.md)，代码 `plugins/dingtalk`。
- 核查日期：2026-10-12；本次只整理文档，不提取或搬迁源码、不改线上配置、不部署。
- 当前 QQ 代码存在未提交改动。文档标注的工作树实现不能假定远端 clone 已具备；Git 提交、当前工作树与线上部署要分开验证。

## 验证边界

当前工作树 `npm run check:qqbot` 已通过：严格 TypeScript 检查和 163 个测试文件。测试结果不代表实际消息源权限、生产调度或发送效果已在线验收。

钉钉 `npm exec -- tsc --noEmit -p tsconfig.json` 与 `npm test` 已通过；本次没有执行构建或部署。

QQ 的 `build` 命令可能掩盖 TypeScript 错误，且 `postbuild` 可能同步本机 `~/.openclaw/extensions/openclaw-qqbot`。自由回复开发先用无产物类型检查与定向测试，不要盲目构建覆盖部署。
