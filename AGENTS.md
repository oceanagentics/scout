# Scout engineering constraints

- Do not add trial expirations or lifetime-use allowances to working features unless the user explicitly requests them.
- Scout saves useful findings, source URLs and minimal operational state. Read source bodies and model traffic in memory, then discard them. Do not persist captures, prepared documents, prompts, responses, quoted proof trails or operation reports.
- Work within the existing $0/month stack and shared project allowances. Before changing persistence or recurring work, estimate model calls, SQL statements/row mutations, retained bytes and daily activity; measure them before unattended operation. Actual account quotas and usage take precedence over public plan ceilings.
- Completed unchanged inputs make no model calls or finding writes. Keep retries finite, respect provider deadlines and preserve charges for uncertain requests. Missing or unverified budgets must not enable unlimited work.
- Store compact current state. Do not reconstruct routine scheduling or health from growing histories, or add a replacement tracing/replay system.
- Prove the requested user-visible result with a small end-to-end test before expanding scope. Distinguish mocked mechanics, real model correctness and measured database cost. Never label missing live validation a success.
- Keep changes minimal and remove obsolete paths. New tables, processing stages, jobs and abstractions need a concrete requirement. Preserve existing useful records, human corrections, access controls and unrelated work.
- Latest user direction controls scope. docs/architecture.md describes the current implementation. Historical plans and run notes in Git do not require preserving old architecture.
- Report scope, findings and remaining uncertainty before substantial changes and at meaningful milestones. Stop workers/automations when told to stop; resume only on user direction.
- Use the existing checkout and one authorized implementation writer. No clones/worktrees. Verify explicitly requested implementation and create one focused commit after review, excluding unrelated dirty work.

Current acceptance: build the simplified pipeline and test one record within verified model/SQL budgets. Keep recurring collection and notifications paused until reviewed. Legacy operational data cleanup was explicitly authorized on 11 October; preserve useful records, final facts, source URLs and any active quota/delivery accounting. Funding collection remains future work.
