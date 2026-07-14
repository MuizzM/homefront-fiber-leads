export type FreshConfirmationStatus = "confirmed" | "provisional" | "rejected" | "regressed";

export interface IndependentAvailabilityEvidence {
  source: string;
  observedAt: string;
  availability: "available" | "unavailable" | "unknown";
  technology?: string | null;
}

export interface FreshFiberConfirmationInput {
  transitionFresh: boolean;
  currentFiberAvailable: boolean | null;
  customerSegment: "new_opportunity" | "existing_customer" | "unknown";
  firstDetectedAt: string | null;
  evidence: IndependentAvailabilityEvidence[];
  nowMs?: number;
}

export interface FreshFiberConfirmationDecision {
  status: FreshConfirmationStatus;
  confirmed: boolean;
  reasons: string[];
  sources: string[];
  confirmedAt: string | null;
}

const DAY_MS = 86_400_000;

// SQLite datetime('now') is UTC but omits both `T` and `Z`. Date.parse treats
// that shape as local time on some runtimes, which can falsely turn current
// evidence into a future timestamp. Normalize timezone-less SQL timestamps.
function timestampMs(value: string): number {
  const text = String(value ?? "").trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  return Date.parse(normalized);
}

export function isExplicitFiberTechnology(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  return /\bfiber\b|\bfttp\b|\bftth\b|fiber to the (premises|home)/.test(normalized);
}

export function qualifyingIndependentEvidence(
  evidence: IndependentAvailabilityEvidence[],
  firstDetectedAt: string,
  nowMs = Date.now(),
): IndependentAvailabilityEvidence[] {
  const detectedMs = timestampMs(firstDetectedAt);
  if (!Number.isFinite(detectedMs)) return [];
  const earliest = detectedMs - 7 * DAY_MS;
  const latest = Math.min(detectedMs + 31 * DAY_MS, nowMs + 5 * 60_000);
  return evidence.filter((row) => {
    const observedMs = timestampMs(row.observedAt);
    return row.availability === "available" && isExplicitFiberTechnology(row.technology) &&
      Number.isFinite(observedMs) && observedMs >= earliest && observedMs <= latest;
  });
}

/** Pure confirmation gate. A provider flip is analyst-visible immediately, but
 * only a current no-account opportunity with recent independent address-level
 * fiber evidence is confirmed and eligible for projection to the rep map. */
export function decideFreshFiberConfirmation(input: FreshFiberConfirmationInput): FreshFiberConfirmationDecision {
  if (!input.transitionFresh || !input.firstDetectedAt) {
    return { status: "rejected", confirmed: false, reasons: ["No proven unavailable-to-fiber transition."], sources: ["kinetic"], confirmedAt: null };
  }
  if (input.currentFiberAvailable === false) {
    return { status: "regressed", confirmed: false, reasons: ["Fiber is no longer serviceable at the latest conclusive check."], sources: ["kinetic"], confirmedAt: null };
  }
  if (input.currentFiberAvailable !== true) {
    return { status: "provisional", confirmed: false, reasons: ["The latest fiber state is inconclusive."], sources: ["kinetic"], confirmedAt: null };
  }
  if (input.customerSegment !== "new_opportunity") {
    return {
      status: "rejected", confirmed: false,
      reasons: [input.customerSegment === "existing_customer" ? "Provider indicates an existing service account." : "No decisive no-existing-service signal."],
      sources: ["kinetic"], confirmedAt: null,
    };
  }
  const qualifying = qualifyingIndependentEvidence(input.evidence, input.firstDetectedAt, input.nowMs);
  if (!qualifying.length) {
    return {
      status: "provisional", confirmed: false,
      reasons: ["Primary-source flip is awaiting recent independent address-level fiber evidence."],
      sources: ["kinetic"], confirmedAt: null,
    };
  }
  const sources = ["kinetic", ...new Set(qualifying.map((row) => row.source))];
  const confirmedAtMs = Math.max(...qualifying.map((row) => timestampMs(row.observedAt)));
  return {
    status: "confirmed", confirmed: true,
    reasons: ["Unavailable-to-fiber transition and no-account signal confirmed by independent fiber evidence."],
    sources, confirmedAt: new Date(confirmedAtMs).toISOString(),
  };
}
