# 群聊自由回复架构

本文依据本仓公开源码维护，不需要额外仓库或组织权限。渠道入口见[自由回复总览](free-reply.md)。

## 处理链路

```text
平台事件 / 已授权的历史读取
  -> 渠道与会话识别
  -> 群参与策略 / 命令鉴权
  -> 未读记录、去重与有界上下文
  -> @立即处理，或未读轮询
  -> 根据当前问题和上下文生成
  -> 区分最终内容、静默与中间过程
  -> 渠道发送和投递记录
```

实现分为平台适配、未读状态、生成上下文和发送四层。可以复用设计与纯函数，但不能直接把
QQ事件字段、钉钉消息ID、平台主动发送窗口或各自的授权凭据混用。

## 消息来源

QQ主要处理平台实际投递的群事件；没有全量消息权限的群，插件无法凭轮询恢复从未收到的内容。
钉钉的机器人Stream与个人DWS历史是不同来源，权限主体和可见范围不同。
群内有机器人，不等于DWS账号也有群历史访问权。

每条记录至少关联渠道、账号、群/私聊身份、消息ID、发送者与时间。
引用保留原消息身份；媒体应具备可读取的本地文件及类型，不能把占位符当作已识图。
具体当前限制见[QQ说明](../plugins/qqbot/docs/custom-runtime/free-reply.md)与
[钉钉说明](../plugins/dingtalk/docs/free-reply.md)。

## 会话与未读

- 按渠道、账号和会话隔离；同名群也不能共享队列或上下文。
- 未读集合、用于理解的已读上下文、已回复/已消费记录各有用途，不应混为一份历史。
- @消息是当前回复目标；其相关历史只用于辅助理解，不能顺带重复回答所有旧消息。
- 轮询没有新消息时不调用模型；有新消息也允许判断为不需发言。
- 状态持久化与定时器恢复要成对核验，不能仅凭磁盘上的dueAt推断存在活定时器。
- 历史窗口和媒体数量必须有界，避免长群聊使会话持续膨胀。

QQ的状态与调度入口为[unread-runtime.ts](../plugins/qqbot/src/custom/unread-runtime.ts)、
[unread-store.ts](../plugins/qqbot/src/custom/unread-store.ts)和
[unread-scheduler.ts](../plugins/qqbot/src/custom/unread-scheduler.ts)。
钉钉对应[chat-runtime.ts](../plugins/dingtalk/src/chat-runtime.ts)。

## 生成与发送

上下文需要明确当前消息、辅助历史和回复范围。可见正文不能包含候选主题、内部判断、工具过程或
“不回复”的解释。静默应当不发送消息，而不是把内部决策写到群里。

QQ的提示入口见[unread-catchup-prompt.ts](../plugins/qqbot/src/custom/unread-catchup-prompt.ts)，
输出边界见[agent-output-boundary.ts](../plugins/qqbot/src/custom/agent-output-boundary.ts)。
钉钉的调度和模型上下文在[monitor.ts](../plugins/dingtalk/src/monitor.ts)，
可见输出处理在[reply-filter.ts](../plugins/dingtalk/src/reply-filter.ts)。

不要把模型生成成功、发送接口受理和客户端实际显示视为同一种成功。
发送结果未知时先核验，不通过重新发送来“测试”是否已投递。

## 三种独立约束

| 约束 | 负责什么 | 不代表什么 |
| --- | --- | --- |
| 平台访问权限 | 能接收/读取哪些消息，能向哪里发 | 不代表可执行管理或工具操作 |
| 群参与策略 | 是否允许主动参与，何时响应 | 不授予额外平台权限 |
| 执行鉴权 | 谁能调用工具、改规则或批准操作 | 不自动启用群内主动发言 |

后续修改按[开发复用契约](free-reply-development-contract.md)分别测试这些边界。
