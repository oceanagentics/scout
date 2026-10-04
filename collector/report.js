// Run-local checkpoints. Bodies live once in report.artifacts; source payloads
// remain in evidence. Never pass transport options, headers or environment here.
export async function startReport(db, runId) {
  const report = { version: 1, path: 'legacy-scripted', operations: {}, artifacts: {} };
  await db.query('update scout.collection_runs set report=$2::jsonb where id=$1', [runId, JSON.stringify(report)]);
  let operation = 0, artifact = 0;
  const write = (group, id, value) => db.query(
    'update scout.collection_runs set report=jsonb_set(report,ARRAY[$2,$3],$4::jsonb) where id=$1',
    [runId, group, id, JSON.stringify(value)]);
  return {
    report,
    async artifact(kind, title, data, reference = {}) {
      const id = 'a' + ++artifact;
      await write('artifacts', id, { kind, title, ...reference, ...(data === undefined ? {} : { data }) });
      return id;
    },
    async start(step, details = {}) {
      const id = 'o' + ++operation;
      report.operations[id] = { step, state: 'running', started_at: new Date().toISOString(), ...details };
      await write('operations', id, report.operations[id]);
      return id;
    },
    async finish(id, state, details = {}) {
      Object.assign(report.operations[id], details, { state, finished_at: state==='running'?null:new Date().toISOString() });
      await write('operations', id, report.operations[id]);
    },
    async skip(step, note) {
      if (Object.values(report.operations).some(o => o.step === step)) return;
      const id = await this.start(step, { note });
      await this.finish(id, 'skipped');
    },
    async capture(source) {
      return this.artifact('capture', 'Captured source payload', undefined, {
        source_id: source.id, content_hash: source.content_hash, url: source.url,
      });
    },
  };
}
