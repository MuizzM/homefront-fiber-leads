import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { X, Loader2 } from "lucide-react";
import { useState } from "react";
import { formatCents, statementSummaryRows, type StatementDocument, type StatementLine } from "@shared/commissionStatement";

// ── Printable commission statement ────────────────────────────────────────────
// A paper-white, logo-bearing pay document. Every number on it comes from the
// SERVER's assembled statement document (GET /statements/:id/document) — the
// same document the downloadable PDF renders from — so the screen, the browser
// print, and the PDF can never show three different amounts. Nothing here
// derives money; it formats what the server computed.
//
// Rendered ink-on-white with EXPLICIT colors (never theme tokens) so it looks
// identical in the app's dark theme and on paper. Print CSS in index.css
// isolates `.stmt-paper` so only the statement lands on the page.

const INK = "#0F2A44";
const MUTED = "#5A6B76";
const FAINT = "#8A96A0";
const RULE = "#E3E8ED";
const RULE_SOFT = "#EEF1F4";

const STATUS_TEXT: Record<string, { label: string; note: string; color: string }> = {
  OPEN:      { label: "Projected",  note: "This week is still live - the amount can change until it's finalized.", color: "#B45309" },
  REVIEW:    { label: "In review",  note: "This statement is being reviewed and is not yet final.",                color: "#0369A1" },
  FINALIZED: { label: "Finalized",  note: "This statement is finalized and locked for payout.",                    color: "#155159" },
  PAID:      { label: "Paid",       note: "This statement has been paid.",                                          color: "#15803D" },
};

const shortDate = (iso: string, tz: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString(undefined, { timeZone: tz, month: "short", day: "numeric" })
    : " - ";
};

function Shell({ children, onClose, actions }: { children: React.ReactNode; onClose: () => void; actions?: React.ReactNode }) {
  return (
    <div className="stmt-overlay fixed inset-0 z-[200] overflow-y-auto bg-black/60 backdrop-blur-sm px-3 py-6 sm:py-10">
      <div className="stmt-toolbar no-print mx-auto mb-4 flex max-w-[760px] items-center justify-end gap-2">
        {actions}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close statement"
          className="inline-flex items-center justify-center h-10 w-10 rounded-lg bg-white/10 text-white active:scale-95 transition-transform"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
      {children}
    </div>
  );
}

function Paper({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="stmt-paper mx-auto w-full max-w-[760px] rounded-lg bg-white shadow-2xl"
      style={{ color: INK, fontFamily: "'Geist','Inter',system-ui,sans-serif" }}
    >
      <div className="p-8 sm:p-12">{children}</div>
    </div>
  );
}

export function CommissionStatement({ statementId, onClose }: { statementId: number; onClose: () => void }) {
  const [downloading, setDownloading] = useState(false);
  const { data: doc, isLoading, isError } = useQuery<StatementDocument>({
    queryKey: ["/api/commission/statements", statementId, "document"],
    queryFn: () => apiRequest("GET", `/api/commission/statements/${statementId}/document`).then(r => r.json()),
  });

  // The server renders the real PDF (identical layout, embedded logo). Fetch it
  // through apiRequest so the session cookie and error handling match every
  // other call, then hand the blob to the browser.
  const downloadPdf = async () => {
    setDownloading(true);
    try {
      const res = await apiRequest("GET", `/api/commission/statements/${statementId}/statement.pdf`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `commission-statement-${statementId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  if (isLoading || isError || !doc) {
    return (
      <Shell onClose={onClose}>
        <Paper>
          {isLoading
            ? <div className="flex items-center gap-2 py-10 text-[13px]" style={{ color: MUTED }}>
                <Loader2 className="w-4 h-4 animate-spin" /> Loading your statement…
              </div>
            : <div className="py-10 text-[13px]" style={{ color: MUTED }} data-testid="statement-error">
                Couldn't load this statement. Close and try again - your pay data is safe.
              </div>}
        </Paper>
      </Shell>
    );
  }

  const st = STATUS_TEXT[doc.statement.status] ?? STATUS_TEXT.OPEN;
  const tz = doc.period.timezone || "America/New_York";
  const issued = new Date(doc.statement.issuedAtIso).toLocaleDateString(undefined, { timeZone: tz, year: "numeric", month: "long", day: "numeric" });
  const counted = doc.lines.filter(l => l.counted);
  const uncounted = doc.lines.filter(l => !l.counted);

  const money = (c: number) => formatCents(c);

  const row = (l: StatementLine) => (
    <tr key={l.saleId} style={{ borderBottom: `1px solid ${RULE_SOFT}` }}>
      <td className="py-2 whitespace-nowrap" style={{ color: MUTED }}>{shortDate(l.countedAtIso, tz)}</td>
      <td className="py-2" style={{ color: l.counted ? INK : MUTED }}>
        {l.address}
        {l.city ? <span style={{ color: FAINT }}>, {l.city}</span> : null}
        {!l.counted && <span className="ml-2 text-[10.5px] uppercase tracking-wide" style={{ color: FAINT }}>{l.status}</span>}
      </td>
      {doc.showHouseColumn && (
        <td className="py-2 text-right tabular-nums" style={{ color: l.counted ? INK : FAINT }}>
          {l.counted && l.houseAmountCents != null ? money(l.houseAmountCents) : " - "}
        </td>
      )}
      <td className="py-2 text-right tabular-nums" style={{ color: l.counted ? INK : FAINT }}>
        {l.counted ? money(l.repCommissionCents) : " - "}
      </td>
    </tr>
  );

  // Built from the SHARED row list (shared/commissionStatement.statementSummaryRows)
  // so the screen and the downloadable PDF always show the same money planes.
  const summaryRows = statementSummaryRows(doc).map(r => ({
    k: r.label,
    // The holdback is the one row rendered with a true minus sign rather than a
    // hyphen, so it reads as a deduction on screen.
    v: r.amountCents < 0 && r.negative ? `-${money(Math.abs(r.amountCents))}` : money(r.amountCents),
    strong: r.strong,
    negative: r.negative,
  }));

  const capPct = doc.payout.reserveCapCents && doc.payout.reserveCapCents > 0
    ? Math.max(0, Math.min(100, Math.round((doc.payout.reserveBalanceCents / doc.payout.reserveCapCents) * 100)))
    : null;

  return (
    <Shell
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            onClick={downloadPdf}
            disabled={downloading}
            data-testid="statement-download"
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-semibold shadow-sm active:scale-95 transition-transform disabled:opacity-60"
          >
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Download PDF
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            data-testid="statement-print"
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-white/10 text-white text-sm font-semibold active:scale-95 transition-transform"
          >
             Print
          </button>
        </>
      }
    >
      <Paper>
        {/* Header - logo + the tenant's own company name, never a hardcoded one */}
        <div className="flex items-start justify-between gap-6 pb-7" style={{ borderBottom: `1px solid ${RULE}` }}>
          <div className="flex items-start gap-4 min-w-0">
            {/* The tenant's own wordmark when it has one, else the bundled mark,
                else nothing — the same three-level fallback the PDF uses, so the
                screen and the download never show different branding. */}
            <img
              src={doc.company.logoDataUri || "/hfs-logo.png"} alt=""
              data-testid="statement-logo"
              style={{ height: 54, width: "auto", display: "block", flexShrink: 0 }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
            <div className="min-w-0">
              <div className="text-[20px] font-bold tracking-tight truncate" data-testid="statement-company">{doc.company.name}</div>
              <div className="text-[13px]" style={{ color: MUTED }}>Commission Statement</div>
              <div className="mt-3 space-y-0.5 text-[12.5px]" style={{ color: MUTED }}>
                <div><span className="inline-block w-[92px]" style={{ color: FAINT }}>Statement</span> #{doc.statement.id ?? " - "}</div>
                <div><span className="inline-block w-[92px]" style={{ color: FAINT }}>Pay period</span> {doc.period.label || " - "}</div>
                {/* A locked week carries its real issue date; an open one is a
                    preview of a number that still moves, and says so. */}
                <div>
                  <span className="inline-block w-[92px]" style={{ color: FAINT }}>{doc.isDraft ? "Generated" : "Issued"}</span> {issued}
                  {doc.isDraft && <span className="ml-2 text-[11px] uppercase tracking-wide" style={{ color: FAINT }}>preview</span>}
                </div>
              </div>
            </div>
          </div>
          <div className="text-right shrink-0">
            <span
              className="inline-block rounded-md px-2.5 py-1 text-[11px] font-semibold"
              style={{ color: st.color, background: st.color + "18" }}
            >
              {st.label}
            </span>
          </div>
        </div>

        {/* Paid to + net pay */}
        <div className="grid grid-cols-2 gap-6 py-7">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: FAINT }}>Paid to</div>
            <div className="mt-2 text-[15px] font-semibold" data-testid="statement-rep">{doc.rep.name}</div>
            <div className="text-[12.5px]" style={{ color: MUTED }}>Field sales representative</div>
            <div className="text-[12.5px]" style={{ color: MUTED }}>{doc.planLabel}</div>
          </div>
          <div className="text-right">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: FAINT }}>Net pay this period</div>
            <div className="mt-1 text-[30px] font-bold tabular-nums leading-none" data-testid="statement-net-pay">
              {money(doc.payout.netPayCents)}
            </div>
            <div className="mt-2 text-[12px]" style={{ color: MUTED }}>
              Earned {money(doc.totals.earnedCents)} · Holdback {money(doc.payout.reserveCents)}
            </div>
          </div>
        </div>

        {/* Line items — the doors behind the number */}
        <div className="mt-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: FAINT }}>
            Sales this period ({doc.totals.countedSaleCount})
          </div>
          {counted.length === 0 ? (
            <div className="mt-3 text-[12.5px]" style={{ color: MUTED }}>
              No qualified sales counted toward commission in this period.
            </div>
          ) : (
            <table className="mt-2 w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wide" style={{ borderBottom: `1px solid ${RULE}`, color: FAINT }}>
                  <th className="py-2 font-semibold">Date</th>
                  <th className="py-2 font-semibold">Address</th>
                  {doc.showHouseColumn && <th className="py-2 text-right font-semibold">House amount</th>}
                  <th className="py-2 text-right font-semibold">Commission</th>
                </tr>
              </thead>
              <tbody>{counted.map(row)}</tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="py-2" />
                  <td className="py-2">{doc.totals.countedSaleCount} sales</td>
                  {doc.showHouseColumn && (
                    <td className="py-2 text-right tabular-nums" data-testid="statement-house-total">
                      {doc.totals.houseAmountCents == null ? " - " : money(doc.totals.houseAmountCents)}
                    </td>
                  )}
                  <td className="py-2 text-right tabular-nums">{money(doc.totals.grossCommissionCents)}</td>
                </tr>
              </tfoot>
            </table>
          )}
          {doc.showHouseColumn && counted.length > 0 && !doc.totals.houseAmountComplete && (
            <div className="mt-2 text-[11px]" style={{ color: FAINT }}>
              Some doors have no house amount recorded, so the house total covers only the priced sales.
            </div>
          )}
        </div>

        {/* Doors that didn't pay — listed, never silently dropped */}
        {uncounted.length > 0 && (
          <div className="mt-6">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: FAINT }}>
              Not counted toward this period ({uncounted.length})
            </div>
            <table className="mt-2 w-full border-collapse text-[12.5px]">
              <tbody>{uncounted.map(row)}</tbody>
            </table>
          </div>
        )}

        {/* Holdback balance + money summary */}
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg p-5" style={{ background: "#F5F8FA", border: `1px solid ${RULE}` }}>
            <div className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: FAINT }}>Current holdback balance</div>
            <div className="mt-1 text-[24px] font-bold tabular-nums" data-testid="statement-holdback-balance">
              {money(doc.payout.reserveBalanceCents)}
            </div>
            <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: MUTED }}>
              {doc.payout.reserveCapCents == null
                ? "Held to cover chargebacks on cancelled sales."
                : doc.payout.reserveAtCap
                  ? `Cap of ${money(doc.payout.reserveCapCents)} reached - nothing further is withheld.`
                  : `Builds to a cap of ${money(doc.payout.reserveCapCents)}.`}
            </div>
            {capPct != null && (
              <div className="mt-3">
                <div className="h-1.5 w-full rounded-full" style={{ background: "#E3EBF0" }}>
                  <div className="h-1.5 rounded-full" style={{ width: `${capPct}%`, background: "#3EA394" }} />
                </div>
                <div className="mt-1 text-[10.5px] tabular-nums" style={{ color: FAINT }}>{capPct}% of cap</div>
              </div>
            )}
          </div>

          <div className="rounded-lg p-5 text-[13px]" style={{ border: `1px solid ${RULE}` }}>
            {summaryRows.map(r => (
              <div key={r.k} className="flex justify-between py-1.5">
                <span style={{ color: r.strong ? INK : MUTED, fontWeight: r.strong ? 600 : 400 }}>{r.k}</span>
                <span
                  className="tabular-nums"
                  style={{ color: r.negative ? "#B91C1C" : INK, fontWeight: r.strong ? 600 : 400 }}
                >{r.v}</span>
              </div>
            ))}
            <div className="mt-2 flex items-center justify-between rounded-lg px-4 py-3" style={{ background: "#F0F6F5" }}>
              <span className="text-[12.5px] font-semibold uppercase tracking-wide" style={{ color: "#155159" }}>Net pay</span>
              <span className="text-[20px] font-bold tabular-nums" style={{ color: "#155159" }}>{money(doc.payout.netPayCents)}</span>
            </div>
          </div>
        </div>

        {/* Adjustment detail — a deduction is never an unexplained number */}
        {doc.adjustments.length > 0 && (
          <div className="mt-6">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: FAINT }}>Adjustments applied</div>
            <table className="mt-2 w-full border-collapse text-[12.5px]">
              <tbody>
                {doc.adjustments.map(a => (
                  <tr key={a.id} style={{ borderBottom: `1px solid ${RULE_SOFT}` }}>
                    <td className="py-2">{a.reason || "Adjustment"}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: a.amountCents < 0 ? "#B91C1C" : "#15803D" }}>
                      {money(a.amountCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-8 pt-4 text-[11.5px] leading-relaxed" style={{ borderTop: `1px solid ${RULE}`, color: FAINT }}>
          {st.note} Generated {issued} · {doc.company.name} · calculation v{doc.statement.calculationVersion}.
          {doc.company.supportEmail ? ` Questions? ${doc.company.supportEmail}` : " Questions? Contact your manager."}
        </div>
      </Paper>
    </Shell>
  );
}
