// Recurring work must stop when its stage is hidden.
//
// KeepAliveStages keeps a visited route MOUNTED behind display:none, and wraps
// each stage in its own TabActivityProvider — so useTabActive() is STAGE-scoped,
// not browser-tab-scoped. Its header says the deal in as many words: "display:none
// stages still render on state changes; their PAGES opt out of recurring work
// via useTabActive()".
//
// Four incentive queries never took that deal. A rep opens /today (their home:
// "/" redirects there for role rep) and then works /map for the rest of the
// shift, and Today's hidden stage kept polling /api/me/milestones,
// /api/me/door-drops, /api/me/momentum and /api/me/campaigns at 60/60/30/60s
// — about five requests a minute, per rep, for a screen nobody is looking at.
//
// MEASURED in the running app, before and after:
//   Today visible : 4 incentive polls / 75s
//   Today hidden  : 0 polls / 87s, stage still mounted (display:none)
//   On return     : all four refetch immediately via the re-show revalidation,
//                   so pausing costs no freshness.
// That last line is the one that matters: the fix must not trade polling for
// stale data in front of the rep.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const POLLERS: Array<[string, string, string]> = [
  ["client/src/components/MilestoneCard.tsx", "useMyMilestones", "60_000"],
  ["client/src/components/DoorDropCard.tsx", "useMyDoorDrops", "60_000"],
  ["client/src/components/MomentumOffer.tsx", "useMomentum", "30_000"],
  ["client/src/components/CampaignBoard.tsx", "useMyCampaigns", "60_000"],
];

describe.each(POLLERS)("%s", (path, fn, interval) => {
  const src = read(path);
  const body = src.slice(src.indexOf(`export function ${fn}(`));
  const hook = body.slice(0, body.indexOf("\n}"));

  it(`${fn} reads stage visibility`, () => {
    expect(src).toContain('from "@/lib/tabActivity"');
    expect(hook).toContain("const tabActive = useTabActive();");
  });

  it(`${fn} pauses its ${interval} poll when the stage is hidden`, () => {
    expect(hook).toContain(`refetchInterval: tabActive ? ${interval} : false`);
    // The unconditional form is the defect; make sure it cannot come back.
    expect(hook).not.toMatch(new RegExp(`refetchInterval: ${interval},`));
  });

  it(`${fn} keeps its enabled flag independent of visibility`, () => {
    // Pausing the INTERVAL is the fix. Disabling the query outright would drop
    // the cached data and make the return a cold load with a skeleton.
    expect(hook).toContain("enabled,");
    expect(hook).not.toContain("enabled: tabActive");
  });
});

describe("EarningsToday remains the reference implementation", () => {
  it("still gates its interval the same way", () => {
    // This one already did it right; the four above now match it. If this ever
    // changes, the pattern the others copied has moved.
    const src = read("client/src/components/EarningsToday.tsx");
    expect(src).toContain("refetchInterval: tabActive ? 60_000 : false");
  });
});

describe("Team's roster is not rebuilt on every render", () => {
  const src = read("client/src/pages/Team.tsx");

  it("declares the section as a render function, not an inline component", () => {
    // Declared inside Team(), a component gets a NEW function identity every
    // render, and React reads a new identity as a different component TYPE:
    // the whole roster unmounts and remounts. Typing 12 characters into "Add
    // member" is 12 renders, so a 60-person org tore down and rebuilt roughly
    // 2,400 DOM nodes per keystroke behind the open dialog.
    expect(src).toContain("const renderRoleSection = ({");
    expect(src).not.toMatch(/const RoleSection = \(\{/);
  });

  it("calls it rather than rendering it as JSX", () => {
    expect(src).toContain('renderRoleSection({ title: "Managers"');
    expect(src).toContain('renderRoleSection({ title: "Team leads"');
    expect(src).toContain('renderRoleSection({ title: "Sales reps"');
    // <RoleSection/> would reintroduce the child instance, and with it the remount.
    expect(src).not.toMatch(/<RoleSection\b/);
  });

  it("stays hook-free, which is what makes the plain call equivalent", () => {
    // A hook inside a called function would belong to Team's hook order. If one
    // is ever needed, hoist to module scope with props instead of reverting.
    const start = src.indexOf("const renderRoleSection = ({");
    const body = src.slice(start, src.indexOf("\n  const ", start + 10));
    expect(body).not.toMatch(/\buse[A-Z][A-Za-z0-9_]*\s*\(/);
  });
});
