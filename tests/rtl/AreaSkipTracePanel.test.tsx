// The Area skip-trace panel.
//
// It renders numbers through the SAME <LeadContacts> the map card and knock
// sheet use, so the "a DNC number is never a tel: link" property is inherited
// rather than re-implemented. These tests assert the panel actually feeds that
// component correctly — a blocked number reaching it as `dnc:false` would
// defeat the guarantee no matter how good the component is.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCRUB_TTL_DAYS } from "../../shared/tracerfy";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const apiRequest = vi.fn(async () => ({ json: async () => ({}) } as unknown as Response));
vi.mock("@/lib/queryClient", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest: (...args: unknown[]) => apiRequest(...(args as [])) };
});

import { AreaSkipTracePanel } from "../../client/src/components/area/AreaSkipTracePanel";

const NOW = Date.now();
const DAY = 86_400_000;

const CLEAR = {
  number: "+19195550142", lineType: "wireless" as const, confidence: 0.92,
  dncFlags: {}, scrubbedAtMs: NOW - DAY,
};
const FEDERAL_DNC = {
  number: "+19195557788", lineType: "landline" as const, confidence: 0.81,
  dncFlags: { federalDnc: true }, scrubbedAtMs: NOW - DAY,
};
const NEVER_SCRUBBED = {
  number: "+19195559001", lineType: "unknown" as const, confidence: 0.4,
  dncFlags: {}, scrubbedAtMs: null,
};
const STALE = {
  number: "+19195552222", lineType: "wireless" as const, confidence: 0.7,
  dncFlags: {}, scrubbedAtMs: NOW - (SCRUB_TTL_DAYS + 2) * DAY,
};

const dialingList = {
  areaId: 7,
  entries: [{
    leadId: 501, address: "14 Maple St", city: "Cary", state: "NC", zip: "27511",
    ownerName: "Dana Reyes",
    phones: [CLEAR, FEDERAL_DNC, NEVER_SCRUBBED, STALE],
  }],
  totalPhones: 4, dialablePhones: 1, truncated: false,
  advisory: true, authorizationRequired: true,
};

const completedRun = {
  areaId: 7,
  run: {
    areaId: 7, runId: "11111111-1111-4111-8111-111111111111", status: "completed",
    eligibleLeads: 126, processedLeads: 126, failedLeads: 0,
    totalPhones: 340, dialablePhones: 220, errorCode: null,
    startedAt: "2026-08-04T10:00:00.000Z", finishedAt: "2026-08-04T10:09:00.000Z",
  },
  eligibleLeads: 126,
};

function renderPanel(opts: { run?: unknown; list?: unknown; canRun?: boolean } = {}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) => {
          const url = String(queryKey[0]);
          if (url.includes("/tracerfy-run")) return Promise.resolve(opts.run ?? completedRun);
          if (url.includes("/dialing-list")) return Promise.resolve(opts.list ?? dialingList);
          return Promise.resolve(null);
        },
      },
      mutations: { retry: false },
    },
  });
  const { hook } = memoryLocation({ path: "/areas/7" });
  return render(
    <Router hook={hook}>
      <QueryClientProvider client={qc}>
        <AreaSkipTracePanel areaId={7} canRun={opts.canRun ?? true} />
      </QueryClientProvider>
    </Router>,
  );
}

describe("AreaSkipTracePanel — blocked numbers are visible and inert", () => {
  beforeEach(() => { apiRequest.mockClear(); });

  it("shows the traced owner name", async () => {
    renderPanel();
    expect(await screen.findByTestId("lead-contact-name")).toHaveTextContent("Dana Reyes");
  });

  it("renders a clear number as a tel: link", async () => {
    renderPanel();
    const ok = await screen.findByTestId("lead-phone-+19195550142");
    expect(ok.tagName).toBe("A");
    expect(ok).toHaveAttribute("href", "tel:+19195550142");
  });

  it.each([
    ["a federal DNC hit", "+19195557788"],
    ["a never-scrubbed number", "+19195559001"],
    ["a number whose scrub expired", "+19195552222"],
  ])("shows %s but never as a link", async (_label, number) => {
    renderPanel();
    const blocked = await screen.findByTestId(`lead-phone-${number}`);
    expect(blocked.tagName).not.toBe("A");
    expect(blocked.closest("a")).toBeNull();
  });

  it("exposes exactly one tel: link for four numbers", async () => {
    const { container } = renderPanel();
    await screen.findByTestId("lead-contacts");
    expect(container.querySelectorAll('a[href^="tel:"]')).toHaveLength(1);
  });

  it("says plainly that the list is a worklist, not a call approval", async () => {
    renderPanel();
    await screen.findByTestId("dialing-list");
    expect(screen.getByText(/not a call approval/i)).toBeInTheDocument();
  });
});

describe("AreaSkipTracePanel — running it", () => {
  beforeEach(() => { apiRequest.mockClear(); });

  it("reports the finished run in the words the operator asked for", async () => {
    renderPanel();
    expect(await screen.findByTestId("skip-trace-summary"))
      .toHaveTextContent("Processed 126 leads, 340 phones, 220 dialable");
  });

  it("requires a confirmation naming the door count before spending", async () => {
    renderPanel();
    await userEvent.click(await screen.findByTestId("area-action-skip-trace"));
    const confirm = screen.getByTestId("skip-trace-confirm");
    expect(confirm).toHaveTextContent("126");
    expect(apiRequest).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("skip-trace-confirm-yes"));
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/areas/7/tracerfy-run", {});
  });

  it("sends nothing when the confirmation is cancelled", async () => {
    renderPanel();
    await userEvent.click(await screen.findByTestId("area-action-skip-trace"));
    await userEvent.click(screen.getByTestId("skip-trace-confirm-no"));
    expect(screen.queryByTestId("skip-trace-confirm")).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("hides the run button from a viewer who may not spend — never disables it", async () => {
    renderPanel({ canRun: false });
    await screen.findByTestId("dialing-list");
    expect(screen.queryByTestId("area-action-skip-trace")).toBeNull();
  });

  it("shows live progress while a run is in flight", async () => {
    renderPanel({
      run: {
        areaId: 7, eligibleLeads: 126,
        run: { ...completedRun.run, status: "running", processedLeads: 40, dialablePhones: 0, finishedAt: null },
      },
    });
    expect(await screen.findByTestId("skip-trace-summary")).toHaveTextContent("Running — 40 of 126 doors");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  });

  it("explains a run that stopped early instead of implying success", async () => {
    renderPanel({
      run: {
        areaId: 7, eligibleLeads: 126,
        run: { ...completedRun.run, status: "failed", errorCode: "ALL_BATCHES_FAILED", processedLeads: 0 },
      },
    });
    expect(await screen.findByTestId("skip-trace-error")).toHaveTextContent(/all batches failed/i);
  });
});
