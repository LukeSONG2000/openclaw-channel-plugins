# Imagen

OpenClaw chat command backed by the [official OpenAI CLI](https://developers.openai.com/api/docs/libraries/openai-cli). It sends structured input to `images generate` or `images edit`, then delivers one image to the originating channel. No shell evaluation or chat-model intent inference is involved.

- `/imagen <prompt>`: Flare, low quality, 1024x1024 PNG.
- `/imagen gif <prompt>`: Flare, low quality, 512x512, 3 frames at 200 ms.
- `/imagen png high sunburst <prompt>`: opt in to high quality and Sunburst.
- `/imagen edit <changes>` with the original attached: edit the supplied image, defaulting to high quality and Sunburst.
- `/imagen ref <prompt>` with reference images attached: compose a new image, defaulting to low quality and Flare. Omitting `ref` when attaching images uses the same mode.

Attach PNG, JPEG or WebP in the same message as the command, up to 4 images, 10 MB each and 20 MB total. Quoted or historical media and paths in prompts are not inputs. QQ can use the command after a native bot mention. DingTalk delivers the output as a file attachment to preserve the original bytes.

QQ and DingTalk direct messages can submit requests. Groups require an exact channel-qualified ID in `allowedGroups` by default. Set `allowAllDingTalkGroups: true` to admit all DingTalk groups without changing the QQ allowlist. Channel admission and mention requirements still apply. Unknown routes fail closed. A single job can run at a time, with at least ten seconds between starts. No replay is initiated by the plugin when an image request has an unknown outcome.

## Runtime

- The manifest opts into gateway startup so the reply hook is installed before the first incoming message. A standalone plugin inspection alone does not verify gateway activation.
- Install an official OpenAI CLI build that accepts GPT Image 2.6 GIF options at `~/.openclaw/bin/openai-image-cli`.
- Store two distinct official API keys in `~/.openclaw/openai-image-private/accounts.json` as `{ "keys": [...] }` with file mode `0600`. Requests alternate starting accounts and check access to the selected model before generating.
- Store two HTTPS provider URLs as `{ "subscriptions": [...] }` in the same private directory. Run `proxy-config.mjs` with that file path; write the generated JSON privately to `proxy/config.json` and use the included user service to launch the existing Mihomo binary. The cache and Unix control socket stay in the private proxy directory.
- The dedicated listener binds only `127.0.0.1:17979`. Only `api.openai.com` is routable. The subscription fetch uses its own outbound route; it does not forward OpenAI credentials. Mihomo refreshes both subscriptions every 30 minutes and tests Japanese nodes against the OpenAI API every three minutes. A failed model preflight triggers one read-only proxy health refresh before attempting generation. Prefer Japan 2, fall back to healthy Japanese nodes, and exclude download-only nodes. No direct route is configured for image requests.
- The channel upload path must preserve animated GIF bytes. API generation and channel rendering are separate verification steps.

Run `node --test plugins/openai-image/index.test.mjs` from the repository root. Do not store live keys, subscription URLs, group IDs or generated output in Git.
