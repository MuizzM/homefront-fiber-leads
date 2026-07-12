import { usd, usdSigned } from "@/lib/money";
import { Printer, X } from "lucide-react";

// ── Printable commission statement ────────────────────────────────────────────
// A paper-white, logo-bearing statement modeled on a standard invoice (Wise
// anatomy: title + meta left, logo right, from/to, line items, emphasized totals).
// Rendered ink-on-white with EXPLICIT colors (never theme tokens) so it looks
// identical on screen and in the PDF regardless of the app's dark theme. The
// "Print / Save as PDF" button triggers the browser print dialog; print CSS in
// index.css isolates `.stmt-paper` so only the statement lands on the page.

export interface StatementModel {
  repName: string;
  weekLabel: string;
  status: string;                       // OPEN | REVIEW | FINALIZED | PAID
  qualifiedSaleCount: number;
  rateCents: number;
  grossCents: number;
  adjustmentCents: number;
  finalCents: number;
  tierLabel?: string | null;
  planName?: string | null;
  sales?: Array<{ date: string | null; address: string | null; city: string | null; status: string }>;
  adjustments?: Array<{ amount_cents: number; reason: string }>;
  statementNo: string;
}

const STATUS_TEXT: Record<string, { label: string; note: string; color: string }> = {
  OPEN:      { label: "Projected",  note: "This week is still live — the amount can change until it's finalized.", color: "#B45309" },
  REVIEW:    { label: "In review",  note: "This statement is being reviewed and is not yet final.",                color: "#0369A1" },
  FINALIZED: { label: "Finalized",  note: "This statement is finalized and locked for payout.",                    color: "#155159" },
  PAID:      { label: "Paid",       note: "This statement has been paid.",                                          color: "#15803D" },
};

export function CommissionStatement({ model, onClose }: { model: StatementModel; onClose: () => void }) {
  const st = STATUS_TEXT[model.status] ?? STATUS_TEXT.OPEN;
  const issued = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const sales = (model.sales ?? []).filter(s => s.status !== "REVERSED");

  return (
    <div className="stmt-overlay fixed inset-0 z-[200] overflow-y-auto bg-black/60 backdrop-blur-sm px-3 py-6 sm:py-10">
      {/* Toolbar — hidden when printing */}
      <div className="stmt-toolbar no-print mx-auto mb-4 flex max-w-[760px] items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => window.print()}
          data-testid="statement-print"
          className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-semibold shadow-sm active:scale-95 transition-transform"
        >
          <Printer className="w-4 h-4" /> Print / Save as PDF
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close statement"
          className="inline-flex items-center justify-center h-10 w-10 rounded-lg bg-white/10 text-white active:scale-95 transition-transform"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Paper */}
      <div
        className="stmt-paper mx-auto w-full max-w-[760px] rounded-lg bg-white text-[#0F2A44] shadow-2xl"
        style={{ fontFamily: "'Geist','Inter',system-ui,sans-serif" }}
      >
        <div className="p-8 sm:p-12">
          {/* Header */}
          <div className="flex items-start justify-between gap-6 border-b border-[#E3E8ED] pb-7">
            <div>
              <div className="text-[22px] font-bold tracking-tight">Commission Statement</div>
              <div className="mt-3 space-y-0.5 text-[12.5px] text-[#5A6B76]">
                <div><span className="inline-block w-[92px] text-[#8A96A0]">Statement</span> {model.statementNo}</div>
                <div><span className="inline-block w-[92px] text-[#8A96A0]">Pay period</span> {model.weekLabel}</div>
                <div><span className="inline-block w-[92px] text-[#8A96A0]">Issued</span> {issued}</div>
              </div>
            </div>
            <div className="text-right shrink-0">
              <img
                src="/hfs-logo-full.png" alt="Home Front Solutions" style={{ height: 68, width: "auto", marginLeft: "auto", display: "block" }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; const n = e.currentTarget.nextElementSibling as HTMLElement | null; if (n) n.style.display = "block"; }}
              />
              <div style={{ display: "none" }} className="text-[15px] font-bold text-[#0F2A44]">Home Front Solutions</div>
              <span
                className="mt-3 inline-block rounded-md px-2.5 py-1 text-[11px] font-semibold"
                style={{ color: st.color, background: st.color + "18" }}
              >
                {st.label}
              </span>
            </div>
          </div>

          {/* From / Paid to */}
          <div className="grid grid-cols-2 gap-6 py-7">
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[#8A96A0]">From</div>
              <div className="mt-2 text-[13.5px] font-semibold text-[#0F2A44]">Home Front Solutions, LLC</div>
              <div className="text-[12.5px] text-[#5A6B76]">Nationwide field sales</div>
              <div className="text-[12.5px] text-[#5A6B76]">homefrontsolutionsllc.com</div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[#8A96A0]">Paid to</div>
              <div className="mt-2 text-[13.5px] font-semibold text-[#0F2A44]">{model.repName}</div>
              <div className="text-[12.5px] text-[#5A6B76]">Field sales representative</div>
              {model.planName && <div className="text-[12.5px] text-[#5A6B76]">Plan: {model.planName}</div>}
            </div>
          </div>

          {/* Summary strip */}
          <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-[#E3E8ED]">
            {[
              { k: "Qualified sales", v: String(model.qualifiedSaleCount) },
              { k: "Rate per sale", v: usd(model.rateCents) },
              { k: "Tier", v: model.tierLabel || "Flat" },
            ].map((c, i) => (
              <div key={c.k} className={`px-4 py-3 ${i > 0 ? "border-l border-[#E3E8ED]" : ""}`}>
                <div className="text-[10.5px] uppercase tracking-wide text-[#8A96A0]">{c.k}</div>
                <div className="mt-1 text-[17px] font-bold tabular-nums text-[#0F2A44]">{c.v}</div>
              </div>
            ))}
          </div>

          {/* Line items — the qualifying doors */}
          {sales.length > 0 && (
            <div className="mt-7">
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[#8A96A0]">Qualifying sales</div>
              <table className="mt-2 w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="border-b border-[#E3E8ED] text-left text-[10.5px] uppercase tracking-wide text-[#8A96A0]">
                    <th className="py-2 font-semibold">Date</th>
                    <th className="py-2 font-semibold">Address</th>
                    <th className="py-2 font-semibold">City</th>
                    <th className="py-2 text-right font-semibold">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((s, i) => (
                    <tr key={i} className="border-b border-[#EEF1F4]">
                      <td className="py-2 text-[#5A6B76] whitespace-nowrap">{s.date ? new Date(s.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}</td>
                      <td className="py-2 text-[#0F2A44]">{s.address || "Sale"}</td>
                      <td className="py-2 text-[#5A6B76]">{s.city || "—"}</td>
                      <td className="py-2 text-right tabular-nums text-[#0F2A44]">{usd(model.rateCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Adjustments */}
          {(model.adjustments ?? []).length > 0 && (
            <div className="mt-6">
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[#8A96A0]">Adjustments</div>
              <table className="mt-2 w-full border-collapse text-[12.5px]">
                <tbody>
                  {model.adjustments!.map((a, i) => (
                    <tr key={i} className="border-b border-[#EEF1F4]">
                      <td className="py-2 text-[#0F2A44]">{a.reason}</td>
                      <td className="py-2 text-right tabular-nums" style={{ color: a.amount_cents < 0 ? "#B91C1C" : "#15803D" }}>{usdSigned(a.amount_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Totals */}
          <div className="mt-7 flex justify-end">
            <div className="w-full max-w-[300px] text-[13px]">
              <div className="flex justify-between py-1.5">
                <span className="text-[#5A6B76]">Gross commission</span>
                <span className="tabular-nums text-[#0F2A44]">{usd(model.grossCents)}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-[#E3E8ED]">
                <span className="text-[#5A6B76]">Adjustments</span>
                <span className="tabular-nums text-[#0F2A44]">{usdSigned(model.adjustmentCents)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between rounded-lg bg-[#F0F6F5] px-4 py-3">
                <span className="text-[12.5px] font-semibold uppercase tracking-wide text-[#155159]">Total payout</span>
                <span className="text-[22px] font-bold tabular-nums text-[#155159]">{usd(model.finalCents)}</span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-8 border-t border-[#E3E8ED] pt-4 text-[11.5px] leading-relaxed text-[#8A96A0]">
            {st.note} Generated {issued} · Home Front Solutions, LLC. Questions? Contact your manager.
          </div>
        </div>
      </div>
    </div>
  );
}
