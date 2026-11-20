# Agent and channel development

- Treat reported examples as regression cases. Trace the failure to the shared capability that owns it (ingress, context, identity, task execution, tools, or delivery) before choosing where to change code.
- Prefer a verified native API, tool, or maintained upstream plugin. Add a thin adapter only for a proven contract gap. Extend an existing capability before adding a feature-specific route, keyword, prompt, store, or scheduler. Do not add a generic framework for a hypothetical need.
- Work through adjacent cases: @ and ambient chat, group and DM, text and attachments, quick chat and background work. Keep authorization and data scope at trusted boundaries. A product or platform exception belongs in its adapter, not in shared behavior.
- Validate the reported case, a different use of the same contract, and a failure or isolation case where appropriate. Record whether evidence is from source, tests, a running service, or platform delivery. A temporary mitigation needs a removal condition.
- Keep the Luke pilot and production R2 isolated. Migrating a capability means preserving its contract and reusing its implementation where possible, not copying the old channel or changing production as part of an experiment.
