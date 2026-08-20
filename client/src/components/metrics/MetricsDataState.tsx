import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export const METRICS_REFETCH_MS = 30_000;

export function MetricsErrorState({
  onRetry,
  retrying = false,
  title = "Couldn't load metrics",
  description = "These numbers are hidden because showing zeros would be misleading. Check your connection and try again.",
  testId = "metrics-error",
}: {
  onRetry: () => void;
  retrying?: boolean;
  title?: string;
  description?: string;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="rounded-2xl border border-destructive/25 bg-destructive/[0.06] p-5"
    >
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-muted-foreground">{description}</p>
      <Button
        type="button"
        variant="outline"
        className="mt-4 min-h-11"
        onClick={onRetry}
        disabled={retrying}
        data-testid={`${testId}-retry`}
      >
        {retrying ? "Trying again…" : "Try again"}
      </Button>
    </div>
  );
}

export function CommissionSourceNotice({
  manager = false,
}: {
  manager?: boolean;
}) {
  return (
    <aside className="rounded-2xl border border-border bg-card p-4" data-testid="commission-source-notice">
      <p className="text-sm font-semibold text-foreground">Commission has one source of truth</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Metrics tracks field activity, not pay. Authoritative weekly earnings, adjustments, reserves, and payout
        status live in My Commission{manager ? " for each representative" : ""}.
      </p>
      {!manager && (
        <Link
          href="/my-commission"
          className="mt-3 inline-flex min-h-11 items-center rounded-lg text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open My Commission
        </Link>
      )}
    </aside>
  );
}
