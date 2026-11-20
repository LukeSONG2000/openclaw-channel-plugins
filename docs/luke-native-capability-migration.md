# Luke 原生能力与 R2 迁移

## 1. 历史读取：原生会话和 QQ 原始消息不是一回事

| 数据 | 当前可复用能力 | 边界 |
| --- | --- | --- |
| Agent 自己参与的回合、后台结果及可恢复会话 | [Hermes Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)、内置 `session_search`、[会话消息 API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server#detached-results-and-session-history) | Luke 的路由和窗口输入是已有群消息的组合，不能把对应会话记录当成完整 QQ 聊天。原生搜索可看到该 profile 的历史，不能替代数据隔离。 |
| 平台实际推来的普通聊天、原始发言人、引用和附件 | 原版 QQ SDK、现有 [QQ inbox](../experiments/aoa-async/qq-receive-only.mjs) 与 [同群上下文读取](../experiments/hermes-qq/inbox-view.mjs) | 隔离镜像中的 Hermes 自带 QQ 群适配只注册群 @ 事件；会话读取不会补出没有进入 Agent 的普通消息。Luke 复用 QQ SDK 的引用元数据，并从同群、早于引用消息的 inbox 记录或 QQ 随消息推送的引用元素取内容。引用随当前消息进入聊天、窗口和后台任务；只提供文本与附件计数，不提供原图或下载 URL。旧记录没有引用索引，无法回填。 |

**决定：不二开 Hermes，不再做通用历史库。** 让 Hermes 管自己的会话和搜索，让现有 QQ 适配层继续读平台材料。下次改读取能力时，复用一个只读契约：可信会话绑定、时间区间或消息锚点、条数或游标；返回来源、覆盖范围、缺失说明和媒体引用。回顾讨论、查早先的决定、给生图取材都调用同一个能力，不新增 `today` 或生图专用历史路径。若平台原生入口日后同时覆盖全量事件、读取隔离和媒体，再考虑删掉重合的接入代码。

## 2. 成员记忆：原生身份字段 + Honcho

已核对 Luke 固定的 Hermes v0.23.2 镜像：`POST /v1/runs` 接受结构化 `author`，Hermes 会把每轮的作者交给 Memory Provider；作者字段不是权限。镜像插件目录提供 [Honcho](https://hermes-agent.nousresearch.com/docs/user-guide/features/honcho#gateway-identity-mapping)。镜像固定的 Honcho 1.2.0 上游测试覆盖较晚发言者使用独立 peer，而非写进会话首位发言者的记忆。Hermes 自带的 `MEMORY.md` / `USER.md` 用于 Agent 自己的记忆和用户画像，不能作为群成员分表。

隔离镜像已实测：拒绝非对象作者；接受两次不同 ID、同一显示名的合成回合；原生消息 API 可读回两轮。这是接口和会话读取验证，不是 Honcho 写入、召回或真实群成员验证。

最小接入：

1. 由可信 QQ 事件里的 bot account 与 `member_openid` 派生稳定的非公开 peer ID；昵称只用于展示，改名不改记忆归属。把群会话键和成员身份键分开，关闭全员共用 peer 的 pin；隔离公开测试群、其他群和私聊，默认不合并跨渠道身份。
2. 先用合成样本验证原生作者传递和插件读写。真实试点优先独立自托管 Honcho workspace，不把真实群历史批量发送给默认云端；自托管的相关推理、嵌入端点也要核对数据出口。Luke 当前尚未启用该插件。
3. 只把有原始作者的单条真实发言走原生归因。Luke 的窗口规划和任务规划把多条历史拼进一次模型调用，保留在无记忆的路径，不把拼好的 prompt、工具输出或看板结果归到发起人。普通群发言如确需沉淀，再复用 Honcho 官方接口逐条、按原作者写入；不为记录每条消息额外开模型回合或新建记忆库。
4. 用两位成员给出相反偏好、同一昵称、改名、进程重启和跨群负例验收。还要检查归因后的记忆实际能按人读回，不只检查标签；暂不放开跨 profile 搜索或在所有聊天回合自动调用慢速记忆推理。

## 3. R2 独立拓展怎么迁

下表是可复用能力与接入方式，不是启用清单。生产端留在原位，除非明确切换。

| 能力 | 接新版的方式 | 首个验收 |
| --- | --- | --- |
| 角色、工作场景规则、动物园梗 | 角色适配 Hermes 原生 `SOUL.md` / 项目规则；动物园词表用 [原生 Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)按需加载。理解和生成场景复用同一词表，不搬 R2 上过宽的触发规则，不进工作群。 | 普通闲聊能接话；无合适场景不硬套，不把示例人物当群友。 |
| [Imagen](../plugins/openai-image/README.md) 静态图、改图、参考图、GIF | 保留一个 Imagen skill，复用现有规划、OpenAI API 渲染、账号/代理故障切换和并发控制。抽出宿主无关的渲染入口，用 Hermes 插件工具传入经过验证的上下文和媒体；长任务走原生 worker。OpenClaw 的工具注册、渠道媒体路径、通用生图旧入口都不搬。 | 自然语言 + 本群文字或引用图 → 正确成图 → 原路径发出；GIF 保留动画，重试不重复出图。 |
| GoH 查询、征服攻略原图、Web Store / Kessel Run | 先搬查询和资源读取为只读 skill，攻略发原始资产。账号登录和领奖留在独立 worker；需要迁部署时复用现有执行器及 [Hermes Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) 或维护一个现有调度器，不双跑。 | QQ 能收到原图；查询无账号凭据；自动领奖不因两套调度重复执行。 |
| [Codex 重置监控](../monitors/codex-reset-monitor/README.md) | 保留现有抓取、判定、渲染、每日摘要和去重状态。只换或新增经授权的发送适配，先影子/私聊验收，再明确切换订阅；保持已关闭的钉钉订阅关闭。 | 不补发旧事件；同一重置只有一条；日报与确认状态均保真。 |
| 通用网页读取、截图 | 先验 Hermes 原生网页读取或成熟插件。截图若需保留，作为能在沙箱访问受控浏览器的独立工具，不把宿主 Mac 桌面开放给群机器人。 | 普通网页和受控渲染场景复用同一能力，不泄露本机桌面。 |
| 资源保护、代理订阅、私人自动化 | 资源保护属部署层；Imagen 专用代理是渲染依赖，不变成 Luke 的公共管理工具。账号型、私有资料型 skill 留在专用个人环境，不复制到群 profile。 | 公共群无法访问宿主、运维凭据或个人资料。 |

权限与群别名、引用/媒体、最终输出、自由回复、斜杠路由是**横向能力**，不是各 skill 要重写的功能。部署顺序：原生历史/成员归因与来源隔离 → 一项低风险业务技能（GoH 只读或动物园）→ 通用引用媒体/成品回执后接 Imagen → 需要时再切独立调度。不要为追平菜单数量迁入全部生产配置。
