# Always-on Agent async trial

Independent OpenClaw bridge and worker for two narrow natural-language requests:

- Group: `总结一下24h内群里的聊天内容`
- Group/DM with a local attachment: `帮我整理这份附件`

The bridge observes accepted group messages, queues recognized requests before the ordinary agent turn, and returns immediately. An independent worker runs `openclaw agent exec` once per job. The bridge sends only the final text with the original account and destination; it passes the original message ID as a reply anchor when the adapter supports it. No Codex, edits to upstream plugins, web backend, or production deployment.

## Coverage and boundaries

- OpenClaw **2026.11.5**, stock QQ **2.0.4**, stock DingTalk **2.0.4**, Node **24.16.0** are the initial compatibility pins.
- The independent package uses the [public dispatch hooks](https://docs.openclaw.ai/plugins/hooks/messages). `reply_dispatch` is used because `before_dispatch` does not include the full staged-media context. It only claims recognized requests already admitted by the plugin/host and does not change other chat, slash command, free-reply or permission behavior. It does not add adaptive polling to the original QQ plugin.
- History contains only accepted text observed since starting the lab (last 24 hours, at most six excerpts per two-hour bucket). With mention-only delivery, non-@ history is not guaranteed; do not switch a group to always-reply just to populate a test. Never read raw logs or backfill by changing identities. Stock QQ source shows its own history buffer precedes mention gating, but the observer here only sees accepted host turns.
- Attachments: current message, up to three files and 2 MiB total, UTF-8 text/Markdown/CSV/TSV/JSON and text PDFs (first 20 pages, with `pdftotext`). No URL fetch, scanned PDF OCR or Office conversion. Unsupported inputs and unavailable files are reported, not guessed. File paths must resolve beneath the test gateway's own media root.
- This worker has no channel credentials and uses no agent tools for the two template-driven operations; normal framework tools, existing custom plugin permissions and approvals are untouched. Bind only approved test destinations. Permission-related config changes invalidate pending work and prevent stale callbacks from sending. Never share the state directory with another instance.
- `uncertain` means a job or delivery could have happened. Inspect platform evidence manually; there is no auto-replay or reset command. A platform message ID indicates acceptance, not client display.
- Stock DingTalk's proactive adapter sends to the original chat, but does not accept a reply anchor. Actual receipt and thread behavior still require an independently authorized account.

## Stock QQ always mode is not free reply

The [official channel](https://docs.openclaw.ai/channels/qqbot) uses `always` (equivalent to `requireMention: false`) to allow delivered, admitted non-mention events through its mention gate. Its 2.0.4 message pipeline buffers recent group history before the mention gate, then uses rate limits and a per-peer serial merge queue before ordinary dispatch. Neither mode controls what the QQ platform actually grants or delivers.

Our [custom free-reply runtime](../../plugins/qqbot/docs/custom-runtime/free-reply.md) instead records unread events, schedules adaptive checks, separates read context from consumed topics, and can suppress sending after topic selection. Its `default/free/admin` roles are not the stock activation modes or a platform permission. An async-task hook does not port that runtime. Test full-event access, request/receipt idempotency, and reply cadence separately before considering migration.

The offline `window-reply.mjs` contract evaluates one unread window in one call: at most one unanchored conversational line and one anchored reply on a separate topic; either can be absent. Older messages are context only and are never reply targets. In the fixture `AA BB A CC AA`, the bot joins A naturally, replies to one B message, and leaves the two members in C alone. This contract is not enabled in the live dispatch hook: native quote display and one-to-one ingress identity still need test-bot verification.

## Run offline

`npm test` uses SQLite and synthetic platform and provider events. It needs no credentials. For the additional stock-package tests, install the pinned upstream packages outside this repository, then run:

```sh
export AOA_OPENCLAW_BIN=/absolute/tools/node_modules/openclaw/openclaw.mjs
export AOA_STOCK_QQ_PACKAGE=/absolute/tools/node_modules/@tencent-connect/openclaw-qqbot
export AOA_STOCK_DING_PACKAGE=/absolute/tools/node_modules/@largezhou/ddingtalk
npm test
```

The stock checks use a fresh temporary home. They inspect runtime plugin registration and exercise the real OpenClaw worker against a loopback model fixture. They do not authenticate with the messaging platforms.

## Prepare an isolated QQ pilot

1. Create `.lab/gateway` and restrict `.lab` to the local operator (mode `0700`). Resolve `AOA_LAB_ROOT` to the absolute physical `.lab` path. Use a distinct, loopback-only Gateway port and token. Set `OPENCLAW_STATE_DIR=$AOA_LAB_ROOT/gateway`, `OPENCLAW_HOME=$AOA_LAB_ROOT` and `OPENCLAW_CONFIG_PATH=$AOA_LAB_ROOT/gateway.json` **only in the pilot process**. Do not start the default gateway or call production restart scripts.
2. In that test config, use `plugins.load.paths` for the absolute stock QQ package and this package. Enable/allow `openclaw-qqbot` and `luke-aoa-async`. Under `plugins.entries.luke-aoa-async.config.routes`, list the exact allowed test destinations in the form `{ "channel": "qqbot", "account": "default", "to": "qqbot:group:<test-group-openid>" }` (use `qqbot:c2c:` for DM). Obtain these IDs from the **test** robot, never production. Retain the chosen pilot channel's normal access and mention policy.
3. Rotate the test AppSecret on QQ's platform and place the new value in a dedicated macOS Keychain entry. Inject it as `QQBOT_CLIENT_SECRET` using `security find-generic-password -s 'Luke AOA QQ Test' -w` in the pilot launch shell with shell tracing off. Supply the corresponding test `QQBOT_APP_ID`. Do not put the secret in a command argument, config file, fixture, or Git. No test credentials are stored here.
4. Put a separate `worker.json` in `.lab` with the selected model and `models.providers.<provider>.agentRuntime.id: "openclaw"`. Use a dedicated model credential, configure its supported environment reference, then set `AOA_WORKER_ENV` to the variable name (e.g. `ZAI_API_KEY`). Do not configure channels, `env`, agent lists or includes in the worker config. Start `node worker.mjs` in a separate terminal with `AOA_LAB_ROOT` and `AOA_OPENCLAW_BIN`. For PDF, set `AOA_PDFTOTEXT` to the absolute binary path before starting the worker.
5. Start the isolated Gateway in the foreground. Confirm the stock test QQ account connects; then submit both requests from the test client and send ordinary chat while a long run is active. Use `npm run status` from this directory with `AOA_LAB_ROOT` set to inspect job IDs, status and whether a receipt exists, without printing conversation text or secrets. Stop the pilot Gateway and worker to disable the trial; no production rollback is needed.
