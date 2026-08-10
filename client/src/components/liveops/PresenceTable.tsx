import type { PresenceRow } from "@shared/liveOps";
import { ageLabel } from "./StatusPill";
import { Skeleton } from "@/components/ui/skeleton";
import { PRESENCE_OFFLINE_AFTER_MS } from "@shared/liveOps";

// ── Who is in the app right now ──────────────────────────────────────────────
//
// Everything here is answerable from a heartbeat, and nothing here identifies a
// device beyond its form factor. There is no session id column, no IP column
// and no user-agent column - not hidden, not truncated, not present. A coarse
// phone/tablet/desktop bucket tells a supervisor whether someone is out on the
// road; anything finer is a fingerprint nobody asked for.

const CONNECTION_TONE: Record<string, string> = {
  online: "text-success",
  degraded: "text-warning",
  offline: "text-muted-foreground",
};

const CONNECTION_MARK: Record<string, string> = {
  online: "●", degraded: "◐", offline: "○",
};

function connectionOf(row: PresenceRow, nowMs: number): string {
  if (!row.lastSeenAt) return "offline";
  const age = nowMs - Date.parse(row.lastSeenAt);
  if (!Number.isFinite(age)) return "offline";
  return age > PRESENCE_OFFLINE_AFTER_MS ? "offline" : row.connection;
}

export function PresenceTable({
  rows, loading, nowMs = Date.now(),
}: { rows: PresenceRow[]; loading?: boolean; nowMs?: number }) {
  if (loading) {
    return (
      <div className="space-y-2 p-4" data-testid="presence-loading">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-[13px] text-muted-foreground" data-testid="presence-empty">
        Nobody is signed in right now.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="presence-table">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-border text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-4 py-2.5">Name</th>
            <th scope="col" className="px-4 py-2.5">Role</th>
            <th scope="col" className="px-4 py-2.5">Shift</th>
            <th scope="col" className="px-4 py-2.5">Last seen</th>
            <th scope="col" className="px-4 py-2.5">In app</th>
            <th scope="col" className="px-4 py-2.5">Device</th>
            <th scope="col" className="px-4 py-2.5">Connection</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const conn = connectionOf(r, nowMs);
            return (
              <tr key={r.userId} className="border-b border-border last:border-b-0" data-testid={`presence-row-${r.userId}`}>
                <td className="px-4 py-2.5 font-medium text-foreground">{r.name}</td>
                <td className="px-4 py-2.5 capitalize text-muted-foreground">{r.role.replace(/_/g, " ")}</td>
                <td className="px-4 py-2.5">
                  {r.clockedIn
                    ? <span className="font-medium text-success">On shift</span>
                    : <span className="text-muted-foreground">Off shift</span>}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{ageLabel(r.lastSeenAt, nowMs)}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{r.appArea ?? "-"}</td>
                <td className="px-4 py-2.5 capitalize text-muted-foreground">{r.deviceKind}</td>
                <td className={`px-4 py-2.5 font-medium ${CONNECTION_TONE[conn] ?? "text-muted-foreground"}`}>
                  <span aria-hidden="true" className="mr-1.5 text-[9px]">{CONNECTION_MARK[conn] ?? "○"}</span>
                  <span className="capitalize">{conn}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
