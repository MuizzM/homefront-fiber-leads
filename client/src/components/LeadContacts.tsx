// ── Who lives here, and which numbers you may actually dial ─────────────────
//
// The panel a knocker reads on the doorstep. Two jobs, in this order:
//
//   1. THE NAME. "Hi, is that Dana?" outperforms "Hi there" by a wide margin,
//      and it is the single highest-value thing a skip trace buys. So the name
//      is the biggest text here — bigger than the numbers, which the knocker
//      does not need while standing at the door.
//
//   2. THE NUMBERS, INCLUDING THE ONES THEY MUST NOT DIAL. A DNC number stays
//      on the card. It is context — it tells the rep this household has a
//      landline, that the owner is reachable, that the door is worth a second
//      pass. The rule is "don't dial", not "don't know".
//
// ── THE ONE THING THAT MUST NOT REGRESS ────────────────────────────────────
//
// A DNC number is NOT a tel: link. A callable number is.
//
// That is the whole safety property of this component. On a phone, a tel: link
// under a thumb is a dialled call — so rendering a DNC number as a link would
// turn "we display it for context" into "we made it one tap to violate the
// TCPA". The blocked rows are plain text with a badge, deliberately inert, and
// there is a test that fails if anyone turns them back into anchors.
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { verdictForPhone, dncExplanation, leadDisplayName, type TracedPhone } from "@shared/tracerfy";

export interface LeadContactsProps {
  /** Owner name from the trace, if one came back. */
  ownerName?: string | null;
  address: string;
  phones?: TracedPhone[];
  /** Now, injected so the DNC-staleness verdict is testable. */
  nowMs?: number;
  className?: string;
}

/** Pretty-print E.164 for reading aloud: +15551230001 → (555) 123-0001.
 *  A knocker reads this off a screen in sunlight; the grouped form scans in one
 *  glance where a 12-digit run does not. Anything non-US falls through as-is. */
function prettyPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164.trim());
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function LeadContacts({ ownerName, address, phones = [], nowMs, className }: LeadContactsProps) {
  const now = nowMs ?? Date.now();
  const name = leadDisplayName(ownerName, address);
  // Traced name vs. the "Resident at …" fallback. Only a real name is worth
  // presenting as a person — the fallback is just the address again, so it gets
  // quieter treatment rather than a fake identity.
  const named = Boolean((ownerName ?? "").trim().length >= 2 && /[a-z]/i.test(ownerName ?? ""));
  const verdicts = phones.map(p => verdictForPhone(p, now));

  if (!named && verdicts.length === 0) return null;

  return (
    <div className={cn("rounded-xl border border-border bg-card/60 p-3", className)} data-testid="lead-contacts">
      <div className="flex items-start gap-2.5">
        
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {named ? "Ask for" : "No name on file"}
          </div>
          <div
            className={cn("mt-0.5 truncate leading-tight",
              named ? "text-[19px] font-bold tracking-tight text-foreground" : "text-[15px] text-muted-foreground")}
            data-testid="lead-contact-name"
          >
            {name}
          </div>
        </div>
      </div>

      {verdicts.length > 0 && (
        <ul className="mt-2.5 flex flex-col gap-1.5" data-testid="lead-contact-phones">
          {verdicts.map(v => {
            const label = prettyPhone(v.number);
            const line = v.lineType !== "unknown" ? v.lineType : null;

            // ── The safety fork. Callable → tel: link. Blocked → inert text. ──
            if (v.dnc) {
              return (
                <li
                  key={v.number}
                  data-testid={`lead-phone-${v.number}`}
                  data-dnc="true"
                  className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-2"
                >
                  
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold tabular-nums text-muted-foreground line-through decoration-1">
                      {label}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {dncExplanation(v.reasons)}
                    </span>
                  </span>
                  <span
                    className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warning"
                    data-testid="lead-phone-badge"
                  >
                    Door only
                  </span>
                </li>
              );
            }

            return (
              <li key={v.number}>
                <a
                  href={`tel:${v.number}`}
                  data-testid={`lead-phone-${v.number}`}
                  data-dnc="false"
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border border-success/15 bg-success/[0.08] px-2.5 py-2 transition-transform active:scale-[.99] hover:border-success/45",
                    FOCUS,
                  )}
                >
                  
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold tabular-nums text-foreground">{label}</span>
                    {line && <span className="block truncate text-[11px] capitalize text-muted-foreground">{line}</span>}
                  </span>
                  <span
                    className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-success"
                    data-testid="lead-phone-badge"
                  >
                    OK to call
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
