import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Bump this (e.g. the current route) to auto-reset the boundary on navigation. */
  resetKey?: string;
}
interface State {
  error: Error | null;
}

// Catches render/effect errors from any page so a single broken screen shows a
// recovery card instead of white-screening the entire app.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Clear the error when the route changes so navigating away recovers.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[ErrorBoundary] caught:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex-1 flex items-center justify-center p-6" style={{ minHeight: 0 }}>
          <div className="max-w-md w-full rounded-xl border border-border bg-card p-6 text-center">
            <div className="text-base font-semibold text-foreground mb-1">This page hit an error</div>
            <p className="text-sm text-muted-foreground mb-4">
              The rest of the app is still working — try again or head back to the dashboard.
            </p>
            <pre className="text-left text-xs text-destructive-foreground/80 bg-background rounded-md p-3 mb-4 overflow-auto max-h-40 whitespace-pre-wrap">
              {this.state.error.message}
            </pre>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => this.setState({ error: null })}
                className="px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition"
              >
                Try again
              </button>
              <a
                href="#/"
                onClick={() => this.setState({ error: null })}
                className="px-4 py-2 rounded-md text-sm font-medium bg-secondary text-secondary-foreground hover:opacity-90 transition"
              >
                Go to dashboard
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
