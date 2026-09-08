// Disposable subprocess harness. No production imports, addresses or transports.
import Database from "better-sqlite3";
import { dirname } from "node:path";
import { continueAssignmentOperation } from "../../server/assignmentOperationStore";
import { drainOtpDeliveries } from "../../server/otpDeliveryWorker";
const [file, mode, id] = process.argv.slice(2);
if (!file.includes("hf-reliability-test-")) throw new Error("Synthetic database required");
const db = new Database(file);
const owner = { tenantId: 1, userId: 1 };
const authorize = () => ({ actorName: "Fixture manager", repName: "Fixture rep" });
if (mode === "assignment" || mode === "crash-assignment") {
  await continueAssignmentOperation(db, owner, id, authorize, () => {
    if (mode === "crash-assignment") process.kill(process.pid, "SIGKILL");
  });
} else if (mode === "crash-email-acceptance") {
  await drainOtpDeliveries(db, { now: () => Number(id), send: async (mail, key) => {
    db.prepare("INSERT OR IGNORE INTO fixture_provider(id,body) VALUES (?,?)").run(key, JSON.stringify(mail));
    process.kill(process.pid, "SIGKILL");
    return { id: key };
  } });
} else if (mode === "scanner-finalize") {
  process.env.DATA_DIR = dirname(file); process.env.NODE_ENV = "test";
  const store = await import("../../server/scanIntelStore");
  const targets = db.prepare("SELECT target_id FROM scan_run_targets WHERE run_id=?").all(id) as Array<{ target_id: number }>;
  for (const target of targets) {
    store.finalizeRunTarget(id, target.target_id, "verified", "fixture", { verified: 1 });
    await new Promise<void>(done => setImmediate(done));
  }
} else throw new Error("Unknown fixture mode");
db.close();
