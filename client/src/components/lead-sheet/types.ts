// ── Lead sheet shared types ──────────────────────────────────────────────────
// Query payload shapes shared by the LeadKnockSheet shell and the DetailsBody
// subcomponent. Server contracts — field names mirror the API responses.

import type { VStatus } from "@/components/verification";
import type { TracedPhone } from "@shared/tracerfy";

export interface HistoryRow {
  id: string;
  type: "status_change" | "assignment" | "note";
  actor: string | null;
  changedAt: string;
  status?: string;
  assignedTo?: string;
  assignedBy?: string;
  notePreview?: string;
  // Location verification (status_change rows only) — distance WHEN MARKED.
  verification?: VStatus;
  distanceM?: number | null;
  gpsAccuracyM?: number | null;
  reviewReason?: string | null;
}

export interface LeadDetail {
  id: number;
  notes?: string | null;
  updatedAt?: string | null;
  // Verified-premise facts (GET /api/leads/:id returns the full lead). All
  // optional — older records may lack them, and the sheet renders honest
  // fallbacks.
  city?: string | null; state?: string | null; zip?: string | null;
  fiberStatus?: string | null; householdSegmentType?: string | null;
  billingStatus?: string | null;
  competitorName?: string | null; competitorTech?: string | null;
  freshConfirmedAt?: string | null; leadTag?: string | null;
  leadStatus?: string | null;
  // Rep-captured contact identity (PATCH /api/leads/:id/contact). Distinct
  // from ownerName (trace/GIS): this is what the resident SAID, and the card's
  // "Ask for" line prefers it once present.
  contactName?: string | null;
  contactEmail?: string | null;
  // Skip-trace contacts. These arrive ONLY from GET /api/leads/:id — the map
  // pin feed carries no contact data by design (payload size, and it would
  // broadcast every household's numbers to every client). The server sends raw
  // flags plus scrubbedAtMs and NEVER a stored verdict, so the client derives
  // dialability per render and a scrub that has aged out re-blocks the number
  // from cache with nothing rewritten.
  ownerName?: string | null;
  phones?: TracedPhone[];
}

export interface TeamMember {
  id: number;
  name: string;
  active: boolean;
}
