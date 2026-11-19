# Hermes QQ shadow pilot

This is the first isolated vertical slice from the [agent evaluation](../../docs/aoa-agent-evaluation.md). It separates the QQ adapter from the agent: the existing receive-only inbox remains the input schema, its two-mode window planner is reused, and native Hermes API runs own session and work execution. No edits to either agent framework or to deployed channel plugins.

The bridge replays a selected window, or routes an @ to quick chat or a separate work run. Session IDs are namespaced by channel, bot account, and group. A work run has its own session, deterministic admission key and original source envelope. Only completed output is read; the bridge never forwards streamed thoughts or tool progress. The recorded source and stable receipt key are inputs for later delivery deduplication, not proof of actual QQ delivery.

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

For the next pilot, use separate isolated Hermes profiles for fast chat and tool-capable work, validate the actual group participant attribution before enabling Honcho, and use native Kanban for durable work instead of creating a new task database. Do not send a live message until an explicit test destination is selected and delivery replay/uncertainty has been tested.
