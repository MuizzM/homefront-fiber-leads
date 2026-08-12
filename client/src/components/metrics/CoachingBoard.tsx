// ── Coaching Insights — the supervisor's board ───────────────────────────────
//
// Grouped by severity, not by rep. Grouping by rep produces a ranked list of
// people, which is a league table however it is labelled; grouping by what
// needs doing produces a work queue. The brief is explicit that this feature
// must not become a punishment tool, and this is the layout decision that
// decides it.
//
// Positive insights are shown by default and are not collapsible. A board that
// only surfaces problems trains managers to read it as a complaint feed, and
// then the real findings go unread with the rest.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { useToast } from "@/hooks/use-toast";
import type { InsightSeverity } from "@shared/coachingInsights";

interface BoardInsight {
  id: number;
  repId: number;
  repName: string | null;
  severity: InsightSeverity;
  title: string;
  explanation: string;
  suggestedAction: string;
  supportingMetrics: { key: string; label: string; value: string; baseline?: string }[] | null;
  dataLink: string | null;
  periodStart: string;
  periodEnd: string;
  dismissedAt: string | null;
}

const GROUPS: { severity: InsightSeverity; label: string; hint: string; rail: string }[] = [
  { severity: "urgent", label: "Act today", hint: "Time-limited work that will be harder tomorrow.", rail: "bg-destructive" },
  { severity: "coaching_needed", label: "Worth a conversation", hint: "Each one names the coaching, not the person.", rail: "bg-warning" },
  { severity: "neutral", label: "Context", hint: "Worth knowing. Not a finding about anyone.", rail: "bg-info" },
  { severity: "positive", label: "Going well", hint: "Worth saying out loud on the next team call.", rail: "bg-success" },
];

export function CoachingBoard() {
  const { toast } = useToast();
  const [showDismissed, setShowDismissed] = useState(false);

  const { data, isLoading } = useQuery<{ insights: BoardInsight[] }>({
    queryKey: [`/api/metrics/insights${showDismissed ? "?includeDismissed=1" : ""}`],
  });

  const dismiss = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/metrics/insights/${id}/dismiss`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/metrics/insights"] });
      toast({ title: "Insight dismissed", description: "It will not come back for this period." });
    },
    onError: (e: any) => toast({
      title: "Could not dismiss",
      description: String(e?.message ?? "Try again."),
      variant: "destructive",
    }),
  });

  const grouped = useMemo(() => {
    const map = new Map<InsightSeverity, BoardInsight[]>();
    for (const i of data?.insights ?? []) {
      const list = map.get(i.severity);
      if (list) list.push(i); else map.set(i.severity, [i]);
    }
    return map;
  }, [data?.insights]);

  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;

  const total = data?.insights.length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {total === 0
            ? "No insights in the current window."
            : `${total} insight${total === 1 ? "" : "s"} across your team, from the last 7 days of activity.`}
        </p>
        <Button variant="ghost" size="sm" onClick={() => setShowDismissed((v) => !v)}>
          {showDismissed ? "Hide dismissed" : "Show dismissed"}
        </Button>
      </div>

      <p className="rounded-xl border border-border bg-secondary/50 p-3 text-[11px] leading-relaxed text-muted-foreground">
        Every insight below is a rule over numbers the rep can also see, with the arithmetic attached.
        None of them is a score, and none is generated from location alone. Use them to start a
        conversation, not to close one.
      </p>

      {GROUPS.map((g) => {
        const items = grouped.get(g.severity) ?? [];
        if (items.length === 0) return null;
        return (
          <section key={g.severity}>
            <SectionLabel className="mb-1 px-1">{g.label}</SectionLabel>
            <p className="mb-2 px-1 text-[11px] text-muted-foreground">{g.hint}</p>
            <div className="space-y-2">
              {items.map((i) => (
                <article key={i.id}
                         className={`relative overflow-hidden rounded-2xl border border-border bg-card p-4 ${i.dismissedAt ? "opacity-60" : ""}`}
                         data-testid={`board-insight-${i.id}`}>
                  <span className={`absolute inset-y-0 left-0 w-[3px] ${g.rail}`} aria-hidden="true" />
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-semibold text-foreground">{i.title}</h3>
                      {/* "Shown to" is doing real work. The insight body is
                          written in the second person because it is addressed to
                          the rep, and this board shows the supervisor the EXACT
                          words the rep reads - nothing is said about somebody
                          behind their back. Without this line, "you have 12
                          overdue callbacks" under a colleague's name reads as
                          though it were addressed to the manager. */}
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Shown to {i.repName ?? `rep ${i.repId}`} · {i.periodStart} to {i.periodEnd}
                      </p>
                    </div>
                    {!i.dismissedAt && (
                      <Button variant="ghost" size="sm" onClick={() => dismiss.mutate(i.id)}
                              data-testid={`dismiss-${i.id}`}>
                        Dismiss
                      </Button>
                    )}
                  </div>

                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{i.explanation}</p>
                  <p className="mt-2 rounded-lg bg-secondary px-2.5 py-2 text-xs font-medium leading-relaxed text-foreground">
                    {i.suggestedAction}
                  </p>

                  {i.supportingMetrics && i.supportingMetrics.length > 0 && (
                    <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
                      {i.supportingMetrics.map((m) => (
                        <div key={m.key} className="min-w-0">
                          <dt className="truncate text-2xs text-muted-foreground">{m.label}</dt>
                          <dd className="text-[12px] font-semibold tabular-nums text-foreground">
                            {m.value}
                            {m.baseline && <span className="ml-1 font-normal text-muted-foreground">vs {m.baseline}</span>}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {i.dataLink && (
                    <a href={`/#${i.dataLink}`}
                       className="mt-2.5 inline-block text-[11px] font-semibold text-primary underline underline-offset-2">
                      See the underlying data
                    </a>
                  )}
                </article>
              ))}
            </div>
          </section>
        );
      })}

      {total === 0 && (
        <div className="rounded-2xl border border-border bg-card p-6 text-center">
          <p className="text-sm font-semibold text-foreground">Nothing to flag</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Insights need enough activity in a week to compare fairly, so a quiet period produces none.
          </p>
        </div>
      )}
    </div>
  );
}
