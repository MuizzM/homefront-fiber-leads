// The Import leads page: the server's preview drives every number, the phone
// column is locked and explained, a remap re-previews, and Import sends the
// mapping plus where the new doors go.
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const apiUpload = vi.fn();
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiUpload: (...a: any[]) => apiUpload(...a),
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("wouter", () => ({ useLocation: () => ["/leads/import", vi.fn()] }));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import ImportLeads from "../../client/src/pages/ImportLeads";

const PREVIEW = {
  fileName: "rowan-q3.csv", columns: ["Address", "City", "Phone", "Rep"], rowCount: 3, truncated: false, maxRows: 5000,
  mapping: { "0": "address", "1": "city", "2": "ignore", "3": "assignedRep" },
  validation: { ok: true, issues: [] },
  sampleRows: [["1842 Oak Ridge Dr", "Salisbury", "•••", "Jordan Price"]],
  summary: { rows: 3, ready: 2, missingAddress: 0, missingCity: 0, duplicatesInFile: 0, alreadyOnMap: 1, unknownReps: ["Nobody Known"], repMatched: 1, countyMatched: 2, addressNotFound: 0 },
  needsFix: [{ rowNumber: 3, status: "already_on_map", address: "1838 Oak Ridge Dr", city: "Salisbury", state: "NC", zip: "28146", repName: null }],
};

function renderPage() {
  apiRequest.mockImplementation(() => Promise.resolve({ json: () => Promise.resolve([{ id: 7, name: "Jordan Price", active: true }]) }));
  apiUpload.mockImplementation((url: string) => Promise.resolve({
    json: () => Promise.resolve(url.endsWith("/preview") ? PREVIEW : { created: 2, existing: 0, geocoded: 2, ungeocoded: 0, assigned: 1, skipped: { missingAddress: 0, missingCity: 0, duplicatesInFile: 0, alreadyOnMap: 1 }, unknownReps: ["Nobody Known"] }),
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ImportLeads /></QueryClientProvider>);
}
const chooseFile = () => {
  const input = screen.getByTestId("import-file-input") as HTMLInputElement;
  const file = new File(["Address,City\n1 A St,Town"], "rowan-q3.csv", { type: "text/csv" });
  fireEvent.change(input, { target: { files: [file] } });
};

beforeEach(() => { apiUpload.mockReset(); apiRequest.mockReset(); toast.mockReset(); });

describe("<ImportLeads />", () => {
  it("previews the chosen file and renders the server's mapping, locking the phone column", async () => {
    renderPage();
    chooseFile();
    await screen.findByTestId("import-mapping");
    expect(apiUpload).toHaveBeenCalledTimes(1);
    expect(String(apiUpload.mock.calls[0][0])).toBe("/api/leads/import/preview");
    expect(screen.getByTestId("import-file-facts")).toHaveTextContent("3 rows · 4 columns");
    const phone = screen.getByTestId("import-target-2") as HTMLSelectElement;
    expect(phone.disabled).toBe(true);
    expect(screen.getByTestId("import-col-2")).toHaveTextContent("Phones come in through Calling only");
    expect(screen.getByTestId("import-col-0")).toHaveTextContent("Matched");
    expect(screen.getByTestId("import-ready")).toHaveTextContent("2");
    expect(screen.getByTestId("import-skipped")).toHaveTextContent("1");
    expect(screen.getByTestId("import-file-reps")).toHaveTextContent("1 of 2 rows name a rep you manage");
    expect(screen.getByTestId("import-file-reps")).toHaveTextContent("Nobody Known");
    expect(screen.getByTestId("import-needs-fix")).toHaveTextContent("Download the 1 rows to fix");
  });

  it("changing a column re-previews with the new mapping", async () => {
    renderPage();
    chooseFile();
    await screen.findByTestId("import-mapping");
    fireEvent.change(screen.getByTestId("import-target-3"), { target: { value: "notes" } });
    await waitFor(() => expect(apiUpload).toHaveBeenCalledTimes(2));
    const form = apiUpload.mock.calls[1][1] as FormData;
    expect(JSON.parse(String(form.get("mapping")))).toEqual({ "0": "address", "1": "city", "2": "ignore", "3": "notes" });
  });

  it("Import sends the mapping and where the doors go, then reports the result", async () => {
    renderPage();
    chooseFile();
    await screen.findByTestId("import-mapping");
    fireEvent.click(screen.getByTestId("import-assign-rep"));
    // One rep needs a pick before Import enables.
    expect(screen.getByTestId("import-run")).toBeDisabled();
    await screen.findByTestId("import-one-rep");
    fireEvent.change(screen.getByTestId("import-one-rep"), { target: { value: "7" } });
    expect(screen.getByTestId("import-run")).toBeEnabled();
    fireEvent.click(screen.getByTestId("import-run"));
    await screen.findByTestId("import-result");
    const form = apiUpload.mock.calls.at(-1)![1] as FormData;
    expect(String(apiUpload.mock.calls.at(-1)![0])).toBe("/api/leads/import");
    expect(form.get("assign")).toBe("rep:7");
    expect(JSON.parse(String(form.get("mapping")))).toEqual(PREVIEW.mapping);
    expect(within(screen.getByTestId("import-result")).getByText(/2 leads imported/)).toBeTruthy();
  });
});
