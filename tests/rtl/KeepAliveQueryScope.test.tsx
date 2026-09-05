import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { KeepAliveStages } from "../../client/src/components/KeepAliveStages";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const keep = () => true;
function harness(Page: React.ComponentType<{ path: string }>, qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })) {
  function Harness() {
    const [path, setPath] = useState("a");
    const [owner, setOwner] = useState("first");
    return <QueryClientProvider client={qc}>
      <button onClick={() => setPath("a")}>Open A</button><button onClick={() => setPath("b")}>Open B</button>
      <button onClick={() => setOwner("second")}>Change scope</button>
      <KeepAliveStages activeLocation={path} resetKey={owner} keepAlive={keep} renderStage={path => <Page path={path} />} />
    </QueryClientProvider>;
  }
  render(<Harness />); return qc;
}

describe("kept-stage query ownership", () => {
  it("refreshes the returning screen without refetching hidden screens", async () => {
    const fetches = { a: 0, b: 0 };
    function Page({ path }: { path: string }) {
      const q = useQuery({ queryKey: [path], queryFn: async () => ++fetches[path as "a" | "b"] });
      return <output data-testid={path}>{q.data}</output>;
    }
    harness(Page); await waitFor(() => expect(fetches.a).toBe(1));
    fireEvent.click(screen.getByText("Open B")); await waitFor(() => expect(fetches.b).toBe(1));
    fireEvent.click(screen.getByText("Open A")); await waitFor(() => expect(fetches.a).toBe(2));
    expect(fetches.b).toBe(1);
  });
  it("uses the returning observer's freshness for a shared key, preserving disabled observers", async () => {
    const fetchShared = vi.fn(async () => "shared");
    const fetchDisabled = vi.fn(async () => "disabled");
    function Page({ path }: { path: string }) {
      const q = useQuery({ queryKey: ["shared"], queryFn: fetchShared, staleTime: path === "a" ? Infinity : 0 });
      useQuery({ queryKey: ["disabled", path], queryFn: fetchDisabled, enabled: false });
      return <output>{q.data}</output>;
    }
    harness(Page); await waitFor(() => expect(fetchShared).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Open B")); await waitFor(() => expect(fetchShared).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText("Open A")); await act(async () => {});
    expect(fetchShared).toHaveBeenCalledTimes(2); expect(fetchDisabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Open B")); await waitFor(() => expect(fetchShared).toHaveBeenCalledTimes(3));
  });
  it("shares caches and changing root defaults with only one focus subscription", async () => {
    const subscribe = vi.spyOn(focusManager, "subscribe");
    const fetcher = vi.fn(async () => "root default");
    const qc = new QueryClient({ defaultOptions: { queries: { queryFn: fetcher, staleTime: Infinity, retry: false } } });
    function Page({ path }: { path: string }) {
      const client = useQueryClient();
      expect(client.getQueryCache()).toBe(qc.getQueryCache());
      expect(client.getMutationCache()).toBe(qc.getMutationCache());
      const q = useQuery({ queryKey: [path] });
      return <output data-testid={path}>{String(q.data ?? "loading")}</output>;
    }
    harness(Page, qc); await screen.findByText("root default");
    fireEvent.click(screen.getByText("Open B")); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    act(() => qc.setQueryDefaults(["a"], { staleTime: 0 }));
    fireEvent.click(screen.getByText("Open A")); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
  it("remounts the active stage's local state on identity/scope change", () => {
    function Page() { const [draft, setDraft] = useState(""); return <input aria-label="Private draft" value={draft} onChange={event => setDraft(event.target.value)} />; }
    harness(Page);
    fireEvent.change(screen.getByLabelText("Private draft"), { target: { value: "Old tenant detail" } });
    fireEvent.click(screen.getByText("Change scope"));
    expect(screen.getByLabelText("Private draft")).toHaveValue("");
  });
});
