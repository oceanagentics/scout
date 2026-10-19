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
- Scout saves useful findings, source URLs and minimal operational state. Read source bodies and model traffic in memory, then discard them. Do not persist captures, prepared documents, prompts, responses, quoted proof trails or operation reports.
- Work within the existing $0/month stack and shared project allowances. Before changing persistence or recurring work, estimate model calls, SQL statements/row mutations, retained bytes and daily activity; measure them before unattended operation. Actual account quotas and usage take precedence over public plan ceilings.
- Each due tracker check calls the model; identical findings make no finding writes. Keep timeouts and finite retries. Actual provider context and account limits apply. Do not add Scout model usage ledgers, uncertain-charge reservations, spending policies or artificial content caps.
- Store compact current state. Do not reconstruct routine scheduling or health from growing histories, or add a replacement tracing/replay system.
- Prove the requested user-visible result with a small end-to-end test before expanding scope. Distinguish mocked mechanics, real model correctness and measured database cost. Never label missing live validation a success.
- Keep changes minimal and remove obsolete paths. New tables, processing stages, jobs and abstractions need a concrete requirement. Preserve existing useful records, access controls and unrelated work. Correction overrides and field provenance are removed; do not recreate them.
- Latest user direction controls scope. docs/architecture.md describes the current implementation. Historical plans and run notes in Git do not require preserving old architecture.
- Report scope, findings and remaining uncertainty before substantial changes and at meaningful milestones. Stop workers/automations when told to stop; resume only on user direction.
- Use the existing checkout and one authorized implementation writer. No clones/worktrees. Verify explicitly requested implementation and create one focused commit after review, excluding unrelated dirty work.

Current acceptance: build the simplified pipeline and test one record within provider allowances and measure its model/SQL cost. Keep recurring collection and notifications paused until reviewed. Legacy operational data cleanup was explicitly authorized on 11 October; preserve useful records, final facts, source URLs and notification delivery state. Model accounting and artificial content caps were explicitly removed on 19 October. Funding collection remains future work.
