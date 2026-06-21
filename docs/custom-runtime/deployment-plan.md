# Deployment Plan

## Strategy

Deploy the custom fork as the only active QQBot channel in the OpenClaw instance.

Operational model:

- The server runs the custom package, not the official package.
- The production instance must not auto-update the QQBot connector.
- Official upstream updates are reviewed locally first; they are not pulled directly into the deployed OpenClaw instance.
- If an upstream change is worth adopting, merge or cherry-pick it into `custom-runtime`, validate it, then publish a new personal package version.
- The OpenClaw instance automatically checks only the personal package for newer custom versions, then waits for admin approval before installation.

Do not run both the official QQBot plugin and the custom QQBot plugin against the same bot credentials. That risks:

- duplicate gateway connections
- duplicate replies
- message queue races
- double consumption of limited passive reply quota
- config and state conflicts under `~/.openclaw/qqbot`

## Package Identity

Preferred first step:

- Keep channel id `qqbot`.
- Keep plugin id `openclaw-qqbot` during migration so OpenClaw channel loading, config keys, and existing state paths stay stable.
- Publish/install the custom build under a personal npm package name:
  - package name: `@lukesong/openclaw-qqbot`
  - version line: `1.7.2-luke.N`, then bump `N` for each custom release.
- Treat the npm package name as the update source. The OpenClaw plugin id remains the runtime slot.

Open item:

- Verify whether OpenClaw plugin loader keys the installed plugin by `package.json openclaw.id`, `openclaw.plugin.json id`, package name, or config `plugins.entries`. Do not rename plugin id until loader behavior is confirmed.

## Instance Update Mode

The deployed OpenClaw instance should check only the custom package by default.

Recommended config:

```json
{
  "channels": {
    "qqbot": {
      "upgradePkg": "lukesong/openclaw-qqbot",
      "upgradeMode": "doc",
      "allowUpgradePkgOverride": false,
      "customUpdateCheck": {
        "enabled": true,
        "intervalMs": 21600000
      }
    }
  }
}
```

Behavior:

- `/bot-version` shows the current plugin version and the npm package used for update checks.
- `/bot-upgrade` checks `@lukesong/openclaw-qqbot` and returns guidance by default.
- The gateway starts a background custom update check loop against `@lukesong/openclaw-qqbot`; it logs availability, can notify `customRuntime.adminGroup`, and never installs by itself.
- Hot reload is available only if `upgradeMode` is explicitly set to `hot-reload`; even then, install starts only after the admin sends `/bot-upgrade --latest` or `/bot-upgrade --version X`.
- `--pkg` is rejected unless `allowUpgradePkgOverride=true`; keep it disabled on the production instance so the bot cannot be accidentally switched back to the official `@tencent-connect/openclaw-qqbot` package.
- Hot reload downloads the upgrade script from the personal `custom-runtime` branch by default. Override `QQBOT_UPGRADE_SCRIPT_URL` only for manual emergency maintenance.

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
scp ./lukesong-openclaw-qqbot-*.tgz laptop-home:/tmp/
ssh laptop-home 'cd ~/.openclaw/extensions && npm install /tmp/lukesong-openclaw-qqbot-*.tgz'
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
5. With `channels.qqbot.customRuntime.enabled=true`, a later group mention receives the recorded unread history in context.
6. If autonomous/proactive policy is enabled for the scene, a synthetic catch-up is sent without a fake passive `msg_id`.
7. Unauthorized member attempts config/rule change and is blocked.
8. Admin approval request is sent.
9. Timeout simulation releases queue and urgent `/new` or `/compact` still works.
10. Rollback test path is documented and executable.

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

Official releases are input for local review only; they are not the server's update source.

1. Fetch upstream locally. This only updates local git refs; it does not affect the deployed OpenClaw instance:

```bash
git fetch upstream
git log --oneline --decorate custom-runtime..upstream/main
git diff --stat custom-runtime..upstream/main
```

2. Read changelog/diff and decide whether the official change is worth adopting.
3. Merge or cherry-pick into the personal branch:

```bash
git checkout custom-runtime
git merge upstream/main
```

4. Resolve conflicts in favor of keeping `src/custom/*`, personal package identity, and the custom update policy.
5. Run build/tests.
6. Publish a new `@lukesong/openclaw-qqbot` version only after validation.
7. The deployed instance discovers the new personal package version through its background custom update check loop and through `/bot-version`; install still waits for explicit admin confirmation.

Custom runtime updates:

- The OpenClaw instance checks only `@lukesong/openclaw-qqbot` unless overridden.
- The gateway logs available custom updates automatically and sends the management group a guarded prompt with `/bot-version` and `/bot-deploy confirm /bot-upgrade --latest` buttons when `customRuntime.adminGroup` is bound.
- Admin reviews the detected custom version, creates/confirms a deploy card if needed, then explicitly performs the final install command after backup.
- Server backs up current plugin before update.

## Release Checklist

For each custom release:

1. Bump `package.json` version, for example `1.7.2-luke.2`.
2. Run:

```bash
npm run build
npx tsx tests/custom-runtime.test.ts
npx tsx tests/update-checker.test.ts
```

3. Commit and push `custom-runtime`.
4. Publish or pack the personal package.
5. On the server, check `/bot-version`; it should show `📦更新检查源：@lukesong/openclaw-qqbot`.
