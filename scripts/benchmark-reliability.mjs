// Synthetic local SQLite benchmark. No application/server imports or network calls.
// NODE_ENV=test node scripts/benchmark-reliability.mjs "$PWD" /tmp/hf-benchmark
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, statSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cpus, platform, release, tmpdir } from 'node:os';
if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required');
const repo = process.argv[2];
if (!repo) throw new Error('Pass the worktree path to resolve better-sqlite3 and read SQL source');
const require = createRequire(join(repo, 'package.json'));
const Database = require('better-sqlite3');
const dir = process.argv[3] || mkdtempSync(join(tmpdir(), 'hf-reliability-benchmark-'));
mkdirSync(dir, {recursive:true});
const result = { generatedAt: new Date().toISOString(), runtime: { node: process.version, sqlite: null, platform: platform(), release: release(), cpu: cpus()[0]?.model }, method: { fixtureRows: 500000, runRows: 50000, readSamples: 7, writeSamples: 7, batchSize: 500, journalMode: 'WAL', synchronous: 'NORMAL', walAutocheckpoint: 0, caveat: 'Synthetic local cached SQLite CPU/write timing, not production load, soak, or durability latency. Daily fixture includes existing canonical/scanned/reprobe/fresh-opportunity/market-sync indexes; unrelated write fields and provider work are excluded. Fixture database files removed at completion. Dates fixed to preserve due classification.' }, recovery: [], daily: null };
const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const rounded = n => Math.round(n*1000)/1000;
const timing = fn => { fn(); const xs=[]; for(let i=0;i<7;i++){const t=performance.now();fn();xs.push(performance.now()-t);} return {medianMs:rounded(median(xs)),minMs:rounded(Math.min(...xs)),maxMs:rounded(Math.max(...xs))}; };
const fileBytes = path => {try{return statSync(path).size;}catch{return 0;}};
const explain = (db,sql,params=[]) => db.prepare('EXPLAIN QUERY PLAN '+sql).all(...params).map(row=>row.detail);
function database(name) { const path=join(dir,name+'.sqlite'); const db=new Database(path); db.pragma('journal_mode=WAL');db.pragma('synchronous=NORMAL');db.pragma('wal_autocheckpoint=0'); result.runtime.sqlite ||= db.prepare('SELECT sqlite_version() v').get().v; return {db,path,close(){db.close();for(const suffix of ['', '-wal','-shm'])rmSync(path+suffix,{force:true});}}; }
function pages(db) {return db.prepare("SELECT name,COUNT(*) pages,SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY name").all();}
function indexCost(db,path,sql) {db.pragma('wal_checkpoint(TRUNCATE)');const before=pages(db),totalBefore=db.pragma('page_count',{simple:true});const started=performance.now();db.exec(sql);const buildMs=rounded(performance.now()-started);return {buildMs,newDatabasePages:db.pragma('page_count',{simple:true})-totalBefore,walBytes:fileBytes(path+'-wal'),before,after:pages(db)};}
function claimWriteCost(db,ids) {const set=db.prepare('UPDATE scan_run_targets SET state=? WHERE run_id=? AND target_id=?');const tx=db.transaction(state=>{for(const {run_id,target_id} of ids)set.run(state,run_id,target_id);});const xs=[];for(let i=0;i<8;i++){const t=performance.now();tx('inflight');const ms=performance.now()-t;tx('queued');if(i)xs.push(ms);}return {rows:ids.length,medianMs:rounded(median(xs)),minMs:rounded(Math.min(...xs)),maxMs:rounded(Math.max(...xs)),operation:'500 guarded-by-primary-key queued to inflight updates in one transaction; restore queued outside timer'};}
function queueInsertCost(db) {const insert=db.prepare("INSERT INTO scan_run_targets(run_id,target_id,seq,state,result,next_attempt_at) VALUES ('run-1',?,?, 'queued',NULL,NULL)");const tx=db.transaction(()=>{for(let i=0;i<500;i++)insert.run(1000000+i,i);});const del=db.prepare("DELETE FROM scan_run_targets WHERE run_id='run-1' AND target_id>=1000000");const xs=[];for(let i=0;i<8;i++){const t=performance.now();tx();const ms=performance.now()-t;del.run();if(i)xs.push(ms);}return {rows:500,medianMs:rounded(median(xs)),minMs:rounded(Math.min(...xs)),maxMs:rounded(Math.max(...xs)),operation:'500 queued inserts in one transaction; cleanup outside timer'};}
const columns = `r.id,r.tenant_id AS tenantId,r.kind,r.label,r.city,r.state,r.bbox,r.budget,r.verified,r.new_fiber AS newFiber,r.newly_live AS newlyLive,r.failed,r.status,r.error,r.est_bytes AS estBytes,r.created_by AS createdBy,r.started_at AS startedAt,r.heartbeat_at AS heartbeatAt,r.completed_at AS completedAt,r.reopen_count AS reopenCount`;
const dueOr = "SELECT t.run_id FROM scan_run_targets t WHERE t.state='queued' AND t.state IN ('queued','inflight') AND (t.next_attempt_at IS NULL OR t.next_attempt_at<=datetime('now'))";
const dueRanges = "SELECT t.run_id FROM scan_run_targets t WHERE t.state='queued' AND t.state IN ('queued','inflight') AND t.next_attempt_at IS NULL UNION ALL SELECT t.run_id FROM scan_run_targets t WHERE t.state='queued' AND t.state IN ('queued','inflight') AND t.next_attempt_at<=datetime('now')";
const runQuery = inner => `SELECT ${columns} FROM scan_runs r WHERE r.status IN ('done','error') AND r.id IN (${inner}) ORDER BY r.completed_at ASC LIMIT ?`;
const countOr = "SELECT COUNT(*) c FROM scan_run_targets WHERE state='queued' AND state IN ('queued','inflight') AND (next_attempt_at IS NULL OR next_attempt_at<=datetime('now'))";
const countRanges = "SELECT (SELECT COUNT(*) FROM scan_run_targets WHERE state='queued' AND state IN ('queued','inflight') AND next_attempt_at IS NULL)+(SELECT COUNT(*) FROM scan_run_targets WHERE state='queued' AND state IN ('queued','inflight') AND next_attempt_at<=datetime('now')) c";
const recoveryIndex="CREATE INDEX idx_srt_pending_due_run ON scan_run_targets(state,next_attempt_at,run_id) WHERE state IN ('queued','inflight')";
result.recoverySql = {baseline:runQuery(dueOr),ranges:runQuery(dueRanges),countOr,countRanges,index:recoveryIndex};
for(const scenario of ['dense-due','dense-future','sparse-due']) {
 const f=database(scenario),db=f.db;
 try {
  db.exec(`CREATE TABLE scan_runs(id TEXT PRIMARY KEY,tenant_id INTEGER,kind TEXT,label TEXT,city TEXT,state TEXT,bbox TEXT,budget INTEGER,verified INTEGER,new_fiber INTEGER,newly_live INTEGER,failed INTEGER,status TEXT,error TEXT,est_bytes INTEGER,created_by INTEGER,started_at TEXT,heartbeat_at TEXT,completed_at TEXT,reopen_count INTEGER);CREATE INDEX idx_scan_runs_status ON scan_runs(status);CREATE INDEX idx_scan_runs_tenant ON scan_runs(tenant_id,started_at DESC);CREATE TABLE scan_run_targets(run_id TEXT NOT NULL,target_id INTEGER NOT NULL,seq INTEGER NOT NULL,state TEXT NOT NULL,result TEXT,next_attempt_at TEXT,attempt_count INTEGER DEFAULT 0,PRIMARY KEY(run_id,target_id));CREATE INDEX idx_srt_run_state ON scan_run_targets(run_id,state,seq);CREATE INDEX idx_srt_target_state ON scan_run_targets(target_id,state);CREATE INDEX idx_srt_pending ON scan_run_targets(state) WHERE state IN ('queued','inflight');`);
  const ir=db.prepare(`INSERT INTO scan_runs(id,tenant_id,kind,label,budget,verified,new_fiber,newly_live,failed,status,est_bytes,started_at,completed_at,reopen_count) VALUES(?,?,'market','Synthetic',100,0,0,0,0,?,0,'2026-01-01',?,0)`);
  const it=db.prepare('INSERT INTO scan_run_targets(run_id,target_id,seq,state,result,next_attempt_at) VALUES(?,?,?,?,?,?)');
  db.transaction(()=>{for(let i=0;i<50000;i++)ir.run('run-'+i,i%3+1,i%7===0?'running':i%11===0?'cancelled':i%13===0?'error':'done',new Date(1700000000000+i*1000).toISOString());for(let i=0;i<500000;i++){const pending=scenario==='sparse-due'?i%1000===0:i%5!==0;const due=scenario==='dense-future'&&i%100!==1?'2099-01-01 00:00:00':i%2?'2026-01-01 00:00:00':null;it.run('run-'+(i%50000),i,Math.floor(i/50000),pending?'queued':'verified','x'.repeat(120),pending?due:null);}})();
  db.exec('ANALYZE');db.pragma('wal_checkpoint(TRUNCATE)');
  const pendingIds=db.prepare("SELECT run_id,target_id FROM scan_run_targets WHERE state='queued' LIMIT 500").all();
  const read=(sql,count)=>({stranded:timing(()=>db.prepare(sql).all(10)),count:timing(()=>db.prepare(count).get()),strandedPlan:explain(db,sql,[10]),countPlan:explain(db,count),dueCount:db.prepare(count).get().c});
  const entry={scenario,baseline:read(runQuery(dueOr),countOr),writesBefore:{claim:claimWriteCost(db,pendingIds),insert:queueInsertCost(db)},index:null,covering:null,rangesStaleStats:null,rangesAnalyzed:null,writesAfter:null,equivalentFullRows:false};
  entry.index=indexCost(db,f.path,recoveryIndex);
  entry.covering=read(runQuery(dueOr),countOr);entry.rangesStaleStats=read(runQuery(dueRanges),countRanges);
  db.exec('ANALYZE');entry.rangesAnalyzed=read(runQuery(dueRanges),countRanges);
  entry.equivalentFullRows=JSON.stringify(db.prepare(runQuery(dueOr)).all(1000))===JSON.stringify(db.prepare(runQuery(dueRanges)).all(1000));
  if(!entry.equivalentFullRows||entry.baseline.dueCount!==entry.rangesAnalyzed.dueCount)throw new Error('Recovery semantic mismatch');
  entry.writesAfter={claim:claimWriteCost(db,pendingIds),insert:queueInsertCost(db)};
  result.recovery.push(entry);console.log(JSON.stringify({scenario,before:entry.baseline.stranded.medianMs,cover:entry.covering.stranded.medianMs,after:entry.rangesAnalyzed.stranded.medianMs}));
 } finally {f.close();}
}
const dailySource=readFileSync(join(repo,'server/dailyRefreshMetrics.ts'),'utf8');
const dailySql=dailySource.match(/export const DAILY_REFRESH_COUNTS_SQL = `([\s\S]+?)`;/)[1];
const dailyIndexes=[...dailySource.matchAll(/db\.exec\(`([\s\S]+?)`\)/g)].map(m=>m[1]);
if(dailyIndexes.length!==2)throw new Error('Reinspect changed daily index source');
result.dailySql={counts:dailySql,indexes:dailyIndexes};
const f=database('daily-counts'),db=f.db;
try {
 db.exec(`CREATE TABLE scan_targets(id INTEGER PRIMARY KEY,tenant_id INTEGER,address TEXT,city TEXT,state TEXT,zip TEXT,source TEXT,last_scanned_at TEXT,first_seen_fiber_at TEXT,payload TEXT,inconclusive_attempts INTEGER DEFAULT 0,last_customer_segment TEXT,last_is_new_fiber INTEGER DEFAULT 0,first_seen_live_at TEXT,canonical_key TEXT);CREATE INDEX idx_scan_targets_canonical ON scan_targets(tenant_id,canonical_key);CREATE INDEX idx_scan_targets_scanned ON scan_targets(last_scanned_at);CREATE INDEX idx_scan_targets_reprobe ON scan_targets(last_scanned_at,inconclusive_attempts);CREATE INDEX idx_scan_targets_fresh_opportunity ON scan_targets(first_seen_fiber_at,last_customer_segment);CREATE INDEX idx_scan_targets_market_sync ON scan_targets(lower(city),state,last_scanned_at,last_is_new_fiber,first_seen_fiber_at,first_seen_live_at);CREATE TABLE leads(id INTEGER PRIMARY KEY,tenant_id INTEGER,lead_tag TEXT,created_at TEXT);CREATE INDEX idx_leads_tenant ON leads(tenant_id);CREATE TABLE kinetic_addresses(id INTEGER PRIMARY KEY,tenant_id INTEGER,is_coming_soon INTEGER);CREATE INDEX idx_kinetic_addresses_tenant ON kinetic_addresses(tenant_id);`);
 const target=db.prepare('INSERT INTO scan_targets(id,tenant_id,address,city,state,zip,source,last_scanned_at,first_seen_fiber_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)');
 const lead=db.prepare('INSERT INTO leads VALUES(?,?,?,?)');const kinetic=db.prepare('INSERT INTO kinetic_addresses VALUES(?,?,?)');
 db.transaction(()=>{for(let i=0;i<500000;i++){const tenant=i%5===0?2:1;const recent=i%1000<10;const scanned=i%3===0?null:recent?(i%2?'2026-09-08T12:00:00.500Z':'2026-09-08 12:00:00.500'):(i%2?'2026-01-01T00:00:00Z':'2026-01-01 00:00:00');const lit=i%1000===1?'2026-09-08 12:00:00.500':i%20===1?'2026-01-01T00:00:00Z':null;target.run(i,tenant,'Synthetic '+i,'Fixture','NC','27000','fixture',scanned,lit,'x'.repeat(200));}for(let i=0;i<10000;i++){lead.run(i,i%5===0?2:1,i%10===1?'fresh_fiber_confirmed':'other',i%2?'2026-09-08T12:00:01Z':'2026-01-01 00:00:00');kinetic.run(i,i%5===0?2:1,i%10===1?1:0);}})();
 const params={tenantId:1,since:'2026-09-08T12:00:00.500Z'};
 const read=()=>({counts:db.prepare(dailySql).get(params),timing:timing(()=>db.prepare(dailySql).get(params)),plan:explain(db,dailySql,[params])});
 const originals=db.prepare('SELECT id,last_scanned_at,first_seen_fiber_at FROM scan_targets WHERE tenant_id=1 LIMIT 500').all();
 const update=db.prepare('UPDATE scan_targets SET last_scanned_at=?,first_seen_fiber_at=? WHERE id=?');
 const mutate=db.transaction(()=>{for(const row of originals)update.run('2026-09-08T13:00:00.000Z',row.id%20===1?'2026-09-08T13:00:00.000Z':row.first_seen_fiber_at,row.id);});
 const restore=db.transaction(()=>{for(const row of originals)update.run(row.last_scanned_at,row.first_seen_fiber_at,row.id);});
 const writes=()=>{const xs=[];for(let i=0;i<8;i++){const t=performance.now();mutate();const ms=performance.now()-t;restore();if(i)xs.push(ms);}return {rows:500,medianMs:rounded(median(xs)),minMs:rounded(Math.min(...xs)),maxMs:rounded(Math.max(...xs)),operation:'500 result timestamp updates, some newly-lit updates, one transaction; restore outside timer'};};
 db.exec('ANALYZE');db.pragma('wal_checkpoint(TRUNCATE)');
 const baseline=read(),writesBefore=writes(),indexes=[];
 for(const sql of dailyIndexes)indexes.push(indexCost(db,f.path,sql));
 const indexedStaleStats=read();db.exec('ANALYZE');const indexed=read(),writesAfter=writes();
 if(JSON.stringify(baseline.counts)!==JSON.stringify(indexed.counts))throw new Error('Daily count mismatch');
 result.daily={baseline,indexedStaleStats,indexed,writesBefore,writesAfter,indexes,equivalentCounts:true};
 console.log(JSON.stringify({scenario:'daily-counts',before:baseline.timing.medianMs,after:indexed.timing.medianMs}));
}finally{f.close();}
writeFileSync(join(dir,'results.json'),JSON.stringify(result,null,2)+'\n');
const lines=['Synthetic reliability benchmark',`Generated: ${result.generatedAt}`,`Node ${result.runtime.node}; SQLite ${result.runtime.sqlite}; ${result.runtime.cpu}`,result.method.caveat,'','Recovery: 500k targets, 50k runs; 7 warm samples; milliseconds.'];
for(const row of result.recovery){const idx=row.index.after.find(i=>i.name==='idx_srt_pending_due_run');lines.push(`${row.scenario}: stranded baseline ${row.baseline.stranded.medianMs}; covering OR ${row.covering.stranded.medianMs}; covering due ranges ${row.rangesAnalyzed.stranded.medianMs}; count ${row.baseline.count.medianMs} -> ${row.rangesAnalyzed.count.medianMs}; due rows ${row.baseline.dueCount}; equivalent first1000 full rows ${row.equivalentFullRows}`,`  Index build ${row.index.buildMs}ms; ${idx.pages} pages / ${idx.bytes} bytes; WAL growth ${row.index.walBytes} bytes`,`  Batch500 claim ${row.writesBefore.claim.medianMs} -> ${row.writesAfter.claim.medianMs}ms; insert ${row.writesBefore.insert.medianMs} -> ${row.writesAfter.insert.medianMs}ms`);}
lines.push('',`Daily normalized one-statement counts: ${result.daily.baseline.timing.medianMs} -> ${result.daily.indexed.timing.medianMs}ms; same counts ${JSON.stringify(result.daily.indexed.counts)}`,`Batch500 timestamp updates ${result.daily.writesBefore.medianMs} -> ${result.daily.writesAfter.medianMs}ms`);
for(let i=0;i<result.daily.indexes.length;i++){const c=result.daily.indexes[i],name=i===0?'idx_scan_targets_tenant_checked_jd':'idx_scan_targets_tenant_lit_jd',idx=c.after.find(x=>x.name===name);lines.push(`${name}: build ${c.buildMs}ms; ${idx.pages} pages / ${idx.bytes} bytes; WAL growth ${c.walBytes} bytes`);}
lines.push('','Exact SQL, EXPLAIN plans before/after ANALYZE, all page counts, and min/median/max are in results.json.','Pending-source fixtures preserve existing status and textual due-time rules. Daily before/after compares the same normalized SQL, isolating index benefit from the timestamp correctness fix.','Write measurements include added index maintenance and WAL writes with synchronous NORMAL; they do not include production contention, checkpoints or network.');
writeFileSync(join(dir,'report.txt'),lines.join('\n')+'\n');
console.log('Saved results.json and report.txt in '+dir);
