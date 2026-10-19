# Codex 统一重置监控

唯一来源为 [willreset.com 中文站](https://willreset.com/zh/)，使用公开的
`/api/forecast`、`/api/notify`、`/api/feed`，不启动浏览器、不混入 feed.posts。
feed 全取后本地校验、按 ID 去重，不依赖被忽略的分页参数，不截取前 12 条，
也不按 cadence/scope 排除公告。只有 forecast/notify 的有效 `last_reset`
因子、ID、时间、原始 X 链接一致，且 feed 中同一记录是非 preview 的 reset，
才允许新 confirmed reset 触发即时推送。promise、概率变化和孤立顶层 ID
均不触发。首次正常运行静默建立基线，不记成成功投递。

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
不是 live_fetched_at；全部显示时间为北京时间。公告卡严格使用 event.summary，
保留原文，不从 body 或 posts 回退。

## 图文与投递事务

每天北京时间 08:00 和 confirmed reset 使用同一格式：文本
“Codex会重置吗？”、预测卡、Markdown 信息来源链接；有未发公告时再接空行、
“Tibo宣布了什么”，逐公告卡和原始 X 链接。无公告时省略 Tibo 空标题，
不重发旧公告。预测卡不包含网站大标题、用量限额、关于或祈求；公告卡没有
“在 X 查看”按钮。普通 15 分钟轮询保持静默，不因新 preview/boost/signal 发业务通知。

`state/outbox/<batchId>/` 保存冻结的 snapshot.json、PNG、batch.json 和
batch.receipt.json。manifest 使用 camelCase、图片路径相对 manifest；
重试只读原快照，不重新渲染相对时间、不修改 manifest。业务 state 绑定快照、
manifest 和图片摘要；文件改变则拒绝续传。两个 service 共用同一个 flock。

sender 逐片原子保存 receipt，跳过 sent；failed 可以重试，inflight/unknown
必须人工核对，不能自动重发。只有 sender 退出 0 且持久化 receipt 的完整
parts、batchId、total、nextIndex、ok/status 全部表明 complete，才一次性
更新业务的 daily_summary_date、notified_reset_ids、sentAnnouncementIds、
lastSuccessfulPushAt 和 announcementWatermark；部分失败、非零退出、超时
都保留 pendingBatch，不推进成功状态。发送成功但业务落盘前崩溃，下一轮
仍复用同一个 receipt。source/feed/snapshot 任一失败均 fail closed。

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
本次已只读核到 2026-10-19 北京时间 08:00:12.133779 的实际 daily 成功日志，
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
`PPfavorite`。定时器保持每 15 分钟轮询、每天北京时间 08:00 摘要。
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
