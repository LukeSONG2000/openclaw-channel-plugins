# QQ 开放平台能力手册

此页是渠道开发的首查入口。区分 **官方契约**、**源码支持**、**线上观察**和 **QQ 客户端验收**。接口文档存在不代表所有机器人都获准调用；一个群的结果不代表其他群。

## 群资料与权限

| 能力 | 官方入口与字段 | 验证与边界 |
| --- | --- | --- |
| 群名和基本资料 | [获取群基本信息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_info.get.html)：`GET /v2/groups/{group_openid}/info`，读取 `group_name` | 2026-11-20 线上：目标 bot 两个群均返回 HTTP 200 和真实群名。普通群消息事件不带群名，本地别名和发言者昵称都不是群名。 |
| 机器人群内状态 | [获取机器人群内状态](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_bot_state.get.html)：`GET /v2/groups/{group_openid}/bot_state`，读取 `recv_msg_setting`、`allow_proactive_msg`、`member_role` | 2026-11-20 线上：同一群可同时是 `all` 和 `allow_proactive_msg=false`。能收全量，不代表能主动发，也不代表能回拉历史。 |
| 跨应用群关联 | `/info` 的 `union_group_openid` | 官方描述为绑定第三方应用时有效。2026-11-20 线上：两个测试群该字段均为空；同一群的 `group_openid` 在两个 bot 下不同。 |

上述两个 GET 均为只读，官方标注各 30 QPM。查询用当前 bot 的凭据和群 ID；迁移或刷新元数据时查询并缓存，不要每条消息查询。失败时保留已核实绑定，不猜群名，不据此提高权限。

## 事件、回复与媒体

| 能力 | 首查入口 | 接入判断 |
| --- | --- | --- |
| 群全量与 @ | [消息事件](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/event.html)：`GROUP_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE`；`recv_msg_setting` 可为 `all`、`only_mention`、`mention_and_context` | 平台决定接收范围，应用决定是否、何时回复。`all` 不等于逐条回复。实时接收、本地留存和平台历史查询是三件事。 |
| 私聊、被动回复与主动发送 | [消息收发](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html)、[消息流矩阵](../plugins/qqbot/docs/custom-runtime/qqbot-message-flow.md) | 被动回复用同一会话真实消息的 `msg_id`；主动发送是另一路。权限预检不是发信回执，轮询周期也不是平台回复有效期。 |
| 引用、图片、GIF、文件、按钮 | [富媒体](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/rich-media.html)、[消息按钮](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html)、[消息流矩阵](../plugins/qqbot/docs/custom-runtime/qqbot-message-flow.md) | 保留来源会话和消息锚点。各格式分别验收，不能从文本成功推断图片、动画或卡片可用。 |

## 按真实群名迁移

1. 分别用源 bot 和目标 bot 的凭据、各自的群 ID 查询 `/info`。旧配置里的别名不能代替真实群名。
2. 仅迁移唯一且已核对的匹配。重名、任一侧查询失败、目标 bot 尚未见过的群留待确认；跨应用标识可用时作为额外证据。
3. 将确认后的策略绑定到目标 bot 的 `group_openid`，再查 `/bot_state`。群名是迁移线索和显示字段，不是鉴权键。自由回复、群记忆和管理角色分别配置，不跟随接收权限自动开放。
4. 后续补充接口时记录日期、接口、账号类型、HTTP/业务状态及验证到哪一层。不要提交真实群名、群 ID、密钥、完整线上报文或聊天记录。
