import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { can } from "@shared/capabilities";

/**
 * 404 — the only screen a lost user ever sees, so it gets the same treatment as
 * the rest of the app. It previously shipped as scaffold: hardcoded
 * gray-50/gray-900 (unreadable on the dark theme — the heading rendered nearly
 * invisible), developer copy ("Did you forget to add the page to the router?")
 * shown to customers, and no way back to the product.
 */
export default function NotFound() {
  const { user } = useAuth();
  // Same gate as the tab bar: a role the map 403s never gets pointed at it.
  const canUseMap = can(user?.role, "field.app.use");
  return (
    <div className="flex min-h-[70dvh] w-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-md text-center">
        

        <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Error 404
        </p>
        <h1 className="mt-1.5 text-[26px] font-bold leading-tight text-foreground">
          This page isn’t here
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          The link may be out of date, or the page may have moved. Your leads and
          territories are all still where you left them.
        </p>

        <div className="mt-7 flex flex-col gap-2.5 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-testid="notfound-dashboard"
          >
            
            Back to dashboard
          </Link>
          {canUseMap && <Link
            href="/map"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card px-5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-testid="notfound-map"
          >
            
            Open Field Map
          </Link>}
        </div>
      </div>
    </div>
  );
}
