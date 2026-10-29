# QQ 自由回复开发入口

本文是个人公开主仓中的QQ实现说明。先阅读[总览](../../../../docs/free-reply.md)、
[通用架构](../../../../docs/free-reply-architecture.md)和
[开发复用契约](../../../../docs/free-reply-development-contract.md)，无需其他仓库权限。

## 消息入口与群参与策略

QQ的连接与消息适配在[src/custom](../../src/custom)，
[group-dispatch-gateway-adapter.ts](../../src/custom/group-dispatch-gateway-adapter.ts)和
[group-ingress-gateway-adapter.ts](../../src/custom/group-ingress-gateway-adapter.ts)衔接群消息与未读记录。

[group-permissions.ts](../../src/custom/group-permissions.ts)解析default/free/admin三档。
启用该权限配置时，新群缺省为default（仅@）；free允许全量消息与轮询，admin用于管理群。
平台是否真的投递全量消息是另一层权限，插件不能补出从未收到的内容。

## 未读、调度与上下文

- [unread-runtime.ts](../../src/custom/unread-runtime.ts)：未读记录、触发快照、消费和轮询档位。
- [unread-config.ts](../../src/custom/unread-config.ts)：场景与运行配置合并、历史条数和周期限制。
- [unread-store.ts](../../src/custom/unread-store.ts)：持久化状态。
- [unread-scheduler.ts](../../src/custom/unread-scheduler.ts)：真实定时器与恢复。
- [unread-context.ts](../../src/custom/unread-context.ts)：选择本轮相关上下文。
- [session-context-window.ts](../../src/custom/session-context-window.ts)：会话上下文窗口约束。

轮询周期以配置解析结果为准，不把某台实例的设置当作源码固定值。
被@的主回复只回答当前消息；未读历史是辅助上下文。同一问题、图片或连续对话不能在后续轮询重复回应。
消息快照与消费边界要结合完成逻辑核验，不能直接清空整群历史代替去重。

## 生成与输出边界

[unread-catchup-prompt.ts](../../src/custom/unread-catchup-prompt.ts)定义@主回复与主动轮询的不同范围，
无合适内容时使用精确的`NO_REPLY`；当前默认轮询提示不自动@成员。
[agent-output-boundary.ts](../../src/custom/agent-output-boundary.ts)与
[unread-output.ts](../../src/custom/unread-output.ts)负责输出边界相关逻辑。

处理图片要查看[inbound-media-context.ts](../../src/custom/inbound-media-context.ts)，
引用关联要查看[message-reference-context.ts](../../src/custom/message-reference-context.ts)。
不能仅凭附件ID、占位文本或模型“看到了”的自述认定图片已经进入模型。

## 检查与参考

源码仍在本仓 `plugins/qqbot`，官方参考为 [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)。

开发时区分当前工作树、已提交版本和线上部署；保留无关改动，不用官方安装覆盖定制插件。严格检查入口为主仓根目录 `npm run check:qqbot`。
