// NO READ-THEN-WRITE TRANSACTION MAY RUN DEFERRED (2026-08-05).
//
// better-sqlite3's `db.transaction(fn)()` issues a plain BEGIN — DEFERRED. The
// transaction takes a READ snapshot at its first statement and only reaches for
// the write lock later. If any other connection commits in between, SQLite fails
// the write with SQLITE_BUSY_SNAPSHOT, and that error is thrown INSTANTLY:
// busy_timeout does not cover it, so nothing retries and the caller sees a hard
// error. On this box the scanners commit continuously, so "in between" is the
// normal case, not a rare race.
//
// That is exactly how sign-in broke: OtpRateBuckets.check() read the bucket row
// and wrote it back under a deferred BEGIN, and roughly one login in five died
// as "An internal error occurred" — 17 of 19 observed failures came back in
// under four seconds, far too fast to be the 15s busy_timeout everyone reaches
// for when SQLite is involved.
//
// `.immediate()` takes the write lock at BEGIN: busy_timeout applies again, and
// the read-modify-write is genuinely atomic. Three separate call sites in this
// codebase carried comments PROMISING that atomicity ("while BEGIN IMMEDIATE
// holds the write lock", "so two concurrent settles can never both see the same
// headroom") while running deferred, so this is not a bug anyone catches by
// reading carefully — hence a test.
//
// Deferred is FINE for a write-only transaction: with no read first, the opening
// write takes the lock directly and busy_timeout applies. This test only flags
// read-BEFORE-write.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const SERVER = path.join(REPO, "server");

const READ_METHODS = /^(get|all|iterate|pluck)$/;
const WRITE_METHODS = /^(run|insert|update|delete)$/;
const SQL_READ = /\bSELECT\b/i;
const SQL_WRITE = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i;

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : tsFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

/** Source position of the first read and the first write inside a callback. */
function firstReadAndWrite(node: ts.Node, sf: ts.SourceFile) {
  let read = -1;
  let write = -1;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const pos = n.getStart(sf);
      if (READ_METHODS.test(method) && read === -1) read = pos;
      if (WRITE_METHODS.test(method) && write === -1) write = pos;
    }
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      const text = n.getText(sf);
      const pos = n.getStart(sf);
      if (SQL_READ.test(text) && read === -1) read = pos;
      if (SQL_WRITE.test(text) && write === -1) write = pos;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { read, write };
}

/**
 * How the transaction function is invoked: chained (`.immediate()`), or through
 * the variable it was assigned to (`const tx = db.transaction(…); tx.immediate()`).
 */
function invocationMode(txNode: ts.CallExpression, sf: ts.SourceFile): string {
  const parent = txNode.parent;
  if (ts.isPropertyAccessExpression(parent) && ts.isCallExpression(parent.parent)) return parent.name.text;
  if (ts.isCallExpression(parent) && parent.expression === txNode) return "deferred";
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const name = parent.name.text;
    // Scope the search to the ENCLOSING FUNCTION, not the whole file: `const tx
    // = …` is the house style, so several functions in one file declare their
    // own `tx`, and a file-wide scan reads a sibling function's `tx()` as this
    // one's invocation. That mismatch is silent and reports the wrong verdict
    // in both directions.
    let scope: ts.Node = parent;
    while (scope.parent && !ts.isFunctionDeclaration(scope) && !ts.isFunctionExpression(scope)
           && !ts.isArrowFunction(scope) && !ts.isMethodDeclaration(scope)) scope = scope.parent;
    let mode: string | null = null;
    const scan = (n: ts.Node) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)
          && n.expression.text === name && ts.isCallExpression(n.parent)) mode ??= n.name.text;
      else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) mode ??= "deferred";
      ts.forEachChild(n, scan);
    };
    scan(scope);
    return mode ?? "uninvoked";
  }
  // Returned or stored for someone else to call — the caller picks the mode.
  return "indirect";
}

function auditFile(file: string) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const rel = path.relative(REPO, file);
  const risky: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === "transaction" && n.arguments.length) {
      const mode = invocationMode(n, sf);
      const { read, write } = firstReadAndWrite(n.arguments[0], sf);
      const readsBeforeWriting = read !== -1 && write !== -1 && read < write;
      const takesLockUpFront = mode === "immediate" || mode === "exclusive";
      if (readsBeforeWriting && !takesLockUpFront) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        risky.push(`${rel}:${line} (invoked ${mode})`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return risky;
}

describe("SQLite transactions", () => {
  it("never reads then writes under a deferred BEGIN", () => {
    const offenders = tsFiles(SERVER).flatMap(auditFile);
    expect(
      offenders,
      `These transactions read before they write but do not take the write lock up front, so a\n` +
      `commit by any other connection makes the write throw SQLITE_BUSY_SNAPSHOT instantly\n` +
      `(busy_timeout does NOT cover it). Invoke them with .immediate() instead:\n\n` +
      offenders.map((o) => `  ${o}`).join("\n") + "\n",
    ).toEqual([]);
  });

  it("still sees the transactions it is meant to be auditing", () => {
    // A parser change that silently matched nothing would make the test above
    // pass forever. Pin that it is actually looking at this codebase's ~100
    // transaction sites.
    const total = tsFiles(SERVER).reduce((n, file) => {
      const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      let count = 0;
      const visit = (x: ts.Node) => {
        if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)
            && x.expression.name.text === "transaction") count++;
        ts.forEachChild(x, visit);
      };
      visit(sf);
      return n + count;
    }, 0);
    expect(total).toBeGreaterThan(80);
  });
});
