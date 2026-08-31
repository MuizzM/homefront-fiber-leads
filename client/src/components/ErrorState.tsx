import type { ReactNode } from "react";
import { FOCUS } from "@/lib/a11y";

/**
 * The one failure primitive for the app, and the twin of `EmptyState`.
 *
 * Twenty-nine pages hand-rolled this block. The markup drifted (rounded-xl vs
 * rounded-2xl, p-5 vs p-6, h-9 vs h-10 buttons), the copy drifted harder -
 * "Retry", "Try again" and "Refresh" all shipped for the identical action - and
 * the retry control landed under the 44px tap floor on several of them.
 *
 * The load-bearing difference from `EmptyState` is not the styling, it is the
 * ROLE. An empty state is `role="status"`: a calm, true report that there is
 * nothing here. A failed fetch is `role="alert"`: something is wrong and the
 * number you are looking at is unknown, not zero. Rendering an outage through
 * the empty branch is the defect `tests/rtl/ErrorStatesAreNotEmpties.test.tsx`
 * exists to catch, and it shipped four times. Using the wrong primitive here
 * re-introduces it, so the two are deliberately not interchangeable.
 *
 * No icon: decorative glyphs live only in the screen-switcher nav.
 */
export function ErrorState({
  title,
  description = "Check your connection and try again.",
  onRetry,
  retryLabel = "Retry",
  action,
  bordered = true,
  className = "",
  testId,
}: {
  /** What failed, in the user's words: "Couldn't load your follow-ups". */
  title: string;
  description?: ReactNode;
  /** Usually the query's `refetch`. Omit only when there is genuinely nothing to re-try. */
  onRetry?: () => void;
  retryLabel?: string;
  /** An escape hatch beside Retry (for example "Go back"), not a replacement for it. */
  action?: ReactNode;
  /** Wrap in a soft card, which is what an inline section failure wants. */
  bordered?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={`px-6 py-8 text-center ${bordered ? "rounded-2xl border border-border bg-card" : ""} ${className}`}
    >
      <div className="text-[15px] font-semibold text-foreground">{title}</div>
      {description && (
        <div className="mx-auto mt-1 max-w-xs text-sm-minus leading-relaxed text-muted-foreground">{description}</div>
      )}
      {(onRetry || action) && (
        <div className="mt-4 flex items-center justify-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className={`inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-secondary px-4 text-sm font-semibold text-foreground transition-transform hover:bg-secondary/70 active:scale-95 ${FOCUS}`}
            >
              {retryLabel}
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
