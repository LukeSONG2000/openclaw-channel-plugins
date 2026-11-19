# Imagen

OpenClaw chat command backed by the [official OpenAI CLI](https://developers.openai.com/api/docs/libraries/openai-cli). It sends structured input to `images generate` or `images edit`, then delivers one image to the originating channel. No shell evaluation or chat-model intent inference is involved.

- `/imagen <prompt>`: Sunburst, medium quality and high planning complexity, 1024x1024 PNG. Use `low` for a fast Flare draft.
- `/imagen gif <prompt>`: Flare, low quality, 512x512, 3 frames at 200 ms.
- `/imagen png high sunburst <prompt>`: opt in to high quality and Sunburst.
- `/imagen studio <prompt>`: compose a visual brief before rendering, with high quality and Sunburst by default.
- `/imagen edit <changes>` with the original attached: edit the supplied image, defaulting to high quality and Sunburst.
- `/imagen ref <prompt>` with reference images attached: compose a new image, defaulting to medium quality and Sunburst for stills. With no explicit mode, edits preserve only attributes the user did not ask to change.

Attach PNG, JPEG or WebP in the same message, or explicitly quote an image on QQ. QQ can also use the most recent user-supplied image bundle in the same conversation (ten minutes) when the request points to it. A correction can reuse the same sender's recent edit source only. Current attachments take precedence, then the explicit quote. Limit: 4 images, 10 MB each and 20 MB total. Unrelated history and paths in text are not inputs. QQ can use the command after a native bot mention. DingTalk displays PNGs inline using its uploaded image media ID, and sends GIFs as files to preserve animation.

Before rendering, a single tool-free OpenAI Responses call uses high reasoning effort to rewrite the request as a short visual brief. This is separate from the image model's `complexity` and render `quality`. The planner inspects actual pixels and never forwards reasoning output. Group-context requests use up to ten bounded, redacted recent text excerpts. If planning fails, image-based jobs stop without charging for an unplanned render.

QQ and DingTalk direct messages can submit requests. Groups require an exact channel-qualified ID in `allowedGroups` by default. Set `allowAllDingTalkGroups: true` to admit all DingTalk groups without changing the QQ allowlist. Channel admission and mention requirements still apply. Unknown routes fail closed. A single job can run at a time, with at least ten seconds between starts. No replay is initiated by the plugin when an image request has an unknown outcome.

Clearly addressed natural-language requests work without mentioning the skill name or using a slash command. In groups, use a native bot mention. “做一张动图” chooses GIF even with `/imagen` and no explicit format flag. A short correction such as “我要的是动态图” reuses only the sender's recent successful static text-to-image prompt in that same conversation, within five minutes, and does not reuse attachments. See [skill scenarios](skills/imagen/SKILL.md).

After a successful render, an explicit “重新画” follow-up can amend that sender's most recent Imagen request in the same account and conversation for two hours. At most three short intervening messages from that sender may inform the redraw; the latest correction takes priority over the original description. This temporary state is not persisted across restarts. Original reference images are revalidated if reused; no external image search or cross-conversation lookup is performed.

## Runtime

- The manifest opts into gateway startup so the reply hook is installed before the first incoming message. A standalone plugin inspection alone does not verify gateway activation.
- When Imagen is the sole image generator, deny OpenClaw's generic `image_generate` tool at the gateway. Do not deny the separate `image` analysis tool for this purpose; existing channel-specific restrictions still apply.
- Install an official OpenAI CLI build that accepts GPT Image 2.6 GIF options at `~/.openclaw/bin/openai-image-cli`.
- Store two distinct official API keys in `~/.openclaw/openai-image-private/accounts.json` as `{ "keys": [...] }` with file mode `0600`. Requests alternate starting accounts and check access to the selected model before generating.
- Store two HTTPS provider URLs as `{ "subscriptions": [...] }` in the same private directory. Run `proxy-config.mjs` with that file path; write the generated JSON privately to `proxy/config.json` and use the included user service to launch the existing Mihomo binary. The cache and Unix control socket stay in the private proxy directory.
- The user service restarts the proxy even after a clean process exit. An explicit `systemctl --user stop openai-image-proxy.service` still stops it for maintenance.
- Each subscription has its own loopback listener (`127.0.0.1:17979` and `127.0.0.1:17980`), restricted to `api.openai.com`. Mihomo refreshes subscriptions every 30 minutes and tests Japanese nodes against the OpenAI API every three minutes. Imagen reads Mihomo's subscription metadata before planning and rendering, skips known expired or exhausted subscriptions, and tries routes in order of remaining bytes (total minus upload and download, unknown last). Each route must first pass an unauthenticated OpenAI API probe. Within a subscription, prefer Japan 2, then healthy Japanese alternatives; exclude download-only nodes. If no eligible route passes, refresh group health once and retry only the probes. No direct route is configured for image requests, and uncertain renders are not replayed.
- The channel upload path must preserve animated GIF bytes. API generation and channel rendering are separate verification steps.

Run `node --test plugins/openai-image/index.test.mjs` from the repository root. Do not store live keys, subscription URLs, group IDs or generated output in Git.
