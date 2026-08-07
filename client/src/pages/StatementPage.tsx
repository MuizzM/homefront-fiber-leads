// ── A statement at its own address ──────────────────────────────────────────
//
// `CommissionStatement` already renders the whole document from the server's
// assembled statement (GET /statements/:id/document) — the same document the
// downloadable PDF renders from, so the screen, the browser print, and the PDF
// can never disagree. This page exists only to give that component a URL.
//
// WHY A ROUTE AND NOT JUST THE MODAL: a statement is the thing a worker is
// asked to produce — for a lender, an accountant, or a dispute. As a modal
// inside the console it could not be linked, bookmarked, or reopened, so "send
// me that statement" had no answer but "log in and click around".
//
// Authorization is deliberately NOT re-implemented here. The route gate is the
// weakest capability (`commission.read.self`) and the SERVER scopes every
// statement read to who may see that rep — a guessed id returns 404 exactly as
// it does for the modal. Gating the page harder would only hide a link the API
// would have refused anyway, while gating it here INSTEAD of the server would
// be a client-side permission check, which is not a permission check.

import { useLocation } from "wouter";
import { CommissionStatement } from "@/components/CommissionStatement";

export default function StatementPage({ statementId }: { statementId: number }) {
  const [, navigate] = useLocation();

  if (!Number.isInteger(statementId) || statementId <= 0) {
    return (
      <div className="mx-auto max-w-md p-8 text-center" data-testid="statement-page-invalid">
        <h1 className="text-lg font-semibold">That statement link isn't valid</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Check the link, or open the statement from your commission page.
        </p>
        <button
          className="mt-4 text-sm font-semibold text-primary underline underline-offset-4"
          onClick={() => navigate("/my-commission")}
        >
          Go to my commission
        </button>
      </div>
    );
  }

  return (
    <div data-testid="statement-page">
      <CommissionStatement
        statementId={statementId}
        // Closing a statement that was opened by URL has nowhere to "close" to,
        // so it navigates back to where statements are listed rather than
        // leaving the reader on a blank overlay.
        onClose={() => navigate("/my-commission")}
      />
    </div>
  );
}
