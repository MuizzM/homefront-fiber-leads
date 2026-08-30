import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Bump this (e.g. the current route) to auto-reset the boundary on navigation. */
  resetKey?: string;
}
interface State {
  error: Error | null;
  incidentId: string | null;
}

// Catches render/effect errors from any page so a single broken screen shows a
// recovery card instead of white-screening the entire app.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, incidentId: null };

  static getDerivedStateFromError(error: Error): State {
    const incidentId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8).toUpperCase()
      : Math.random().toString(36).slice(2, 10).toUpperCase();
    return { error, incidentId };
  }

  componentDidUpdate(prev: Props) {
    // Clear the error when the route changes so navigating away recovers.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, incidentId: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the customer-facing screen free of internals while leaving a
    // correlation code in captured browser logs for support diagnostics.
    console.error("[ui-error]", {
      incidentId: this.state.incidentId,
      name: error.name,
      message: error.message,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-1 items-center justify-center bg-background p-5" style={{ minHeight: 0 }}>
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center shadow-sm" role="alert">
            <div className="text-lg font-semibold text-balance text-foreground">This screen needs a refresh</div>
            <p className="mx-auto mt-2 max-w-xs text-pretty text-sm-minus leading-relaxed text-muted-foreground">
              Your saved field work is safe. Reload this screen, or return home and keep working.
            </p>
            {this.state.incidentId && <p className="mt-3 text-2xs font-medium text-muted-foreground">Support code {this.state.incidentId}</p>}
            {import.meta.env.DEV && (
              <details className="mt-4 rounded-xl bg-background p-3 text-left text-xs text-muted-foreground">
                <summary className="cursor-pointer font-medium">Developer details</summary>
                <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap">{this.state.error.message}</pre>
              </details>
            )}
            <div className="mt-5 grid gap-2">
              <button
                onClick={() => window.location.reload()}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                 Reload screen
              </button>
              <a
                // "#/" is the role-aware redirect: /today is gated on
                // field.app.use, so for calling and audit roles the old link
                // led from one dead end straight into an AccessDenied card.
                href="#/"
                onClick={() => this.setState({ error: null, incidentId: null })}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-secondary px-4 text-sm font-semibold text-secondary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                 Go to my home screen
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
