// Compatibility only for the deployed precompiled read-history adapter.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('pass the staged dist/src/custom directory');
const runtime = join(root, 'unread-runtime.js');
const scheduler = join(root, 'unread-scheduler.js');
const source = readFileSync(runtime, 'utf8');
const schedule = readFileSync(scheduler, 'utf8');
if (!source.includes('const readContext = peer.readHistory.slice();') ||
    !source.includes('markEntriesRead(peer, entries, params.cfg.readHistoryLimit)') ||
    !source.includes('return [enqueueIntent, scheduleIntent]') || source.includes('const continuationWaitMs')) {
  throw new Error('unexpected or already patched production runtime');
}
function replaceOnce(value, before, after) {
  if (value.split(before).length !== 2) throw new Error('ambiguous runtime signature');
  return value.replace(before, () => after);
}
const next = replaceOnce(source, '        const entries = peer.history.slice();', `        const continuationWaitMs = 10_000;
        const defer = (wait) => {
            peer.followupActive = true;
            peer.scheduledFollowupDueAt = now + wait;
            return [{ kind: "schedule-followup", peerId: params.peerId, dueAt: peer.scheduledFollowupDueAt, source: "followup" }];
        };
        if ([...this.snapshots.values()].some(snapshot => snapshot.peerId === params.peerId && !isSnapshotExpired(snapshot, now))) {
            return defer(continuationWaitMs);
        }
        const last = peer.history.at(-1);
        if (params.source === "followup" && last && last.timestamp <= now &&
            last.timestamp > now - continuationWaitMs && !peer.continuationDeferred) {
            peer.continuationDeferred = true;
            return defer(continuationWaitMs);
        }
        peer.continuationDeferred = false;
        const entries = peer.history.slice();`);
const updated = replaceOnce(next, '    consumeSnapshot(snapshotId) {',
  '    releaseAllSnapshots() { this.snapshots.clear(); }\n    consumeSnapshot(snapshotId) {');
const updatedScheduler = replaceOnce(schedule, '    restore(state) {',
  '    restore(state) {\n        this.options.unread.releaseAllSnapshots();');
writeFileSync(runtime, updated);
writeFileSync(scheduler, updatedScheduler);
