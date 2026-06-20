# Deployment Plan

## Strategy

Deploy the custom fork as the only active QQBot channel in the OpenClaw instance.

Do not run both the official QQBot plugin and the custom QQBot plugin against the same bot credentials. That risks:

- duplicate gateway connections
- duplicate replies
- message queue races
- double consumption of limited passive reply quota
- config and state conflicts under `~/.openclaw/qqbot`

## Package Identity

Preferred first step:

- Keep channel id `qqbot`.
- Keep plugin id compatible only during migration if OpenClaw expects `openclaw-qqbot`.
- Change package name/version to clearly identify custom build before publishing/installing:
  - package name candidate: `@lukesong/openclaw-qqbot`
  - version candidate: `1.7.2-luke.1`

Open item:

- Verify whether OpenClaw plugin loader keys the installed plugin by `package.json openclaw.id`, `openclaw.plugin.json id`, package name, or config `plugins.entries`. Do not rename plugin id until loader behavior is confirmed.

## Server Backup Before First Deploy

Before replacing server QQBot:

```bash
ts=$(date +%Y%m%d-%H%M%S)
cp -a ~/.openclaw/extensions/node_modules/@tencent-connect/openclaw-qqbot ~/.openclaw/extensions/openclaw-qqbot.backup.custom-runtime-$ts
cp -a ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.backup.custom-runtime-$ts
cp -a ~/.openclaw/qqbot ~/.openclaw/qqbot.backup.custom-runtime-$ts
```

Also record:

```bash
systemctl --user status openclaw-gateway --no-pager
node ~/.nvm/versions/node/v24.14.0/lib/node_modules/openclaw/dist/index.js --version
```

## Build And Install Options

Option A, npm tarball from local branch:

```bash
npm install
npm run build
npm pack
scp ./tencent-connect-openclaw-qqbot-*.tgz laptop-home:/tmp/
ssh laptop-home 'cd ~/.openclaw/extensions && npm install /tmp/tencent-connect-openclaw-qqbot-*.tgz'
```

Option B, GitHub release tarball:

```bash
npm install @lukesong/openclaw-qqbot@1.7.2-luke.1
```

Option C, source checkout on server:

Use only for development. It is easier to debug but easier to accidentally leave dirty state.

## Restart And Health Check

Restart:

```bash
systemctl --user restart openclaw-gateway
```

Check:

```bash
systemctl --user status openclaw-gateway --no-pager
journalctl --user -u openclaw-gateway -n 200 --no-pager
```

Expected:

- Gateway process stays up.
- QQBot token fetch succeeds.
- QQBot gateway reaches READY/RESUMED.
- No config schema rejection.
- No duplicate QQBot gateway instances.

## Validation Targets

User requested:

- Test group raw QQ number: `945739251`
- Test group label: `Master Luke的图书馆`
- Test DM raw QQ number: `1137586795`
- Test DM label: `Luke今天喝什么`

Because QQBot events expose openids instead of raw QQ numbers, first validation must map:

- `945739251` -> `group_openid`
- `1137586795` -> `user_openid`
- group member -> `member_openid`

Mapping method:

1. Send a fresh message in the test group and DM.
2. Inspect gateway logs and `known-users.json`.
3. Store alias mapping under custom runtime config.

## Minimal Validation Sequence

1. DM `/bot-ping` or equivalent lightweight command.
2. DM normal text reply.
3. Group mention reply in `Master Luke的图书馆`.
4. Group non-mention message is recorded but does not immediately reply.
5. Unauthorized member attempts config/rule change and is blocked.
6. Admin approval request is sent.
7. Timeout simulation releases queue and urgent `/new` or `/compact` still works.
8. Rollback test path is documented and executable.

## Rollback

Rollback should restore plugin package, config, and state backup, then restart:

```bash
systemctl --user stop openclaw-gateway
rm -rf ~/.openclaw/extensions/node_modules/@tencent-connect/openclaw-qqbot
cp -a ~/.openclaw/extensions/openclaw-qqbot.backup.custom-runtime-YYYYMMDD-HHMMSS ~/.openclaw/extensions/node_modules/@tencent-connect/openclaw-qqbot
cp -a ~/.openclaw/openclaw.json.backup.custom-runtime-YYYYMMDD-HHMMSS ~/.openclaw/openclaw.json
systemctl --user start openclaw-gateway
```

Keep rollback backups until the custom runtime has survived at least one day of real use.

## Update Policy

Official upstream updates:

- Fetch upstream.
- Read changelog and diff.
- Decide whether to merge/cherry-pick.
- Run tests.
- Publish new custom version only after validation.

Custom runtime updates:

- OpenClaw instance checks only custom releases or custom manifest.
- Notify admin of available custom update.
- Admin explicitly approves install.
- Server backs up current plugin before update.
