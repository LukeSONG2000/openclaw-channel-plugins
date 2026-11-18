# Imagen

OpenClaw chat command backed by the [official OpenAI CLI](https://developers.openai.com/api/docs/libraries/openai-cli). It passes structured request data on stdin to `images generate`, decodes one result and hands off the unconverted media to the current channel. No UI, shell evaluation or model-based intent inference is involved.

- `/imagen <prompt>`: Flare, low quality, 1024x1024 PNG.
- `/imagen gif <prompt>`: Flare, low quality, 512x512, 3 frames at 200 ms.
- `/imagen png high sunburst <prompt>`: opt in to high quality and Sunburst.

Only QQ and DingTalk direct messages, or exact channel-qualified group IDs in the plugin `allowedGroups` configuration, can submit a request. Channel admission and mention requirements still apply. Unknown routes fail closed. A single job can run at a time, with at least ten seconds between starts. No replay is initiated by the plugin when an image request has an unknown outcome.

## Runtime

- Install an official OpenAI CLI build that accepts GPT Image 2.6 GIF options at `~/.openclaw/bin/openai-image-cli`.
- Store two distinct official API keys in `~/.openclaw/openai-image-private/accounts.json` as `{ "keys": [...] }` with file mode `0600`. Requests alternate starting accounts and check access to the selected model before generating.
- Store two HTTPS provider URLs as `{ "subscriptions": [...] }` in the same private directory. Run `proxy-config.mjs` with that file path; write the generated JSON privately to `proxy/config.json` and use the included user service to launch the existing Mihomo binary. The cache and Unix control socket stay in the private proxy directory.
- The dedicated listener binds only `127.0.0.1:17979`. Only `api.openai.com` is routable. The subscription fetch uses its own outbound route; it does not forward OpenAI credentials. Mihomo refreshes both subscriptions every 30 minutes and tests Japanese nodes against the OpenAI API every three minutes. Prefer Japan 2, fall back to healthy Japanese nodes, and exclude download-only nodes. No direct route is configured for image requests.
- The channel upload path must preserve animated GIF bytes. API generation and channel rendering are separate verification steps.

Run `node --test plugins/openai-image/index.test.mjs` from the repository root. Do not store live keys, subscription URLs, group IDs or generated output in Git.
