# Codex 统一重置监控

## 2026-10-20 来源迁移与运行策略

当前代码唯一读取 [Will Codex Reset 中文站](https://willcodexreset.com/zh)
公开页面实际使用的 `https://willcodexreset.com/api/reset-radar`，不请求旧站、
不读旧 snapshot 作为新数据、不使用 SSR 的 0% 加载占位。代码来源已切换，
独立 QA 305 项通过；本轮已获备份部署及限定文件 commit/push 授权。
代码部署不等于来源时效通过、日报已发或 DD 已初始化；后文 2026-10-19 的
部署/样例均为保留的历史记录。

真实返回的 `probability24h` 和 `probability48h` 都存在（本次采集 72/82），
是 0..100 概率原值，渲染时仅除以 100；不补零、不推算。任一期限缺失便省略
对应面板。没有置信度、区间、promise、具体未来重置时间和结构化 preview，
不伪造旧 API 字段。没有今日重置状态时显示“来源预测”，不声称今天已重置或未重置。

严格区分本机 `retrieved_at`、源响应 `source_updated_at`、信号采集
`signal_checked_at`、事件 `occurred_at` 和预测生成 `forecast_generated_at`。
前两个不能给旧信号/概率保鲜。2026-10-20 用户明确批准按网站公布值推送：
`lastIngestion.checkedAt` 是来源报告的采集时间，不是概率发布时间，
不再仅因它超过两小时就阻断日推和重置通知，原值仍写入审计记录。
接口请求及 schema 必须通过，源响应时间仍要求不超过两小时，
响应和采集时间未来偏移仍不得超过五分钟，采集 status 必须为 ok；
若另有真实预测生成时间，仍校验该时间，不把任何其他时间替换成预测生成时间。
两小时是旧监控沿用的内部保守运行策略，不是新站 schema 或网站要求；
采集时间较旧既不证明概率过期，也不证明来源实时，推送仅展示网站公布值。
新源目前没有公开可证的预测生成时间，provider 明确返回 None、
`forecast_generation_time=false`，只表示无法核实概率生成时刻，不否定全部事件证据，
也不作为单独的永久阻断。
不得据 HTTP200 说来源恢复、补发成功或 DD 初始化完成。
卡片缺少真实预测时间就省略更新行，不替换为响应时间或抓取时间。

所有新生产/隔离样例 manifest 的“信息来源”统一为新站 `/zh`，
snapshot 的 `sourceProvider`、`sourceTimes`、`sourceCapabilities`、
`sourceSignalStatus` 留存身份、独立时间及能力；公告保留原生 `source_event_id`、
真实 `x_status_id`、来源作者与原始 URL。`feedFetchedAt` 是本次 HTTP 读取时间，
仅为事务审计水位，不证明公告或预测新鲜。

### X 动态接入

`tiboPosts`（全部动态）与 `tiboRelevantPosts`（预测相关子集）一起接入
“Tibo宣布了什么”。它们与重置审批事件分开读取，按原始 X status ID 合并去重；
同一推文既在事件表又在动态列表时只出一张卡，卡片优先保留 X 原文，而非站方摘要。
保留头像、UTC+08:00 时间和卡片外的“查看𝕏”原帖链接，整条仍是单条多图消息。
图片正文不绘制网址；推文附带的HTTPS网址在对应卡片外显示为可点击的“附带链接”，
相同网址合并。仅含网址的推文卡片显示“分享了一条链接”。snapshot仍保留完整原文，
不修改去重ID或已冻结批次。
没有真实 Tibo 原帖链接的待发动态拒绝发送，不补造地址。

每日推送或明确重置阶段触发时，附带迁移时间边界内、该渠道尚未推送的动态；
沿用 `sentAnnouncementIds` 和原有失败/未知回执保护。只有成功投递才消费动态，
两个渠道独立去重。普通动态不会单独触发轮询通知，也不会因匹配旧重置 ID
就把基线重置重新标成“已重置”；来源时效门限、定时器和已冻结 pending 均不改变。

regular actual 只接受源结构 `kind=reset / verified=true / resetType=usage`；
站方公开管理文案将其定义为已确认的全局重置事件，图表和日历也只纳入这一组合。
不依赖标题、分数、autoDetectedReset 或正文猜测；来源确认不保证个人到账，
新源 actual 正文明确“来源已确认直接用量重置，不代表个人到账”。verified banked 记录可能仍是
未来措辞，只映射 banked announced，绝不映射 distributed。未知类型/阶段和普通
tibo 帖不触发；只在有真实 `thsottiaux` 原始 X URL 时允许生成署名 Tibo 的公告卡。
没有X链接的站内确认记录仍可独立触发 regular actual，保留原生ID、确认时间和
`sourceResetEvents`审计，只使用本站“信息来源”，不生成署名Tibo的假公告卡。
日推合并尚未发送的到账/发卡完成事件时，优先显示到账/发卡标题，普通日推标题不变。
历史阶段升级仅在仍属于待通知阶段时可突破内容基线，已过期/已抑制的重置不带回旧X卡片。
未确认记录不触发；声称来自X但缺少原作者证据的动态仍阻断，不补造链接。
2026-10-22 已接入原作者
`forecastSignal.stage=scheduled` 且有非空 `window` 的重置预告：普通预告映射
regular preview，明确banked的预告映射banked upcoming；没有明确子类型时
仅使用普通预告路由，文案注明类型/适用范围以原公告为准，不声称全员或regular到账。
普通X文字、置信度、autoDetectedReset仍不能单独触发通知；不支持推断banked distributed。

### 预告时间的 AI 解析

仅准备新预告批次时，`preview_time.py` 使用 OpenClaw 当前主模型、同一provider
及本机已有凭据做一次独立文本调用，不带聊天历史、不提供工具、不使用其他模型供应商。
AI只解析时间表达、相对日期和时区，不能决定重置状态；只读取最终JSON，不读取reasoning_content。
原文、来源窗口、发布时间与同作者引用上下文都作为不可信数据，不执行其中指令。

随后由Python标准时区库确定性换算UTC+08:00；相对日期以推文发布时的源时区日历日期
为基准，不以轮询/发消息当天为基准。只按原文明确时区生成一个UTC+08:00时间：
PST固定UTC-08、PDT固定UTC-07；不将PST额外解释为当地夏令时，也不附加备选时间说明。
地区时区名称仍按其自身时区规则换算。已发送批次不修改、不重发，样式从下次新批次生效。
没有可靠时区、JSON不合规或模型不可用时，仍发预告，
但显示无法可靠换算、请以原文为准，不伪造日期。成功语义结果按模型、原文与版本缓存，
相同预告不因每15分钟轮询而重复调用AI；日推无预告、未变化轮询和dry-run不调用模型。
密钥只从本机配置读取，既不落入缓存也不写日志。预告时间写入卡片及批次审计，不冒充预测生成时间。

钉钉服务端历史中的图片既可投影为 `@mediaId`，也可投影为HTTPS URL；
两种只读格式均按原有群、机器人、时间、文本摘要和图片数量校验，不访问图片链接，
不声称此回查能验证图片字节。未知发送回执不自动重发；有完整发送时间窗和正文摘要时
允许只读回查原群，唯一精确匹配后标记readback_confirmed。
此时`accepted=false/acceptanceUnconfirmed=true`如实保留，不伪造processQueryKey。
缺失、歧义、不完整或目标不一致均保持pending，人工确认需保留原回执及审计。

真实 X URL 的数字 tweet ID 沿用旧去重键，其他原生 ID 使用 provider 前缀。
首次完整有效正常 run 创建独立 `providerBaseline`，记录全部已见 ID、阶段键和
固定切换时间，仅表示观测而非成功。所有既存历史和之后迟到但早于切换时间的
未知 ID 都不补发；已观察同 ID 后续出现明确新阶段仍保留原阶段规则。
旧 daily、reset、notified、sentAnnouncementIds、deliveredPhaseKeys、pending
和迁移下界均保留；新源无 last_reset 不清空旧 reset 水位。dry-run/no-send 不建立
来源基线，不消费事件。冻结旧 outbox/receipt/图片保持原字节，未知发送不重放。

QQ 与 DD 独立账本、08:00 + 15 分钟计划、首次 fresh 初始化门禁及回执去重不变。
待 QA/PM 放行且真实数据全部门禁通过后，才可执行 QQ 今日既有日报补发
（由 dailyDate 去重）及 DD 首次 initialize-on-success；不是额外群样例授权。
本轮仅备份部署及提交推送审定的来源/集成/渲染文件；不改
sender/transport/unit/插件，不回滚或重置业务账本，不改冻结 outbox/receipt。
若来源仍不满足原门禁，仅记录真实新接口 HTTP200 与校验阻断，不实际发送，
不回退旧 snapshot，也不等待来源恢复。若真实采集已满足全部门禁，则沿用此前
QQ 当日既有 daily 与 DD 首次初始化授权，各按账本去重一次，不额外群发样例。

## 钉钉群运行

正式群固定为“AI组内通知”，使用显式 `--group-config`，不复用私人测试配置。
群配置权限 0600，字段为 `version: 1`、`openclawRoot`、
`imageHosting: "qq_upload_only"`、经 Transport 核实的 `groupId`；实际配置不进 Git。
配置默认安装位置为运行目录 `dingtalk-group.json`。

```sh
python3 monitor.py --channel dingtalk --group-config "$GROUP_CONFIG" --baseline-only
python3 monitor.py --channel dingtalk --group-config "$GROUP_CONFIG" --daily-summary
```

上述为手动两步方式。正式 poll service 现在只轮询新增重置，不带
`--initialize-on-success`，因此重新启用不会补发首次日推；日报独立在每天
UTC+08:00 08:00触发。首次接入若确实需要立即初始化日报，可显式手动使用
`--initialize-on-success`：首次当前 provider 的 schema、来源时钟和
采集健康门禁全部通过时，同次建立基线并发送唯一真实日报；概率生成时刻
未被独立核实，不能以该运行结果宣称预测已刷新。
来源失败始终只写独立健康计数和 journal，不往群发 health/error，也不回退 QQ。
首次日报完成前保留 `initializationPending: true`，不标 daily 成功；已有基线或
未确认 pending 也会继续同一初始化意图。
服务端 readback 确认后才置 pending 为 false，记录 firstDailyCompletedAt 和当日
daily；之后普通轮询无变化静默，当日 08:00 不重复。不得用旧 snapshot 初始化；
helper 测试或 timer 已启用均不代表来源恢复、QQ 轮询成功或初始化已经发送。
2026-10-20 用户已验收私人 reset 样例并授权把这次 reset 发到群；现有更早 X
动态按用户要求建立已处理基线，仅最新一条保留为当前样例。基线操作不伪记
lastSuccessfulPushAt，不清空已发回执、已通知重置或阶段去重。原无回执的旧日推
先备份归档并取消，不把它标成投递成功。后续只有真正的新内容进入增量批次。
群发送器CLI入口不得顶层`await main()`：群Transport会反向导入发送器，动态导入
与顶层等待会形成循环，导致Node退出13且没有回执。使用完成模块求值后的Promise
回调设置退出码；回归覆盖真实CLI进程，而不只是导入后调用main的测试。
群独立使用 `state/dingtalk/group/{state.json,monitor.lock,outbox/}`，绑定渠道及
固定目标 hash，不迁移 QQ state/journal、私人测试成功或 pending。
基线以前的历史不推送，但基线确实观察过的同 ID 后续新阶段仍可触发。

复用原图文和动态标题，单条多图不变。群 sender 使用 `--send-group`；
accepted/unknown/inflight 保留同一 pending，重入只核对回执，不另建 batch 重发。
`readback_confirmed/ok/readbackObserved` 及目标、manifest 校验全部通过后，
才记录当日 daily 和阶段成功键。readback 仅是服务端消息历史匹配，
不是客户端送达/已读，也不验证图片字节及链接目的地，`deliveryVerified` 仍为 false。
持续缺少唯一证据须人工核对，不以重发解决。来源失败计数及回执只属于当前
渠道。群仅发送 daily 和新 reset phase；QQ 原有管理员 C2C 三连失败告警保留，
钉钉故障不得触发该 QQ 告警。
群历史只从原发送时间向后取 30 条；超过 30 条且 hasMore 为 true 时保持
incomplete/pending，需人工只读核对，不重发，也不宣称完成。

新 `codex-reset-dingtalk-{monitor,summary}.{service,timer}` 分别为 15 分钟轮询和
每日 08:00 Asia/Shanghai；旧 QQ 四个 unit 不变。
来源 helper 仅对同源暂态失败最多重试三次，每端点预算 81 秒，输出脱敏
HTTP/curl 分类；不降级为旧数据、其他来源或放宽 freshness。

2026-10-19 已按本轮授权部署代码候选 `5a1e2ba`，12 文件与最终 QA hash 一致，
helper 先于 entry 落盘；运行机 131 项回归、唯一群只读目标预检和 unit verify 通过。
群配置 0600，两个 DD timer 与原两个 QQ timer 均 active/enabled，未停 gateway。
备份：`laptop-home:~/.openclaw/backups/codex-reset-monitor/group-20261019T103150Z/`。
18:34 最后三个 API 全为 HTTP502；实际 QQ poll 失败计数 5、exit1，DD 计数 1。
DD initializationPending=true，firstDailyCompletedAt/daily/pendingBatch 均为空，
无 outbox/receipt、未真实初始化、群发送为零。DD 首次完整 fresh 后才自动尝试日报，
不将已启用 timer 说成已恢复/已发送；未知发送只读核对，不重发。

## 钉钉私人样例

以下为已完成的私人测试记录，不代表正式群已启用。默认命令及
`--channel qq` 保持 QQ 原行为、state、pending 和锁，现有 QQ timer/service 不变。
不带 `--group-config` 的 `--channel dingtalk`（别名 `dd`）仍只允许只读预检：

```sh
python3 monitors/codex-reset-monitor/monitor.py --channel dingtalk --dry-run
python3 monitors/codex-reset-monitor/monitor.py --channel dd --no-send
```

两者不发送、不渲染、不落盘、不拿 QQ 锁，只读 `state/dingtalk/state.json`；
已有文件须含 `channel: 'dingtalk'`。DD `--no-send` 也不写健康计数；QQ
`--no-send` 原行为不变。不迁移 QQ 日志，不继承 QQ 成功/baseline，不续传 QQ pending。

### 准备与预检

```sh
python3 monitors/codex-reset-monitor/monitor.py --channel dd --prepare-private-test
node monitors/codex-reset-monitor/send-dingtalk.mjs --manifest "$DD_MANIFEST" --dry-run
```

首条命令只准备，不发消息；不能与其他模式旗标合用。本次 DD 私测使用当前
真实 forecast 加两张非今日的 reset/reset_preview 历史公告，复用原 renderer。
整条 v2 消息为 H1、信息来源、预测卡、H1 `Tibo宣布了什么`、普通 text
`以下为历史公告，用于排版测试，非今日重置确认`，再接两张历史卡及原始 X 链接。
该提示仅加入本次 DD 私测，不修改生产/QQ 历史预览版式。
产物在 `state/dingtalk/layout-preview/<batchId>/`：`snapshot.json`、三张 PNG、
`batch.json`、`preparation.json`。返回 JSON 的 `manifestPath` 即 `DD_MANIFEST`，
`receiptPath` 固定指向同目录 `batch.receipt.json`，准备阶段不创建 receipt。
样例带 `private-test-current-forecast-with-history` 元数据和 sampleOnly 保护，不能 complete_batch；
不读取或创建 QQ/DD 正式业务 state，不推进 baseline、daily、阶段或公告水位。
来源无效、缺少历史对照或渲染失败则停止。之前无说明的三图候选和单卡候选
保留原文件但不再使用；本次仅使用含上述可见提示的新三图 manifest。

sender dry-run 不加载目标配置、不上传、不发送、不落 receipt。当前 sender 已有
显式私人测试入口；以下命令只在独立 QA 与 PM 放行后执行，与 `--dry-run` 互斥：

```sh
node monitors/codex-reset-monitor/send-dingtalk.mjs --manifest "$DD_MANIFEST" \
  --send-private-test --config "$DD_CONFIG" --receipt "$DD_RECEIPT"
```

`DD_MANIFEST`、`DD_CONFIG`、`DD_RECEIPT` 均使用运行机绝对路径。
`DD_RECEIPT` 使用准备报告的 `receiptPath`，位于同一 DD batch 目录，禁止指向
QQ receipt 或配置/图片。运行机私密配置只包含以下三个字段，由运行用户持有，
权限 0600；运行机已独立创建该配置，不在 Git 中保存实际配置：

```json
{"version":1,"openclawRoot":"/home/PPfavorite/.openclaw","imageHosting":"qq_upload_only"}
```

真实测试只允许宋雨扬与 R2-D2；load 从 runtime 的 `channels.ddingtalk`、DWS
get-self 和 bot find 取得身份，校验已固定的目标/机器人 hash，不允许在配置
覆盖 ID。上传后、唯一发送前再次核验身份；旧 DWS 不传 `--profile`，新 DWS
核对当前 active profile 后显式绑定。身份漂移、目标未知均停止，不切账户，
不回退到群或其他人。身份取证见 `test_dingtalk_sender_identity_report.json`，
这是只读取证报告，不是发送成功或独立 QA 放行证据。
图片只复用显式 opt-in 的 QQ upload-only URL，不调用 QQ 消息发送接口。
DWS bot 没有终态查询不阻止这一次测试：受理按 `unknown`/`accepted=true`
记录真实 processQueryKey（CLI 退出 5），不能当 complete，不自动重发。
可用时仅做一次有界 list-direct 只读查询，空结果或查询失败不抹掉受理证据，
也不是重发理由；不能拿个人消息 query-send-status 查询机器人 processQueryKey。
客户端三图、可见历史提示和链接验收另行记录，不能借样例确认业务成功或
启用 DD 定时。CLI 0 表示 dry-run 或有验证证据的 complete，4 为阻断/失败，
5 为 unknown（含已受理）；同一 matching receipt 已存在时 sender 不再发送。

### 部署边界

2026-10-19 经 FINAL-RELEASE QA 与 PM 授权，已在
`laptop-home:/home/PPfavorite/.openclaw/monitors/codex-reset-monitor/` 逐文件备份并
部署六文件：`monitor.py`、`test_monitor.py`、本 README、`send-dingtalk.mjs`、
`test_dingtalk_sender.mjs`、`test_dingtalk_sender_identity_report.json`。
备份及脱敏取证位于
`/home/PPfavorite/.openclaw/backups/codex-reset-monitor/dingtalk-20261019T095346Z/`，
`before/` 保留三个原文件，`backup-index.json` 标记三个新增文件。运行配置为
`/home/PPfavorite/.openclaw/monitors/codex-reset-monitor/dingtalk-private-test.json`，
已核权限 0600。共用 renderer/assets、sender helpers 和 QQ sender hash 不变。

首次运行机准备因 forecast HTTP 502（`curl exit=22`）停止，未发送。
随后获 PM 明确授权，复用本地 QA 冻结的 snapshot 与三图；原 snapshot/图片
hash 均核验不变，仅在独立样例 manifest 加普通 text：
`排版测试，数据采集于 2026-10-19 17:25:38（UTC+08:00），非实时播报`。
历史提示保留，不伪装当前实况，不再请求来源、不修改代码或 QQ 排版。

带日期样例在运行机 dry-run 三图通过后，于 2026-10-19 18:05 UTC+08:00
仅执行一次 `--send-private-test`。实际受理字段为 `$.result.processQueryKey`，
receipt 为 `unknown/accepted=true`，CLI 退出 5；只读回查返回 1 条消息，
不将其冒称终态送达。manifest/receipt 在运行目录
`state/dingtalk/layout-preview/layout-735d3a2c5631444fa7df27aaff2c5120-dated/`；
脱敏受理 JSON 字段路径、响应 hash 与回查结果见上述备份目录的
`send-summary.json`。三图、可见采集日期及历史提示、链接仍待用户客户端验收。

部署前后 QQ 业务 state 字节 hash 一致，pending 为空；两个 timer 保持
active/enabled，日报仍为 08:00，轮询仍为 15 分钟，unit/配置与 gateway 不变。
部署前 QQ 自然轮询已失败（17:54 UTC+08:00，连续抓取失败 2 次），本次没有
清计数、补发、重启或修改 state，不把该既有失败归因于 DD 部署。

唯一私人发送授权已执行；保留同一 manifest/receipt，不再发送或换 batch。
回滚仅恢复本次备份的代码、撤回本次新增代码，不删除样例/receipt 证据，
不回滚业务 state。提交仅上述六文件，不包含根 README、QQ 既有脏文件、
私密配置、state 或生成样例；不启 DD 自动推送或群发。

## 类型与阶段

内部 resetType=regular/banked，五种类型/阶段组合的成功键
分别为 type:phase:sourceId。daily 与 event 共用内容成功账本；daily 展示并成功
确认 preview 后，实际到账的 actual 键仍未确认，即使来源复用同一 ID，也必须
保留 actual 公告图文。只有整条 v2 消息成功才写 deliveredPhaseKeys。

daily 首行为“Codex会重置吗？”，所有动态首行均为一级标题。regular preview 为“Codex确认重置！”，
regular actual 为“Codex已重置，速蹬！”；banked upcoming 为“Codex重置卡即将发放！”，
banked distributed 为“Codex重置卡已发放！”，banked announced 为
“Codex已公布重置卡消息！”。正文另有类型/阶段说明；预告明确尚未到账，
重置卡已发放仅代表来源报告发放，不代表当前管理员个人或全体用户到账。

以下 kind/reset_kind/tag 与跨接口映射为旧 provider 的历史兼容规则，
仅保留离线回归；新 provider 按前述真实结构合约投影，不构造旧接口响应。
旧映射先识别 banked kind/reset_kind/tag，避免将重置卡预告当成常规重置。
kind=banked 的 arriving/available/announced 分别对应 upcoming/distributed/announced；
available 还要求 preview=false。真实 reset_preview、preview=true、banked tag
且无明确其他 banked_state 时对应 upcoming。unknown/缺失状态不推断发卡。
常规来源类型为 hard，或缺失类型但有 regular tag；兼容缺失 reset_kind 的
明确 reset_preview + preview=true 旧预告（例如仅有 quotareset tag），显式未知
类型不默认归 regular。regular actual 仍须原有跨来源 confirmed 校验。
promise_active 或概率变化本身不触发。run_once 实际提取并传递阶段，poll/daily
共用成功账本，不是独立未调用的辅助逻辑。

升级时只用已有实际成功推送时间（或已核实迁移日志时间）建立固定
phaseBaselineAt/phaseBaselineKeys，阻止已存在历史阶段即时补发；baseline 不是成功。
内容去重独立使用 sentAnnouncementIds/deliveredPhaseKeys：固定 migrationLowerBound
之后未见 ID 即使属于 trigger baseline，仍会在下一 daily/event 带出；旧已发 ID
的 baseline 阶段不重复，同 ID 新阶段仍可投递。不会滚动过滤迟到新 ID，
也不会重放下界外数月历史。历史排版示例保持隔离，不写这些业务成功键。
用户已验收 QQ 客户端图片展示，2026-10-19 15:22（UTC+8）已恢复自动投递。
这是此前验收及恢复记录，不代表本次文本规则变更已部署；本次仍待 PM 整合及 QA。

历史来源为 willreset.com 中文站，使用公开的
`/api/forecast`、`/api/notify`、`/api/feed`，不启动浏览器、不混入 feed.posts。
feed 全取后本地校验、按 ID 去重，不依赖被忽略的分页参数，不截取前 12 条，
也不按 cadence/scope 排除公告。只有 forecast/notify 的有效 `last_reset`
因子、ID、时间、原始 X 链接一致，且 feed 中同一记录是非 preview 的 reset，
才允许 regular actual 触发即时推送；明确来源预告及重置卡阶段按上表独立触发，
不改变 confirmed 防线。孤立顶层 ID 不触发。首次正常运行静默建立基线，不记成成功投递。

运行依赖 Python 3.9+、Pillow >= 9.2、可用中文字体、Node.js、curl 和 QQ
发送适配器及其 sender-manifest.mjs/sender-transport.mjs。抓取仅在本进程内使用
IPv4 HTTPS，连接超时 5 秒、curl 单次总超时 20 秒、进程上限 25 秒、
最多三次尝试，不修改系统网络。
schema 错误按抓取失败计数；旧 provider 的 `computed_at`、`live_fetched_at` 和 `fetched_at`
均必须存在、距当前不超过两小时，且未来偏移不超过五分钟，否则不能清零。
连续第三次失败告警，成功抓取并通过校验后清零。确认事件使用 state 中的
事件 ID 水位及已知事件时间防倒退，较旧已通知或未通知事件均不推进、不发送。
预测卡忠实展示官网原报的有效 0..100 概率，不因 CI 区间矛盾或区间缺失隐藏
有效概率，不修改、推算或校准数字；这不是已校准概率的声明。仅无有效概率
时传 None 显示不可用。来源概率与区间矛盾会记录在 snapshot.sourceWarnings
及日志中，旧纯文本 forecast_probability 仍显示 CI 矛盾警告；JSON/schema、
confirmed 和时效门禁不变。旧 provider 卡片更新时刻使用 computed_at，
不是 live_fetched_at；图片时区标注统一为 UTC+08:00，时间偏移仍为 UTC+8，
不改变时间语义。新 batch 的单条消息不附加独立时区 footer 或时区链接；
PNG 内的 UTC+08:00 标注保留，图片本身不承载可点击链接。
公告卡严格使用 event.summary，
保留原文，不从 body 或 posts 回退。

## 图文与投递事务

每天 UTC+08:00 08:00 和新增明确事件使用同一排版：动态首行一级标题、可选阶段正文、
Markdown 信息来源链接、预测卡；daily 标题固定“Codex会重置吗？”。有未发公告时再接
一级标题“Tibo宣布了什么”，逐公告卡和显示名为“查看𝕏”（𝕏 为 U+1D54F）的原始 X 链接。
“信息来源”链接保持原样。无公告时省略 Tibo 空标题，
不重发旧公告。预测卡不包含网站大标题、用量限额、关于或祈求；公告卡没有
“在 X 查看”按钮。15 分钟轮询无新明确阶段时保持静默，boost/signal 不单独触发通知。

`state/outbox/<batchId>/` 保存冻结的 snapshot.json、PNG、batch.json 和
batch.receipt.json。manifest v2 为 `{version:2,batchId,delivery:'single_markdown',parts}`，
parts 只定义整条原生 Markdown 的排版顺序，不代表多条聊天消息；图片 part
严格只有 type/path，相对路径由 sender 读取 PNG 尺寸和 SHA，业务 state 的
imageHashes 校验保留。一级标题只接受 `{type:'heading',level:1,text:'...'}`，
字段严格校验，文本单行非空、最多 400 个 UTF-16 code unit，不允许控制字符。
sender 仅生成标题前缀 `# `，标题文字和旧 text 的 Markdown 转义保持不变。
H1 语法见[腾讯官方 Markdown 文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/type/markdown.md)。
canonical hash 仍基于原 manifest，旧 text/image/link 兼容。新批次没有独立时区 footer，禁止
退回分段发送。manifest 使用 camelCase；
重试只读原快照，不重新渲染相对时间、不修改 manifest。业务 state 绑定快照、
manifest 和图片摘要；文件改变则拒绝续传。旧已冻结 pending 即使含旧公告显示名、
旧普通文本标题、旧来源位置或时区 footer，也保留原 snapshot/manifest/receipt，
不因新规则重写。两个 service 共用同一个 flock。

sender v2 原子保存整消息 receipt.message；failed 可以重试，inflight/unknown
必须人工核对，不能自动重发。只有 sender 退出 0 且持久化 v2 receipt 的
batchId、delivery、canonical manifestSha256 一致，ok/status 为 true/complete，
message.status 为 sent 并包含真实 QQ 消息 ID 的 receiptSha256 回执，才一次性
更新业务的 daily_summary_date、notified_reset_ids、sentAnnouncementIds、
lastSuccessfulPushAt 和 announcementWatermark；部分失败、非零退出、超时
都保留 pendingBatch，不推进成功状态。发送成功但业务落盘前崩溃，下一轮
仍复用同一个 v2 receipt。旧 v1 pending/partial 不得续发或复用 receipt，必须
人工核对；旧 v1 complete 回执与已记录的成功水位保留，不清空、不重放。
新的单条人工 preview 必须创建 v2 新 batch。source/feed/snapshot 任一失败均 fail closed。

目标由现有 OpenClaw config 中首个有效管理员解析，与 sender 的 C2C 选择
规则相同；不在源码写真实 openid，不切换其他管理员，不 fallback 到群。
纯文本故障告警也使用这个固定 C2C 规则，不改变其他频道或 QQ 插件源码。

## V1 迁移

旧 daily_summary_date 和 notified_reset_ids 保留原义，不能作为精确 successAt，
baseline/notified 也不是成功投递证据。迁移读取系统 journal 中属于两个正确
unit、匹配现配置首个 C2C 管理员的实际 daily/reset “sent”记录，选择最近成功。
注意本机 journalctl --user 可能为空，不能因此误判系统 journal 无日志。
分别用原生 _SYSTEMD_USER_UNIT 字段查询两个 unit，各取最近 100 条后在 Python
精确校验成功前缀、unit 和当前 C2C 目标，再合并选最新成功；不使用全局尾部
或 --grep 筛选，避免其他日志淹没 daily。任一 unit 查询失败则拒绝迁移。
如日志没有覆盖 state 中更晚的成功 daily 日期，停止迁移，不凭空补水位。

若 systemctl 仍保留对应成功 run，采用其实际开始时间作为包含边界的
migrationLowerBound；否则采用成功日志前五分钟作为旧实现有界耗时的保守下界。
单独记录 migrationEvidence.observedSuccessAt、来源和不确定性，初始
lastSuccessfulPushAt/announcementWatermark 保持 null，不伪记历史卡片已发。
本次已只读核到 2026-10-19 UTC+08:00 08:00:12.133779 的实际 daily 成功日志，
对应 run 开始约 08:00:08；部署时重新读取，不硬编码这个日期或边界。

只纳入 announced_at >= migrationLowerBound 且 ID 未见的公告，不把 112 条
历史全标已发，也不重放全量历史。这个下界固定不滚动，即使迟到记录时间
早于最近一次成功推送，也可凭未见 ID 纳入下次 batch。旧历史无 URL 在下界
外不阻塞批次；窗口内待发记录缺原始 X URL 则 fail closed，绝不伪造链接。
找不到成功日志时停止迁移、等待证据，不默认为空水位或当前时间。

```sh
python3 -m unittest discover -s monitors/codex-reset-monitor -p 'test_*.py' -v
python3 monitors/codex-reset-monitor/monitor.py --dry-run --daily-summary
python3 monitors/codex-reset-monitor/monitor.py --manual-preview --dry-run
node --test monitors/codex-reset-monitor/test_sender.mjs
```

`prepare_layout_preview.py` 是独立维护准备脚本，不是新的聊天指令。运行后只在
ignored state/layout-preview/<batchId>/ 生成实时预测卡、最近一条 confirmed
与一条 preview 的历史公告卡及 v2 manifest。消息不输出独立“历史排版示例”说明行；
snapshot.purpose、preparation.history、非今日确认保护及不写业务 state 的约束保留。
顶部必须是实时已预告状态，不生成历史概率或模拟已确认
预测；历史卡最多两条，图片 part 同样严格为 type/path，公告链接显示名同为“查看𝕏”，
不附加独立时区 footer，PNG 内 UTC+08:00 标注及 UTC+8 时间计算保持不变。
脚本不调用 sender/complete_batch，不修改正式业务 state 或公告去重，不创建
发送 receipt。QA/PM 放行后只使用这个隔离 manifest/receipt 发送一次 corrected
完整样例，不另外运行 current-only manual-preview。

### 显式图片诊断

sender 默认不启用诊断 flag，使用 `force_verify_image_resource=true`，receipt 的
`imageVerification` 为 `strict`；旧 v2 receipt 未记录此字段时也只按 strict 处理。
仅本次获授权的独立样例诊断可使用以下命令，将该参数设为 false：

```sh
node monitors/codex-reset-monitor/send-openclaw-qq.mjs \
  --manifest "$DIAGNOSTIC_MANIFEST" --receipt "$DIAGNOSTIC_RECEIPT" \
  --diagnostic-unverified-images
```

两个路径必须指向新独立 layout 目录的 manifest/receipt，不复用原 strict 失败
receipt。诊断模式记录 `imageVerification=diagnostic_unverified`，跨模式拒绝续发；
所有图片仍必须匿名 GET 成功且 SHA 与源文件一致。只调用一次 messages API，
无拆段、无 fallback；拒绝、unknown 或 inflight 均停止，不自动再试。
隔离样例不得调用 complete_batch，不改变正式业务水位或公告成功键。

此 flag 仅是诊断变量，不是生产修复；生产 monitor 不会附加该 flag，也不会
自动降级为 false。API 返回真实成功 ID 只证明接口接受，不证明图片已展示。
历史诊断阶段即使 receipt 为 complete/sent，也须等待用户在 QQ 客户端验收
同一消息的三图和链接，再由 PM 确认恢复。用户现已验收图片，自动投递已于
2026-10-19 15:22（UTC+8）恢复；当时的 `--no-send` 暂停记录不是当前生产状态。
不能仅因 timer active 或准备/上传成功宣称正常生产推送可用。

`--dry-run` 不调用发送适配器，不创建锁或改写 state；`--no-send` 保留抓取
健康状态，但不初始化业务基线、不迁移、不创建/续传 batch、不确认任何投递。
两者均禁止与 `--test-push` 合用。`--manual-preview` 是明确维护入口，只在
人工授权后去掉 --dry-run；使用当前真实 API 和同一去重/receipt，不伪造 reset，
不补历史、不改当天 daily 日期；重试同一未完成预览不会再创建第二个预览。
--dry-run 只验证抓取/解析，不等于图文整链验收；整链验收应在隔离目录复制
只读 state，真实抓取、迁移副本、渲染 PNG/manifest，再执行 sender --dry-run。
该 dry-run 不读凭据、不访问 QQ、不改 receipt，不能将其 ok=false 当真实成功。
实际 state 和凭据不进 Git。未初始化的 `--no-send` 不把事件加入已通知列表。

线上目录为 `laptop-home:~/.openclaw/monitors/codex-reset-monitor/`，运行用户
`PPfavorite`。定时器保持每 15 分钟轮询、每天 UTC+08:00 08:00 摘要。
部署前备份代码、unit 和 state，核对线上旧文件哈希；仅原子替换代码，禁止
覆盖运行 state 或凭据。部署范围必须包含已验收的 renderer、sender 及其
manifest/transport helpers，并同步两个 service unit 后 systemctl --user daemon-reload。
两个 oneshot 均设置 TimeoutStartSec=30min，覆盖最多约 26 分钟的最坏路径：
三接口抓取最多 156 秒、日志取证最多 40 秒、渲染 180 秒、旧/新两批发送各
600 秒。常规只有一批；超时依赖 receipt 核对，不提前记成功。定时器不变。
独立 QA 通过后方可部署；未获样例授权不得真实发送预览。
恢复检查只用 --dry-run/--no-send，不补发摘要、不重放历史 ID、不启用钉钉 hook。
如需暂缓正常投递，使用明确的 service override 添加 `--no-send`，交 PM
确认恢复策略；正常 timer 验收必须核对 effective ExecStart 无 --no-send 遗留，
并检查两个 service 的实际 TimeoutStartUSec；不要直接修改已通知 ID 列表。

2026-10-16 诊断：原线上 `monitor.py` SHA-256 为
`43e0e3fb8322228aab6d57871307215ea895b8b019a92fd7d6308b88da8a10c9`。
原始独立目录 `Workspace/laptop/codex-reset-monitor/` 不属于 Git 仓库；
本目录是可提交源码，保留原目录作为历史快照，不在两个路径同时开发。
