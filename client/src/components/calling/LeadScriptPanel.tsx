import { useQuery } from "@tanstack/react-query";
import { ChevronDown, MessageSquareText, ShieldAlert } from "lucide-react";
import { getLeadScript, type LeadScript } from "@/lib/callingApi";

/**
 * Per-lead speaking script panel (GET /api/v1/calling/leads/:leadId/script).
 *
 * Built for reading aloud on a phone at arm's length: the opener and
 * neighborhood hook are always expanded in large, high-contrast type; the
 * value proposition, objection handlers, and close collapse by default to
 * keep the call screen short. A disclosure box is pinned at the bottom in a
 * muted, ALWAYS visible, never-collapsible box — in every state: the
 * server's compliance footer when present, otherwise a clearly-labeled
 * static boilerplate reminder (including the error state).
 *
 * Honesty rule: if the endpoint fails, the panel says so and shows a minimal
 * built-in opener that is explicitly labeled "standard" — never fake
 * personalized content. Every section is read defensively (optional
 * chaining, legacy key alternates) so a partial or mixed-version payload
 * degrades section-by-section instead of crashing the call screen.
 */

// Minimal built-in fallback, explicitly labeled "standard" wherever shown.
// Mirrors the required opening disclosure elements: the rep's name, the
// company, that this is a sales call, and the purpose of the call.
export const STANDARD_OPENER =
  "Hi, my name is [your name], and I'm calling on behalf of Homefront Solutions, " +
  "an authorized seller of Kinetic Fiber internet from Windstream. " +
  "This is a sales call about fiber internet service at your address. " +
  "Did I catch you at an okay time for about one minute?";

/** Static boilerplate disclosure reminder — shown whenever the server's own
 *  compliance footer is unavailable (error state or partial payload). Always
 *  labeled as standard; never presented as the lead's personalized script. */
export const GENERIC_DISCLOSURE_REMINDER =
  "Required at the start of every call: state your name, the company you are calling on behalf of, " +
  "that this is a sales call, and that the purpose of the call is to offer Kinetic Fiber internet service.";

function valueBullets(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean).slice(0, 3);
  if (typeof value === "string") {
    const lines = value.split(/\n+/).map(line => line.replace(/^[\s\-•*\d.)]+/, "").trim()).filter(Boolean);
    return (lines.length > 1 ? lines : [value.trim()]).filter(Boolean).slice(0, 3);
  }
  return [];
}

/** Provenance comes from the server's `model` field ONLY: "llm" means the
 *  sections were personalized by the model; "rules" (or anything else, or
 *  absent) is the standard template. The real model name is never sent — the
 *  badge must not invent one. */
function provenanceLabel(script: LeadScript): string {
  return (script.model ?? "").trim().toLowerCase() === "llm" ? "Personalized script" : "Standard script";
}

/** Pinned, never-collapsible disclosure box. Rendered in EVERY state: the
 *  server's compliance footer when available, otherwise the static standard
 *  reminder (explicitly labeled as boilerplate). */
function DisclosureBox({ text, standard }: { text: string; standard?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-secondary/60 p-3" data-testid="script-disclosure" aria-label="Required disclosure">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {standard ? "Standard disclosure reminder" : "Compliance footer — follow on every call"}
      </div>
      <p className="mt-1.5 text-[13px] leading-[1.5] text-muted-foreground whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function SectionShell({ title, count, testId, children }: {
  title: string;
  count?: number;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <details data-testid={testId} className="group rounded-xl border border-border bg-background/50">
      <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-3 text-sm font-semibold text-foreground transition-colors hover:text-primary">
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{title}{typeof count === "number" ? ` (${count})` : ""}</span>
      </summary>
      <div className="border-t border-border px-3 py-3">{children}</div>
    </details>
  );
}

export function LeadScriptPanel({ leadId }: { leadId: number }) {
  const scriptQuery = useQuery({
    queryKey: ["/api/v1/calling/leads", leadId, "script"],
    queryFn: () => getLeadScript(leadId),
    enabled: Number.isSafeInteger(leadId) && leadId > 0,
    staleTime: 120_000,
    retry: 1,
  });

  return (
    <section className="rounded-2xl border border-border bg-card p-4" data-testid="lead-script-panel" aria-label="Call script">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MessageSquareText className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 className="text-base font-semibold">Call script</h2>
        </div>
        {scriptQuery.data && (
          <span
            data-testid="script-provenance"
            title={`Script version ${scriptQuery.data.version || "unknown"} · generated ${scriptQuery.data.generatedAt || "unknown"}`}
            className="inline-flex shrink-0 items-center rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-2xs font-medium text-muted-foreground"
          >
            {provenanceLabel(scriptQuery.data)}
          </span>
        )}
      </div>

      {scriptQuery.isLoading ? (
        <div role="status" aria-label="Loading call script" aria-busy="true" className="space-y-2.5">
          <div className="app-skeleton h-16 rounded-xl bg-muted" />
          <div className="app-skeleton h-12 rounded-xl bg-muted" />
          <div className="app-skeleton h-11 rounded-xl bg-muted" />
        </div>
      ) : scriptQuery.isError || !scriptQuery.data?.sections ? (
        <div className="space-y-3" data-testid="script-unavailable">
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] p-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-amber-600 dark:text-amber-400">Script unavailable</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">The personalized script could not be loaded. Use the standard opener below.</div>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-background/60 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Standard opener</div>
            <p className="mt-2 text-[15.5px] font-medium leading-[1.6] text-foreground">{STANDARD_OPENER}</p>
          </div>
          <DisclosureBox text={GENERIC_DISCLOSURE_REMINDER} standard />
        </div>
      ) : (
        <ScriptSections script={scriptQuery.data} />
      )}
    </section>
  );
}

function ScriptSections({ script }: { script: LeadScript }) {
  const sections = script.sections ?? {};
  const opener = (sections.opener ?? "").trim();
  const hook = (sections.neighborhoodHook ?? "").trim();
  const bullets = valueBullets(sections.valueProposition ?? sections.valueProp);
  // getLeadScript normalizes wire objects to an array; the Array.isArray
  // guard is belt-and-braces so an unnormalized payload can never throw
  // mid-call and take the whole call screen down to the error boundary.
  const objections = (Array.isArray(sections.objectionHandlers) ? sections.objectionHandlers : [])
    .map(item => ({ objection: (item?.objection ?? "").trim(), response: (item?.response ?? "").trim() }))
    .filter(item => item.objection || item.response);
  const close = (sections.close ?? "").trim();
  const footer = (sections.complianceFooter ?? sections.disclosure ?? "").trim();

  return (
    <div className="space-y-2.5">
      {opener && (
        <div className="rounded-xl border border-border bg-background/60 p-4" data-testid="script-opener">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Opener</div>
          <p className="mt-2 text-[15.5px] font-medium leading-[1.6] text-foreground whitespace-pre-wrap">{opener}</p>
        </div>
      )}

      {hook && (
        <div className="rounded-xl border border-primary/30 bg-primary/[0.07] p-4" data-testid="script-hook">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Neighborhood hook</div>
          <p className="mt-2 text-[15px] font-medium leading-[1.6] text-foreground whitespace-pre-wrap">{hook}</p>
        </div>
      )}

      {bullets.length > 0 && (
        <SectionShell title="Value prop" count={bullets.length} testId="script-value-prop">
          <ul className="space-y-2">
            {bullets.map((bullet, index) => (
              <li key={index} className="flex items-start gap-2 text-[15px] leading-[1.55] text-foreground">
                <span aria-hidden="true" className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span className="min-w-0">{bullet}</span>
              </li>
            ))}
          </ul>
        </SectionShell>
      )}

      {objections.length > 0 && (
        <SectionShell title="Objection handlers" count={objections.length} testId="script-objections">
          <div className="space-y-2">
            {objections.map((item, index) => (
              <details key={index} className="group/obj rounded-xl border border-border bg-card" data-testid={`script-objection-${index}`}>
                <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-3 text-sm font-semibold text-foreground">
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/obj:rotate-180" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{item.objection || "Objection"}</span>
                </summary>
                <p className="border-t border-border px-3 py-3 text-[15px] leading-[1.55] text-foreground whitespace-pre-wrap">{item.response}</p>
              </details>
            ))}
          </div>
        </SectionShell>
      )}

      {close && (
        <SectionShell title="Close" testId="script-close">
          <p className="text-[15px] leading-[1.55] text-foreground whitespace-pre-wrap">{close}</p>
        </SectionShell>
      )}

      {/* Pinned disclosure in every loaded state — server footer when the
          payload has one, standard boilerplate reminder when it doesn't. */}
      <DisclosureBox text={footer || GENERIC_DISCLOSURE_REMINDER} standard={!footer} />
    </div>
  );
}
