// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
let db: import("better-sqlite3").Database;
let store: typeof import("../../server/scanIntelStore");
let queries: {count:string;stranded:string};
beforeAll(async()=>{
  process.env.DATA_DIR=mkdtempSync(join(tmpdir(),"hf-backlog-plan-"));
  (await import("../../server/storage")).runMigrations();
  db=(await import("../../server/db")).rawDb;
  store=await import("../../server/scanIntelStore");
  store.getResumableRuns(); // startup initializes the legacy reopen_count column
  const run=db.prepare(`INSERT INTO scan_runs(id,tenant_id,kind,label,budget,status,started_at,completed_at)
    VALUES (?,?,'market','Synthetic backlog',2,?,datetime('now','-1 day'),?)`);
  const target=db.prepare("INSERT INTO scan_run_targets(run_id,target_id,seq,state,next_attempt_at) VALUES (?,?,?,?,?)");
  const past="2026-01-01 00:00:00",future="2099-01-01 00:00:00";
  db.transaction(()=>{
    for(let i=1;i<=60_000;i++){
      run.run(`history-${i}`,i%3+1,"done",new Date(1_700_000_000_000+i*1000).toISOString());
      target.run(`history-${i}`,i*2,0,"verified",null);target.run(`history-${i}`,i*2+1,1,"failed",null);
    }
    let id=200_000;
    for(const state of ["queued","inflight","verified","skipped","QUEUED"," queued"])
      for(const status of ["done","error","running","paused","cancelled"])
        for(const due of [null,past,new Date().toISOString().replace("T"," ").slice(0,19),future]){
          const key=`matrix-${++id}`;run.run(key,id%3+1,status,new Date(1_700_000_000_000+id*1000).toISOString());
          target.run(key,id,0,state,due);
        }
  })();
  const spy=vi.spyOn(db,"prepare");store.countClaimableQueued();store.getStrandedDoneRuns();
  const sql=spy.mock.calls.map(([query])=>query);spy.mockRestore();
  queries={count:sql.find(query=>query.includes("SELECT COUNT(*) FROM scan_run_targets"))!,stranded:sql.find(query=>query.includes("SELECT r.id"))!};
});
it("uses the covering pending due-time ranges in both actual queries, before and after ANALYZE",()=>{
  for(const analyze of [false,true]){
    if(analyze)db.exec("ANALYZE");
    for(const [kind,sql] of Object.entries(queries)){
      const args=kind==="count"?[]:[10];
      const plan=db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r:any)=>r.detail).join("\n");
      expect(plan).toMatch(/SEARCH (?:t|scan_run_targets) USING COVERING INDEX idx_srt_pending_due_run \(state=\? AND next_attempt_at[=<]\?\)/);
    }
  }
});
it("preserves due times, run states, counts and complete row ordering across three tenants",()=>{
  const originalCount="SELECT COUNT(*) c FROM scan_run_targets WHERE state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=datetime('now'))";
  expect(store.countClaimableQueued()).toBe(15);
  expect(db.prepare(queries.count).get()).toEqual(db.prepare(originalCount).get());
  const originalRuns=queries.stranded.replace(" AND t.state IN ('queued','inflight')","");
  for(const limit of [1,10,100,1000]){
    const rows=store.getStrandedDoneRuns(limit);
    expect(rows).toEqual(db.prepare(originalRuns).all(limit));
    expect(rows.every(row=>row.status==="done"||row.status==="error")).toBe(true);
  }
});
