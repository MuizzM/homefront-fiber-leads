// ── A11y quick wins — pinned so they cannot silently regress ────────────────
// The rep-facing surfaces audit (ui-polish-pass): icon-only buttons must carry
// accessible names, thumb-zone controls must meet the 44px one-handed hit-area
// floor (--tap-target-min / h-11), and async regions must announce themselves
// (role="status" + aria-busy). Exercises the three highest-traffic surfaces the
// pass touched: the knock sheet header and
// the My pay loading state.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeadKnockSheet } from "@/components/LeadKnockSheet";

beforeAll(() => {
  const proto = Element.prototype as any;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
  if (!(window as any).matchMedia) {
    (window as any).matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
  }
});

function knockQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => {
          const key = String(queryKey[0] ?? "");
          if (key.endsWith("/history")) return [];
          return { id: 7, notes: "", updatedAt: "2026-08-01T19:00:00.000Z" };
        },
      },
    },
  });
}

function renderKnockSheet() {
  const qc = knockQueryClient();
  const lead = {
    id: 7, address: "148 Maple St", city: "Rockwell", state: "NC", zip: "28138",
    leadStatus: "prospect", lat: 34.9, lng: -79.9,
  };
  return render(
    <QueryClientProvider client={qc}>
      <LeadKnockSheet
        lead={lead as any}
        onKnock={vi.fn()}
        onSaveNote={vi.fn().mockResolvedValue({ status: "saved", updatedAt: "2026-08-01T19:20:00.000Z" })}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("LeadKnockSheet — icon-only header buttons", () => {
  it("copy-address and close expose accessible names", () => {
    renderKnockSheet();
    // (Copy also appears in the utility row — both must be named.)
    expect(screen.getAllByRole("button", { name: "Copy address" }).length).toBeGreaterThan(0);
    expect(screen.getByTestId("knock-copy-address")).toHaveAccessibleName("Copy address");
    expect(screen.getByTestId("knock-sheet-close")).toHaveAccessibleName("Close");
  });

  it("sub-44px visual buttons expand their hit area to the tap floor", () => {
    renderKnockSheet();
    for (const testid of ["knock-copy-address", "knock-sheet-close"]) {
      const btn = screen.getByTestId(testid);
      // The ::after inset expands the 28/32px visual button to a ≥44px hit area.
      expect(btn.className).toContain("after:-inset-2");
    }
  });
});

// ── Ready-to-Call pager ──────────────────────────────────────────────────────
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 } }),
}));

import MyCommission from "@/pages/MyCommission";




// ── My pay loading region ────────────────────────────────────────────────────
function renderMyCommissionPending() {
  // Never resolves → the page stays in its loading state.
  apiRequest.mockImplementation(() => new Promise(() => {}));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MyCommission /></QueryClientProvider>);
}

describe("MyCommission — loading state", () => {
  it("announces itself as a busy status region", () => {
    renderMyCommissionPending();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAccessibleName(/loading your commission/i);
  });
});
