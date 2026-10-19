# Codex 统一重置监控

## 钉钉私人样例

当前只准备宋雨扬私人测试，不启用 DD 自动推送或群通知。默认命令及
`--channel qq` 保持 QQ 原行为、state、pending 和锁，现有 QQ timer/service 不变。
`--channel dingtalk`（别名 `dd`）的监控入口仍只允许只读预检：

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

本次运行机生成新样例时，forecast 来源 HTTP 502（`curl exit=22`）阻断，
安全阶段码为 `prepare/sample_prepare_failed`。尚未创建该次远端 manifest 或
receipt，未上传图片、未调用 `--send-private-test`，没有受理 JSON/readback，
不将其记为一次已投递测试。原本地三图 dry-run 样例仍只作 QA 证据，不代替
当前真实来源或移作实发；实际发送授权尚未消耗，待来源恢复后协调继续。

部署前后 QQ 业务 state 字节 hash 一致，pending 为空；两个 timer 保持
active/enabled，日报仍为 08:00，轮询仍为 15 分钟，unit/配置与 gateway 不变。
部署前 QQ 自然轮询已失败（17:54 UTC+08:00，连续抓取失败 2 次），本次没有
清计数、补发、重启或修改 state，不把该既有失败归因于 DD 部署。

唯一私人发送仍须先在运行机成功准备三图和可见提示并 dry-run 核对；受理、
unknown、失败或发送后超时均保留同一 manifest/receipt，不换 batch 重试。
回滚仅恢复本次备份的代码、撤回本次新增代码，不删除样例/receipt 证据，
不回滚业务 state。提交仅上述六文件，不包含根 README、QQ 既有脏文件、
私密配置、state 或生成样例；不启 DD 自动推送或群发。

## 类型与阶段

内部 resetType=regular/banked，五种类型/阶段组合的成功键
分别为 type:phase:sourceId。daily 与 event 共用内容成功账本；daily 展示并成功
确认 preview 后，实际到账的 actual 键仍未确认，即使来源复用同一 ID，也必须
保留 actual 公告图文。只有整条 v2 消息成功才写 deliveredPhaseKeys。

daily 首行为“Codex会重置吗？”，所有动态首行均为一级标题。regular preview 为“Codex已确认重置！”，
regular actual 为“Codex已重置，速蹬！”；banked upcoming 为“Codex重置卡即将发放！”，
banked distributed 为“Codex重置卡已发放！”，banked announced 为
“Codex已公布重置卡消息！”。正文另有类型/阶段说明；预告明确尚未到账，
重置卡已发放仅代表来源报告发放，不代表当前管理员个人或全体用户到账。

映射先识别 banked kind/reset_kind/tag，避免将重置卡预告当成常规重置。
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

唯一来源为 [willreset.com 中文站](https://willreset.com/zh/)，使用公开的
`/api/forecast`、`/api/notify`、`/api/feed`，不启动浏览器、不混入 feed.posts。
feed 全取后本地校验、按 ID 去重，不依赖被忽略的分页参数，不截取前 12 条，
也不按 cadence/scope 排除公告。只有 forecast/notify 的有效 `last_reset`
因子、ID、时间、原始 X 链接一致，且 feed 中同一记录是非 preview 的 reset，
才允许 regular actual 触发即时推送；明确来源预告及重置卡阶段按上表独立触发，
不改变 confirmed 防线。孤立顶层 ID 不触发。首次正常运行静默建立基线，不记成成功投递。

运行依赖 Python 3.9+、Pillow >= 9.2、可用中文字体、Node.js、curl 和 QQ
发送适配器及其 sender-manifest.mjs/sender-transport.mjs。抓取仅在本进程内使用
IPv4 HTTPS，连接超时 5 秒、单次总超时 20 秒、最多两次尝试，不修改系统网络。
schema 错误按抓取失败计数；`computed_at`、`live_fetched_at` 和 `fetched_at`
均必须存在、距当前不超过两小时，且未来偏移不超过五分钟，否则不能清零。
连续第三次失败告警，成功抓取并通过校验后清零。确认事件使用 state 中的
事件 ID 水位及已知事件时间防倒退，较旧已通知或未通知事件均不推进、不发送。
预测卡忠实展示官网原报的有效 0..100 概率，不因 CI 区间矛盾或区间缺失隐藏
有效概率，不修改、推算或校准数字；这不是已校准概率的声明。仅无有效概率
时传 None 显示不可用。来源概率与区间矛盾会记录在 snapshot.sourceWarnings
及日志中，旧纯文本 forecast_probability 仍显示 CI 矛盾警告；JSON/schema、
confirmed 和时效门禁不变。卡片更新时刻使用 computed_at，
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
