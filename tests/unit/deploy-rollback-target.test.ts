// Choosing a rollback target.
//
// On 2026-07-28 a release failed its health check and the recovery rolled to
// THAT SAME SHA, then reported "CRITICAL: rollback also failed". Reinstalling
// the broken release is not a rollback: it cannot restore service, and the
// second error reads like an unrelated fault, burying the real one.
//
// These tests exercise the selection rule directly by running the shell
// function out of deploy.sh, so they check behaviour rather than asserting on
// source text.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const DEPLOY_SH = join(__dirname, "..", "..", "scripts", "deploy.sh");
let workdir: string;

/**
 * Run pick_rollback_target with a given running-image tag, target tag, and
 * .previous-tag file. Extracted from the real script so the test can never
 * drift from the code that ships.
 */
function pickTarget(opts: { prev: string; target: string; recorded?: string }): { ok: boolean; out: string } {
  workdir = mkdtempSync(join(tmpdir(), "hf-rollback-"));
  if (opts.recorded !== undefined) writeFileSync(join(workdir, ".previous-tag"), opts.recorded);

  const src = readFileSync(DEPLOY_SH, "utf8");
  const fn = src.slice(src.indexOf("pick_rollback_target() {"), src.indexOf("# Roll back to the last release"));
  if (!fn.includes("pick_rollback_target")) throw new Error("pick_rollback_target not found in deploy.sh");

  const script = `
set -uo pipefail
cd "${workdir}"
PREV_TAG="${opts.prev}"
NEW_TAG="${opts.target}"
${fn}
if out="$(pick_rollback_target)"; then echo "OK:$out"; else echo "REFUSED"; fi
`;
  try {
    const out = execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { ok: out.startsWith("OK:"), out: out.replace(/^OK:/, "") };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

const GOOD = "a".repeat(40);
const BAD = "b".repeat(40);
const OLDER = "c".repeat(40);

afterEach(() => { try { rmSync(workdir, { recursive: true, force: true }); } catch {} });

describe("pick_rollback_target", () => {
  it("uses the running image when it differs from the release being deployed", () => {
    // The ordinary case: production was on GOOD, BAD failed, roll back to GOOD.
    expect(pickTarget({ prev: GOOD, target: BAD })).toEqual({ ok: true, out: GOOD });
  });

  it("NEVER returns the SHA that just failed", () => {
    // The actual defect. A previous attempt had already swapped the container
    // onto BAD, so the "previous" image IS the broken one.
    const r = pickTarget({ prev: BAD, target: BAD, recorded: GOOD });
    expect(r.ok).toBe(true);
    expect(r.out).toBe(GOOD);
    expect(r.out).not.toBe(BAD);
  });

  it("falls back to the last release that actually passed health", () => {
    // .previous-tag is only written after a successful deploy, which is what
    // makes it trustworthy when the running image cannot be.
    expect(pickTarget({ prev: BAD, target: BAD, recorded: OLDER }).out).toBe(OLDER);
  });

  it("refuses rather than performing a recovery that cannot work", () => {
    // Nothing distinct to roll to: say so, don't reinstall the broken release
    // and then report a confusing second failure.
    expect(pickTarget({ prev: BAD, target: BAD }).ok).toBe(false);
  });

  it("refuses when the recorded tag is also the failing one", () => {
    expect(pickTarget({ prev: BAD, target: BAD, recorded: BAD }).ok).toBe(false);
  });

  it("ignores an empty .previous-tag", () => {
    expect(pickTarget({ prev: BAD, target: BAD, recorded: "" }).ok).toBe(false);
  });

  it("prefers the running image over the recorded tag when both are usable", () => {
    // The running image is the more recent truth; .previous-tag is the fallback.
    expect(pickTarget({ prev: GOOD, target: BAD, recorded: OLDER }).out).toBe(GOOD);
  });
});

describe("the recovery path is wired to the chooser", () => {
  it("neither failure path calls rollback.sh with a raw PREV_TAG any more", () => {
    const src = readFileSync(DEPLOY_SH, "utf8");
    // Both the cutover failure and the offline-window trap must go through
    // recover_to_previous; a direct call is how the bug got in.
    expect(src).not.toMatch(/scripts\/rollback\.sh\s+"\$PREV_TAG"/);
    expect(src).toMatch(/recover_to_previous/);
  });

  it("does not roll back a healthy app for an edge-policy probe failure", () => {
    const src = readFileSync(DEPLOY_SH, "utf8");
    const failure = src.slice(
      src.indexOf('if [ "$unsafe_method_gate_ok" != "1" ]'),
      src.indexOf('echo "[deploy] public unsafe-method gate OK'),
    );
    expect(failure).toContain("record_healthy_app_release");
    expect(failure).not.toContain("recover_to_previous");
  });

  it("gives rollback the same dockerd health grace as a deploy", () => {
    const rollback = readFileSync(join(__dirname, "..", "..", "scripts", "rollback.sh"), "utf8");
    expect(rollback).toContain("attempts_left=100");
    expect(rollback).toContain(".State.Health.Status");
    expect(rollback).not.toContain("exec -T app node -e");
  });
});
