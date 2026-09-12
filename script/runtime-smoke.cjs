// Run inside the production image with --network none. Only disposable local
// fixtures are used; importing the application would start unrelated workers.
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Worker } = require('node:worker_threads');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

async function main() {
  assert.equal(process.versions.node.split('.')[0], '24');
  const dir = mkdtempSync(join(tmpdir(), 'homefront-runtime-smoke-'));
  let db, contender, restored;
  try {
    const file = join(dir, 'source.db');
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE parents(id INTEGER PRIMARY KEY);
      CREATE TABLE items(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id), payload BLOB);
      INSERT INTO parents VALUES(1);`);
    const insert = db.prepare('INSERT INTO items VALUES(?, 1, ?)');
    const payload = Buffer.from([0, 127, 128, 255]);
    db.transaction(() => insert.run(1, payload)).immediate();
    assert.deepEqual(db.prepare('SELECT payload FROM items WHERE id=1').get().payload, payload);
    assert.deepEqual(db.prepare('SELECT id FROM items').raw().all(), [[1]]);
    assert.equal(db.prepare(`SELECT json_extract('{"ok":1}', '$.ok') AS ok`).get().ok, 1);
    db.exec('CREATE VIRTUAL TABLE bounds USING rtree(id,min_x,max_x,min_y,max_y); INSERT INTO bounds VALUES(1,0,1,0,1)');
    assert.equal(db.prepare('SELECT id FROM bounds WHERE min_x<=0.5 AND max_x>=0.5').get().id, 1);
    assert.throws(() => db.transaction(() => { insert.run(2, payload); throw new Error('rollback'); })(), /rollback/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
    assert.throws(() => db.prepare('INSERT INTO items VALUES(2, 999, ?)').run(payload), /FOREIGN KEY/);

    contender = new Database(file, { timeout: 0 });
    db.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => contender.prepare('INSERT INTO parents VALUES(2)').run(), { code: 'SQLITE_BUSY' });
      assert.equal(contender.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
    } finally { db.exec('ROLLBACK'); }

    const backup = join(dir, 'backup.db');
    await db.backup(backup);
    restored = new Database(backup, { readonly: true, fileMustExist: true });
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(restored.prepare('SELECT payload FROM items').get().payload, payload);
    assert.deepEqual(restored.pragma('foreign_key_check'), []);

    // The production backup script uses VACUUM INTO from a readonly connection.
    // Keep the source WAL open so this proves a coherent live snapshot.
    const snapshot = join(dir, 'snapshot.db');
    const snapshotReader = new Database(file, { readonly: true, fileMustExist: true });
    try { snapshotReader.prepare('VACUUM INTO ?').run(snapshot); }
    finally { snapshotReader.close(); }
    // Maintenance and cluster workers load the addon in fresh Node processes.
    execFileSync(process.execPath, ['-e', `const assert=require('node:assert/strict');
      const Database=require(process.argv[1]);
      const db=new Database(process.argv[2],{readonly:true,fileMustExist:true});
      assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
      assert.deepEqual(db.prepare('SELECT id FROM items').raw().all(),[[1]]);
      assert.deepEqual(db.prepare('SELECT payload FROM items').get().payload,Buffer.from([0,127,128,255]));
      assert.deepEqual(db.pragma('foreign_key_check'),[]);
      db.close();`, require.resolve('better-sqlite3'), snapshot], { timeout: 10_000, stdio: 'pipe' });

    // Also exercise addon isolation when loaded in a worker thread.
    await new Promise((resolve, reject) => {
      let received = false;
      const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(workerData.modulePath);
        const db = new Database(workerData.file, { readonly: true });
        parentPort.postMessage(db.prepare('SELECT COUNT(*) AS n FROM items').get().n);
        db.close();`, { eval: true, workerData: { modulePath: require.resolve('better-sqlite3'), file } });
      worker.once('message', value => { received = value === 1; });
      worker.once('error', reject);
      worker.once('exit', code => code === 0 && received ? resolve() : reject(new Error('Native worker smoke failed')));
    });
    console.log(JSON.stringify({ runtimeSmoke: 'passed', node: process.versions.node,
      driver: require('better-sqlite3/package.json').version,
      sqlite: db.prepare('SELECT sqlite_version() AS version').get().version }));
  } finally {
    restored?.close(); contender?.close(); db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
