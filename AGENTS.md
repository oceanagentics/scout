# Scout engineering constraints

## Design for the system we need now

- This system is under construction. Existing code, records, interfaces, and matching behavior are not automatically compatibility requirements. Preserve them only when explicitly required.
- Do not invent requirements such as extensibility, migration support, fallback behavior, or compatibility. Identify the concrete user requirement before designing around one.
- Consider solutions in this order: remove unnecessary behavior, change configuration, use an existing capability, modify existing code, add a new component.
- Fix responsibilities at their owner. If one field serves incompatible purposes, reconsider that design before adding translation layers to accommodate it.
- Do not generalize from one exceptional source into a framework. Prove the smallest solution on the actual case first.
- Replace obsolete behavior rather than maintaining parallel paths unless both are explicitly needed.
- Before proposing additional machinery, explain what simpler approach was considered, what observed limitation prevents it from working, and what maintenance the proposal introduces.

**Existing behavior is evidence about the implementation, not evidence of a requirement.**

## Operational constraints

- Do not add trial expirations or lifetime-use allowances to working features unless the user explicitly requests them.
- Scout saves useful findings, source URLs and minimal operational state. In production, read source bodies and model traffic in memory, then discard them. Do not persist captures, prepared documents, prompts, responses, quoted proof trails or operation reports. The existing [local diagnostic capture](diagnostics/README.md) is an authorized exception confined to local diagnostics; keep it outside hosted/browser imports and never deploy it.
- Work within the existing $0/month stack and shared project allowances. Before changing persistence or recurring work, estimate model calls, SQL statements/row mutations, retained bytes and daily activity; measure them before unattended operation. Actual account quotas and usage take precedence over public plan ceilings.
- Web checks investigate their URL; Bluesky author feeds investigate each new post and make no model calls when unchanged. Each investigation uses one primary model attempt and at most one fallback for eligible failures. Identical findings make no finding writes. Keep timeouts and finite tracker retries. Actual provider context and account limits apply. Do not add Scout model usage ledgers, uncertain-charge reservations, spending policies or artificial content caps.
- Collection resumes from successfully committed source progress so consumed feed posts are not investigated again. A new tracker or changed URL has a null checkpoint: no prior check. Never seed a checkpoint or substitute a rolling look-back window. A Bluesky first check consumes all available history oldest first across bounded attempts; later checks consume only posts newer than committed progress. Web-page checks currently investigate the page again; their completion timestamp is not an item-level checkpoint.
- Store compact current state. Do not reconstruct routine scheduling or health from growing histories, or add a replacement tracing/replay system.
- Prove the requested user-visible result with a small end-to-end test before expanding scope. Distinguish mocked mechanics, real model correctness and measured database cost. Never label missing live validation a success.
- Keep changes minimal and remove obsolete paths. New tables, processing stages, jobs and abstractions need a concrete requirement. Preserve existing useful records, access controls and unrelated work. Correction overrides and field provenance are removed; do not recreate them.
- Latest user direction controls scope. docs/architecture.md describes the current implementation. Historical plans and run notes in Git do not require preserving old architecture.
- Report scope, findings and remaining uncertainty before substantial changes and at meaningful milestones. Stop workers/automations when told to stop; resume only on user direction.
- Deployments must preserve each collection and notification job's prior active state. Pause jobs only when the release requires it, then restore previously active jobs after verification before finishing, including after reinstalling `supabase/scout-loop.sql`. Restoring a temporary deployment pause is part of the authorized deployment and needs no separate approval. Leave jobs paused only at the user's request or for a concrete unresolved failure; report the affected jobs and blocker.
- Use the existing checkout and one authorized implementation writer. No clones/worktrees. Verify explicitly requested implementation and create one focused commit after review, excluding unrelated dirty work.
- For authorized Supabase deployments, follow [README.md → Supabase deployment](README.md#supabase-deployment). Check credentials and execute the deployment within the granted scope; do not assume Danny must run it personally. Report the actual credential, tool-permission or HTTP error if blocked.

Current operation: recurring collection and notifications are authorized to run; preserve their operational state across deployments as described above. Do not recreate persistent notification send suppression. Funding collection remains future work.
