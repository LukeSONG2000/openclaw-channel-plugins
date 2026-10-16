# Codex 统一重置监控

唯一来源为 willreset.com 的 `/api/forecast` 和 `/api/notify`。仅匹配有效
`last_reset` 因子及相同 ID、时间、来源链接的事件可以通知；预测、promise
和孤立顶层 ID 均不能触发。首次正常运行仅建立基线，已通知 ID 保留去重。

运行依赖 Python 3.9+、curl 和已有 QQ 发送适配器。抓取仅在本进程内使用
IPv4 HTTPS，连接超时 5 秒、单次总超时 20 秒、最多两次尝试，不修改系统网络。
schema 错误按抓取失败计数；`computed_at`、`live_fetched_at` 和 `fetched_at`
均必须存在、距当前不超过两小时，且未来偏移不超过五分钟，否则不能清零。
连续第三次失败告警，成功抓取并通过校验后清零。确认事件使用 state 中的
事件 ID 水位及已知事件时间防倒退，较旧已通知或未通知事件均不推进、不发送。
概率不在来源给出的区间内时，摘要明确显示不可用，不修正或推算数字。

```sh
python3 -m unittest discover -s monitors/codex-reset-monitor -p 'test_*.py' -v
python3 monitors/codex-reset-monitor/monitor.py --dry-run --daily-summary
```

`--dry-run` 不调用发送适配器，不创建锁或改写 state；`--no-send` 保留抓取
健康状态，但不确认重置、摘要、故障通知的投递。两者均禁止与 `--test-push` 合用。
实际 state 和凭据不进 Git。未初始化的 `--no-send` 不把事件加入已通知列表。

线上目录为 `laptop-home:~/.openclaw/monitors/codex-reset-monitor/`，运行用户
`PPfavorite`。定时器保持每 15 分钟轮询、每天北京时间 08:00 摘要。
部署前备份代码、unit 和 state，核对线上旧文件哈希；仅原子替换代码，禁止
覆盖运行 state、发送适配器或凭据。独立 QA 通过后方可部署。
恢复检查只用 `--no-send`，不补发摘要、不重放历史 ID、不启用钉钉 hook。
如需暂缓正常投递，使用明确的 service override 添加 `--no-send`，交 PM
确认恢复策略；不要直接修改已通知 ID 列表。

2026-10-16 诊断：原线上 `monitor.py` SHA-256 为
`43e0e3fb8322228aab6d57871307215ea895b8b019a92fd7d6308b88da8a10c9`。
原始独立目录 `Workspace/laptop/codex-reset-monitor/` 不属于 Git 仓库；
本目录是可提交源码，保留原目录作为历史快照，不在两个路径同时开发。
