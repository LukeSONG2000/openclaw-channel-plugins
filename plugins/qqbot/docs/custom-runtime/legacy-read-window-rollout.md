# Legacy live read-window build

The 2026-11-20 runtime on R2 already moves selected messages to a separate
read-history buffer when a window is enqueued. It schedules the next poll at
that point, not at completion. Its installed TypeScript tree is older than
its executed JavaScript. Do not replace the live `dist` with a build of that
tree: doing so removes the read-context contract used by the gateway.

The rolling fix is limited to native batch admission: if a snapshot for
the same group is already in flight, keep polling on a short bounded timer
without claiming the new messages. Once a turn finishes, consume the next
window normally. Give a just-arrived continuation up to one short grace
period. Restore timers without restoring active model work after restart.

Evidence: the reported two sends came from different non-overlapping unread
snapshots in the same group, one at 20:48:01 and one at 20:48:57 (UTC+08:00).
The same enqueue-before-finish contract also permits overlap if new messages
are available while a prior model run is still active. Keep these two
failure modes separate from duplicate platform event IDs and transport
retries.
