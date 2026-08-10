import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RepPanel } from "@/components/liveops/RepPanel";
import { PresenceTable } from "@/components/liveops/PresenceTable";
import { StatusPill, FreshnessBadge, ageLabel } from "@/components/liveops/StatusPill";
import type { PresenceRow, RepLiveState } from "@shared/liveOps";

// Relative to the real clock, because RepPanel and FreshnessBadge render ages
// against Date.now() - the same clock they use in production. A pinned fake
// "now" here would only be testing the fixture.
const NOW = Date.now();
const minsAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();
/** A fixed instant, for the pure age formatter where the pair is the point. */
const FIXED = Date.parse("2026-08-10T18:00:00.000Z");
const fixedMinsAgo = (n: number) => new Date(FIXED - n * 60_000).toISOString();

function rep(over: Partial<RepLiveState> = {}): RepLiveState {
  return {
    repId: 7, repName: "Saad Qadir",
    teamLeadName: "Tal Lead", managerName: "Mona Manager",
    status: "knocking", statusSince: minsAgo(3),
    freshness: "live", lat: 35.5012, lng: -80.4133, accuracyM: 9,
    capturedAt: minsAgo(1), clockedInAt: minsAgo(120),
    territoryId: 3, territoryName: "Sardis Crossing", outsideTerritory: false,
    lastKnockAt: minsAgo(3),
    doorsToday: 42, interestedToday: 6, appointmentsToday: 2, salesToday: 1,
    ...over,
  };
}

describe("a stale position is never presented as a current one", () => {
  it("shows coordinates for a live fix", () => {
    render(<RepPanel rep={rep()} onClose={() => {}} />);
    expect(screen.getByText(/35\.50120/)).toBeInTheDocument();
    expect(screen.queryByTestId("rep-panel-no-position")).not.toBeInTheDocument();
  });

  it("shows NO position at all when the server withheld one", () => {
    // The server returns null coordinates once a fix goes stale, so there is
    // nothing to draw. The panel must say when we last heard instead of
    // implying the rep is still there.
    render(<RepPanel rep={rep({ freshness: "stale", lat: null, lng: null, capturedAt: minsAgo(25) })} onClose={() => {}} />);
    const note = screen.getByTestId("rep-panel-no-position");
    expect(note).toHaveTextContent(/No current position/i);
    expect(note).toHaveTextContent(/25 min ago/);
    expect(screen.queryByText(/35\.50/)).not.toBeInTheDocument();
  });

  it("says the device cannot locate, rather than showing an old pin", () => {
    render(<RepPanel rep={rep({ status: "location_unavailable", freshness: "none", lat: null, lng: null })} onClose={() => {}} />);
    expect(screen.getByTestId("rep-panel-no-position"))
      .toHaveTextContent(/cannot provide a location/i);
  });

  it("keeps status and freshness as two separate statements", () => {
    // A rep can genuinely be knocking while their last fix is old. Both facts
    // must survive; neither may overwrite the other.
    render(<RepPanel rep={rep({ status: "knocking", freshness: "stale", lat: null, lng: null, capturedAt: minsAgo(18) })} onClose={() => {}} />);
    expect(screen.getByTestId("status-knocking")).toBeInTheDocument();
    expect(screen.getByTestId("freshness-stale")).toBeInTheDocument();
  });

  it("flags a rep working outside their assigned area", () => {
    render(<RepPanel rep={rep({ outsideTerritory: true })} onClose={() => {}} />);
    expect(screen.getByText(/Outside assigned area/i)).toBeInTheDocument();
  });

  it("shows today's progress", () => {
    render(<RepPanel rep={rep()} onClose={() => {}} />);
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Doors")).toBeInTheDocument();
  });
});

describe("status and freshness badges", () => {
  it("carries a word, not only a colour", () => {
    render(<StatusPill status="traveling" />);
    expect(screen.getByTestId("status-traveling")).toHaveTextContent("Traveling");
  });

  it("always states the age alongside the tier", () => {
    render(<FreshnessBadge freshness="stale" capturedAt={minsAgo(14)} />);
    expect(screen.getByTestId("freshness-stale")).toHaveTextContent(/Last known/);
    expect(screen.getByTestId("freshness-stale")).toHaveTextContent(/14 min ago/);
  });

  it("does not invent an age when there is no fix", () => {
    render(<FreshnessBadge freshness="none" capturedAt={null} />);
    const badge = screen.getByTestId("freshness-none");
    expect(badge).toHaveTextContent("No fix");
    expect(badge).not.toHaveTextContent("ago");
  });

  it("describes ages in words a supervisor can act on", () => {
    expect(ageLabel(fixedMinsAgo(0), FIXED)).toBe("just now");
    expect(ageLabel(fixedMinsAgo(14), FIXED)).toBe("14 min ago");
    expect(ageLabel(fixedMinsAgo(150), FIXED)).toBe("3h ago");
    expect(ageLabel(null, FIXED)).toBe("never");
  });
});

describe("the presence table", () => {
  const row = (over: Partial<PresenceRow> = {}): PresenceRow => ({
    userId: 11, repId: 7, name: "Saad Qadir", role: "rep",
    lastSeenAt: minsAgo(1), sessionStartedAt: minsAgo(200),
    appArea: "Field Map", deviceKind: "phone", connection: "online",
    clockedIn: true, clockedInAt: minsAgo(120),
    ...over,
  });

  it("shows who is on shift and where they are in the app", () => {
    render(<PresenceTable rows={[row()]} nowMs={NOW} />);
    expect(screen.getByText("Saad Qadir")).toBeInTheDocument();
    expect(screen.getByText("On shift")).toBeInTheDocument();
    expect(screen.getByText("Field Map")).toBeInTheDocument();
  });

  it("has no column for a session token, IP or user agent", () => {
    const { container } = render(<PresenceTable rows={[row()]} nowMs={NOW} />);
    const headers = [...container.querySelectorAll("th")].map((h) => h.textContent?.toLowerCase() ?? "");
    for (const forbidden of ["session", "token", "ip", "address", "agent", "browser"]) {
      expect(headers.some((h) => h.includes(forbidden))).toBe(false);
    }
  });

  it("reports a rep as offline once their heartbeat lapses, whatever the row claims", () => {
    // A row that still says connection "online" but stopped reporting an hour
    // ago is not online; the age is the authority, not the stored label.
    render(<PresenceTable rows={[row({ lastSeenAt: minsAgo(60), connection: "online" })]} nowMs={NOW} />);
    expect(screen.getByTestId("presence-row-11")).toHaveTextContent(/offline/i);
  });

  it("shows a skeleton while loading and an empty state when nobody is on", () => {
    const { rerender } = render(<PresenceTable rows={[]} loading nowMs={NOW} />);
    expect(screen.getByTestId("presence-loading")).toBeInTheDocument();
    rerender(<PresenceTable rows={[]} nowMs={NOW} />);
    expect(screen.getByTestId("presence-empty")).toBeInTheDocument();
  });

  it("buckets the device rather than fingerprinting it", () => {
    render(<PresenceTable rows={[row({ deviceKind: "tablet" })]} nowMs={NOW} />);
    expect(screen.getByTestId("presence-row-11")).toHaveTextContent("tablet");
  });
});
