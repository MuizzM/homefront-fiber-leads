import Database from "better-sqlite3";
import { interactiveTransaction } from "../../server/interactiveDb";
import { admitIdentityContinuation } from "../../server/identity/admission";
const [file, token, browser, when] = process.argv.slice(2);
const db = new Database(file);
db.pragma("foreign_keys=ON"); db.pragma("busy_timeout=0");
try {
  // The parent deliberately holds the writer until both processes observe it.
  try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); throw new Error("Expected parent writer lock"); }
  catch (error) {
    if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
    process.send?.({ state: "blocked" });
  }
  const result = await interactiveTransaction(db, () => admitIdentityContinuation(db, token, browser, Number(when)));
  process.send?.({ state: "result", result: result.state });
} catch (error) { process.send?.({ state: "error", error: error instanceof Error ? error.message : "unknown" }); process.exitCode = 1; }
finally { db.close(); process.disconnect?.(); }
