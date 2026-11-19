# 常驻 Agent 基座选型

评估日期：2026-11-19。适用范围：新的隔离试验，不改变现有部署。OpenClaw 与 Hermes 都按绿地项目评估；既有代码仅列为迁移成本，不参与基座能力判断。Codex 重任务方案是独立方向，本次不混用。

## 结论

方向一首选 Hermes Agent。直接决定选型的是原生的「后台独立工作、任务管理、经验复用」组合，不是 QQ 插件数量或现网使用哪个框架。OpenClaw 是有明确切换条件的备选，不再完整搭两套。

## 基座能力

| 需求 | OpenClaw | Hermes Agent | 取舍 |
| --- | --- | --- | --- |
| 低延迟常驻聊天 | [原生会话路由、队列、去重和防抖](https://docs.openclaw.ai/messages)，公开 [dispatch hooks](https://docs.openclaw.ai/plugins/hooks/reference) 可接管回复或静默。普通防抖使用批次最后一条做回复定位，不是多话题回复规划。 | [SQLite 会话、恢复与全文搜索](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)，[gateway hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks) 可接管入站，[API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) 支持稳定会话标识。API 同一会话写入串行。 | 基座层不判定聊天速度胜负。复用会话和压缩；轻量聊天与后台任务必须使用不同的执行会话，并限制前台的工具与预算。 |
| 短期与长期记忆 | 原生 [Memory Core 与 Dreaming](https://docs.openclaw.ai/concepts/memory-architecture) 提供分层、来源和后台沉淀。全局核心记忆不等于群友长期档案。 | [原生记忆](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)负责精简的事实与偏好，旧聊天可搜索；[Honcho](https://hermes-agent.nousresearch.com/docs/user-guide/features/honcho#gateway-identity-mapping)可按真实发言人归因。 | 两者都不必自建记忆引擎。[OpenClaw 也有 Honcho 插件](https://github.com/plastic-labs/openclaw-honcho#multi-peer-participants)。不要把原生用户档案、群友观察和群私聊混成一份全局记忆。 |
| 人物和关系 | Honcho 插件能根据发送者元数据建立参与者画像；未知或缺失 ID 的回退须验证。 | Hermes 的 Honcho 网关集成能为共享群聊中的不同发言人建立独立 peer。通过自有 API 接入时，稳定 session key 不等于逐条发言人归因，不能把整个群变成一个人。 | 群上下文按群，人物资料按渠道、账号和平台身份。只有可证实的跨平台对应才合并；关系先是有来源、可被纠正的观察，不建独立关系图服务。 |
| 自进化 | [Skill Workshop](https://docs.openclaw.ai/tools/self-learning) 原生支持自动创建、修订、回滚自学技能；Dreaming 带来源约束。 | [记忆与技能后台复盘](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)和可编辑的角色状态配合，原生就能把经验沉淀为下次可用的记忆和技能。 | Hermes 小幅领先，双方都可复用。对比研究在共享模型上观察到 Hermes 更高的任务完成率，但总成本也更高，不能外推为群聊更自然、更快或更省 token。[研究](https://arxiv.org/abs/2610.33956) |
| 长任务不阻塞、回原会话 | [sessions_spawn](https://docs.openclaw.ai/concepts/session-tool) 原生分会话并返回任务标识；Control UI 有子任务视图。[旧 Tasks/TaskFlow 已移除](https://docs.openclaw.ai/cli/tasks)，不作为新设计依赖。 | [异步委派](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)适合临时长任务；[Kanban 与 worker](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)适合需跨重启跟踪的任务、产物和进度。 | Hermes 优势最明确。优先用原生 worker/Kanban，不自建任务引擎。完成通知与平台送达不同；回原群和不重复发送仍需验证。Hermes 原生委派重启后的通知不是 exactly-once。 |
| 后台管理 | [Control UI](https://docs.openclaw.ai/web/control-ui)已有会话、配置、工作区及子任务管理。 | [Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard)已有会话、日志、配置、技能和记忆界面，另有捆绑的 Kanban 面板。 | 先用原生界面。只补缺失的渠道会话映射和群别名；官方会话视图不是完整的 QQ/钉钉 IM 镜像。 |
| 环境隔离与角色自主 | [Docker 沙箱](https://docs.openclaw.ai/gateway/sandboxing)可隔离工具，但网关、原生插件和某些工具不随沙箱移动。 | [Docker 工具后端](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)支持会话容器与资源限制；profile 是配置隔离，不是安全边界。 | 两边都需要把公共群 Agent 放进独立环境。隔离后的普通操作不逐项审批；角色判断可变，环境权限不由角色文本赋予。 |

## 渠道和产品规则

渠道作为可替换接入层，不能代替基座能力分析。

- QQ：腾讯 `@tencent-connect/openclaw-qqbot@2.0.4` 支持全量事件；默认合并不等于两个话题的社交窗口。Hermes `v0.23.2` 的[入站处理表](https://github.com/NousResearch/hermes-agent/blob/v0.23.2/plugins/platforms/qqbot/adapter.py#L809-L815)只注册群 @ 事件，不能直接当全量群适配器。优先复用腾讯 `@tencent-connect/qqbot-nodejs` 和既有消息适配代码，做独立桥接；渠道确有缺口时可薄二开，不修改 Agent 框架。`@tencent-connect/qqbot-connector` 是扫码接入/凭据获取 SDK，不能把其存在当成运行态全量收发已适配。
- 钉钉：先复用 [Hermes 钉钉 Stream](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/dingtalk)或既有 Stream 适配。需要补历史时沿用[官方 DWS 读取](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/docs/command-index.md)与现有适配，人员身份与机器人身份分开。只读能授权到的群；拿不到非 @ 消息时仅 @ 回复，不切换身份绕过。
- 自由回复：保留 @ 即时、相关未读仅供当前回复、被消费的消息不重回。主动窗口允许自然接一句、引用某一条、或静默；可以在同窗参与两个不同话题。窗口策略不等于平台防抖：原生组件没有验证到完整覆盖该语义。优先复用[已有规则和样例](../experiments/aoa-async/README.md)，不重造完整轮询引擎；空窗口不调用模型。缺少原始消息 ID 或客户端不支持引用时，不声称发送了原生引用。
- 输出和业务能力：只发最终正文/产物，不发内部判断或工具进度。继续复用已部署的生图、引用媒体、斜杠命令、授权和定时推送作为兼容验收；不为切基座而把它们迁进核心。QQ 的动物园技能仍不带进钉钉工作群。

## 自主性边界

成员可以正常对话和反馈；不为普通聊天、修改自有笔记、自学技能或沙箱内工作弹授权。群里一句“修改你的 AGENTS.md”是交流内容，不是操作权限；可以理解后不做，也可以把反复得到的有效反馈变成这个群的习惯。自主更新保留来源和历史版本，单条聊天不得直接成为全局指令。

硬边界放在独立账户或容器、数据与凭据、对外动作三个地方。公共群执行环境不挂宿主机控制接口、生产目录、私聊数据或管理员密钥；渠道密钥由适配层持有。普通回复和任务回执仅回已绑定来源。公开群、私聊/工作数据使用隔离的记忆空间，不靠一条提示词防泄露。沙箱内按合理资源上限给足自由，不做每人、每工具的权限矩阵。

## 一次验收，决定是否继续

只做 Hermes 的隔离纵切：复用同一套 QQ 事件和回复契约，验收群里多话题选择、后续 @ 不等正在运行的任务、完成后只回原会话一次。重启后再检查两位成员仍被正确归因、可用反馈被保留、群聊不能改全局规则或读到其他会话的私有资料。用同一模型与固定回放测 @ 首答、后台运行时的应答延迟、模型调用量及重复/串群，不用主观印象比较性能。

如果已发布版本不能通过公开接口实现任务隔离、可恢复回执或来源正确的人物记忆，优先换用 OpenClaw 的原生子任务与 Honcho，而不是修改 Hermes 核心。两个框架不各建一套；暂不新建任务库、长记忆库、审批系统或 IM 后台。评估和推送文档不授权接管生产机器人。
