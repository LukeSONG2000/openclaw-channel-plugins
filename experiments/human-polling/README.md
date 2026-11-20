# Human-style conversation polling

This feature decides when an agent checks an ambient conversation, independent of the model, inbox, and platform sender. Its defaults are 1 / 2 / 5 / 10 / 15 minutes: empty checks step up; a hit or a direct mention resets to the shortest interval. The stored revision invalidates older in-flight decisions. The caller provides a lazy unread snapshot and owns message consumption. If different channels share one ledger, namespace their account keys.

A platform delivery window is not a conversation schedule. Luke's QQ adapter can read messages after QQ stops accepting their reply anchors, then stay silent. It does not wake early to save old anchors and does not fall back to proactive sending. Time-of-day behavior can be added to the cadence policy later without changing how messages are read or sent.
