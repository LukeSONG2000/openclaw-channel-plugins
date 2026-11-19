# Hermes QQ shadow pilot

This is the first isolated vertical slice from the [agent evaluation](../../docs/aoa-agent-evaluation.md). It separates the QQ adapter from the agent: the existing receive-only inbox remains the input schema, its two-mode window planner is reused, and native Hermes API runs own session and work execution. No edits to either agent framework or to deployed channel plugins.

The bridge replays a selected window, or routes an @ to quick chat or a separate work run. Session IDs are namespaced by channel, bot account, group, source message, and lane. The trial supplies recent context from the group inbox so concurrent intent decisions do not wait on a single Hermes session lease. A work run has its own session, deterministic admission key and original source envelope. Only completed output is read; the bridge never forwards streamed thoughts or tool progress. The recorded source and stable receipt key are inputs for later delivery deduplication, not proof of actual QQ delivery.

## Smoke test with official Hermes

```sh
docker compose -f experiments/hermes-qq/compose.yaml up -d
docker compose -f experiments/hermes-qq/compose.yaml exec -T -u hermes \
  -e HERMES_QQ_FIXTURE_ORIGIN=http://127.0.0.1:8642 gateway \
  node --test /pilot/hermes-qq/pilot.test.mjs
docker compose -f experiments/hermes-qq/compose.yaml down -v
```

The published image is pinned to Hermes v0.23.2. The Compose network has no external egress; the API is reachable only from inside the gateway container. Wait for the gateway to be ready before running the test. The credentials and provider are local fixtures. Only synthetic messages are used. There is no QQ sender, live watcher, private mount, production configuration, or third-party model credential.

This test checks the adapter's source mapping, final-only output, Hermes concurrency, and idempotency. A deterministic provider does not validate real model intent accuracy, memory learning, QQ native quotes, or delivery. It deliberately does not replace the existing read-only test bot.

## Real-model shadow

`shadow-compose.yaml` starts a separate Hermes instance using the R2 model settings snapshot in `shadow-config.yaml`. Inject `ZAI_API_KEY` and a separate local `API_SERVER_KEY` through the launch environment, not the repository. The Compose environment pins `GLM_BASE_URL` as well: the provider's environment credentials can otherwise resolve the international alias despite the model URL in YAML. The API is inside the container on loopback, the provider requires outbound network, and this profile has no agent tools, memory learning, channel tokens, or private host mounts. It does not change the production model or service.

Run `node /pilot/hermes-qq/shadow.mjs probe` inside the gateway to verify the serving model. To test a batch, pipe a JSON envelope from `node experiments/hermes-qq/bound-sample.mjs <private-inbox.sqlite> <test-account>` to `node /pilot/hermes-qq/shadow.mjs window` via `docker compose exec -T -u hermes gateway`. This only selects up to eight recent plain messages in the previously verified test group and reports counts, not public replies. Do not print the JSON sample in between. The raw inbox is not mounted and the bridge does not continuously consume model quota.

## Explicit live group trial

Start `worker-compose.yaml` under its own Compose project, with the model credential and a distinct local API key supplied in its launch environment. The worker runs the same upstream Hermes image with separate state and network. Only Hermes' native `todo` toolset is enabled in the API profile; no shell, file, browser, chat, or host administration tools are available. The chat profile stays tool-free. The bridge checks the enabled toolsets before accepting work in either lane. No host data directories, Docker socket, or QQ credentials are mounted in either profile.

On macOS, run `node trial.mjs <private-inbox-dir> <absolute-sdk-esm-entry> <test-app-id> <keychain-service> <chat-container> <original-binding-token> <worker-container>` separately from the existing QQ receiver. This does not open a second WebSocket. The author who bound the verification group can chat normally: @ goes straight to the chat/worker router, and plain messages open a 60-second same-group window. The old prefix is not required. The trial expires in 30 minutes and admits at most six turns or windows. This is an operator test gate, not the final group permission model.

The same inbox supplies up to eight recent same-group context messages. Up to three @ messages may be classified concurrently, so an expensive routing decision does not block later quick chat. Hermes starts work under a separate run and reports the final answer back to the original source message; fast chat does not await that work. Windows may stay silent or send up to one natural line and one reply to a message inside that window. A later @ supersedes an unfinished window, not an independent work run. Natural replies are proactive QQ messages without a quote or mention; selected and direct replies carry the original QQ message ID. The private receipt table is claimed before sending and never replays an uncertain send. A QQ API receipt does not establish native quote rendering on the client. Other groups, late results and pre-trial messages never send.

Explicit requests to recap this group's discussions, such as `总结一下群里最近 24 小时的话题`, use a separate group-history capability. Only the host adapter reads the bound group's retained QQ inbox, excludes the request and messages received after it, and sends at most 72 text excerpts sampled across the requested 1-24 hours to the normal work lane. Ordinary chat still gets just its short context. The result labels its text coverage; no missing history or attachments are fetched, and no production logs or chat database are mounted for Hermes.

Replies to a direct @ use the QQ Markdown mention element. Only an explicit Markdown-permission rejection from the [group-send API](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html) permits a plain-text fallback with the same reply anchor and no mention.

The worker trial has a bounded send window: results are delivered only during the active trial and within three minutes of the original message. Pending work is not resumed by the bridge after a restart. For durable or longer work, evaluate native Kanban and validate how late results can still target the original QQ conversation. Validate participant attribution before enabling Honcho. Do not send a live message until an explicit test destination is selected and delivery replay/uncertainty has been tested.
