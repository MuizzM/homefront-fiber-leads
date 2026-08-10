import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Database, Gauge, History, Loader2, Map as MapIcon, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import {
  kineticScannerApi,
  type KineticAddress,
} from "@/lib/kineticScannerApi";
import { KineticScannerMap } from "@/components/kinetic/KineticScannerMap";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

type Tab =
  | "dashboard"
  | "evidence"
  | "addresses"
  | "map"
  | "hotspots"
  | "changes"
  | "jobs";
const tabs: [Tab, string, React.ElementType][] = [
  ["dashboard", "Dashboard", Gauge],
  ["evidence", "Evidence", ShieldCheck],
  ["addresses", "Addresses", Database],
  ["map", "Map", MapIcon],
  ["hotspots", "Hotspots", Zap],
  ["changes", "Changes", History],
  ["jobs", "Jobs", Activity],
];
const fmt = (value: unknown) => Number(value ?? 0).toLocaleString();
function staleSeconds(value?: string | null) {
  if (!value) return null;
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
}
function badge(address: KineticAddress) {
  if (address.discoveryState === "VERIFIED_FRESH")
    return ["Verified Fresh", "bg-success/10 text-success"];
  if (address.discoveryState === "CANDIDATE_FRESH")
    return ["Fresh Candidate", "bg-warning/10 text-warning"];
  if (address.discoveryState === "BASELINE_FIBER")
    return ["Fiber Baseline", "bg-secondary text-secondary-foreground"];
  if (address.discoveryState === "REGRESSED")
    return ["Regressed", "bg-destructive/10 text-destructive"];
  if (address.isLive) return ["Live Fiber", "bg-success/10 text-success"];
  if (address.isComingSoon)
    return ["Coming Soon", "bg-warning/10 text-warning"];
  if (address.isCopperUpgradeCandidate)
    return ["Copper Upgrade", "bg-warning/10 text-warning"];
  return ["Observed", "bg-secondary text-secondary-foreground"];
}

export default function KineticScanner() {
  const [tab, setTab] = useState<Tab>("dashboard"),
    [selected, setSelected] = useState<number | null>(null);
  const { data: ping } = useQuery({
    queryKey: ["kinetic-ping"],
    queryFn: kineticScannerApi.ping,
    refetchInterval: 30_000,
  });
  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.08),transparent_38%)] px-3 py-4 sm:px-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-xl">
          <div className="flex flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
            
            <div>
              <h1 className="text-xl font-bold tracking-tight">
                Kinetic Evidence Scanner
              </h1>
              <p className="text-xs text-muted-foreground">
                Evidence-backed serviceability intelligence · no assumed private
                API
              </p>
            </div>
            <div
              className={`ml-auto flex items-center gap-2 rounded-full px-2 py-0.5 text-2xs font-semibold ${ping?.ok ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}
            >
              <i
                className={`h-2 w-2 rounded-full ${ping?.ok ? "bg-success" : "bg-warning"}`}
              />
              {ping?.ok
                ? `${ping.source} · ${ping.latencyMs}ms`
                : `${String(ping?.mode ?? "offline").replaceAll("_", " ")} · safe`}
            </div>
          </div>
          <nav
            role="tablist"
            className="flex items-center overflow-x-auto border-t border-border px-2"
            aria-label="Kinetic Scanner sections"
          >
            {tabs.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`relative flex h-10 shrink-0 items-center gap-1.5 rounded-t border-b-2 px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${tab === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                
                {label}
              </button>
            ))}
          </nav>
        </header>
        {tab === "dashboard" && (
          <Dashboard
            onAddresses={() => setTab("addresses")}
            onEvidence={() => setTab("evidence")}
          />
        )}{" "}
        {tab === "evidence" && <EvidenceCenter />}{" "}
        {tab === "addresses" && <Addresses onOpen={setSelected} />}{" "}
        {tab === "map" && <KineticScannerMap onOpen={setSelected} />}{" "}
        {tab === "hotspots" && <Hotspots />} {tab === "changes" && <Changes />}{" "}
        {tab === "jobs" && <Jobs />}
      </div>
      {selected != null && (
        <AddressDrawer id={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function Dashboard({
  onAddresses,
  onEvidence,
}: {
  onAddresses: () => void;
  onEvidence: () => void;
}) {
  const qc = useQueryClient(),
    { toast } = useToast();
  const { data: state } = useQuery({
    queryKey: ["kinetic-state"],
    queryFn: kineticScannerApi.state,
    refetchInterval: 5_000,
  });
  const { data: stats } = useQuery({
    queryKey: ["kinetic-stats"],
    queryFn: kineticScannerApi.stats,
    refetchInterval: 15_000,
  });
  const { data: evidence } = useQuery({
    queryKey: ["kinetic-evidence-config"],
    queryFn: kineticScannerApi.evidenceConfig,
  });
  const recheck = state?.recheckWorker,
    stale = staleSeconds(recheck?.lastHeartbeat);
  return (
    <div className="space-y-4">
      {recheck?.status === "running" && stale != null && stale > 120 && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          
          Recheck worker may have stalled. Last heartbeat was {stale} seconds
          ago.
        </div>
      )}
      <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[
          ["Total Addresses", stats?.totalAddresses, Database],
          ["Verified Fresh", stats?.verifiedFresh, Zap],
          ["Fresh Candidates", stats?.candidateFresh, RefreshCw],
          ["Errors This Cycle", stats?.errorsThisCycle, AlertTriangle],
        ].map(([label, value]: any) => (
          <button
            key={label}
            onClick={label === "Total Addresses" ? onAddresses : undefined}
            className="rounded-2xl border border-border bg-card p-4 text-left shadow-sm"
          >
            <div className="flex items-center text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              
              {label}
            </div>
            <div className="mt-3 text-2xl font-bold tabular-nums">
              {fmt(value)}
            </div>
            {label === "Verified Fresh" && (
              <div className="mt-1 text-2xs text-muted-foreground">
                Repeat-confirmed transition
              </div>
            )}
          </button>
        ))}
      </section>
      <section className="grid gap-4 lg:grid-cols-[1fr_.8fr]">
        <article className="rounded-2xl border border-border bg-card p-5 text-foreground">
          <div className="flex items-center gap-2">
            
            <h2 className="text-sm font-semibold">Evidence posture</h2>
            <span className="ml-auto rounded-full bg-warning/10 px-2 py-0.5 text-2xs font-semibold uppercase text-warning">
              {String(evidence?.configured?.mode ?? "offline").replaceAll(
                "_",
                " ",
              )}
            </span>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            No private Kinetic API is assumed. Import approved evidence or
            record a manual verification. Live qualification remains off until a
            permitted adapter and exact contract are registered.
          </p>
          <button
            onClick={onEvidence}
            className="mt-4 h-11 w-full rounded-xl bg-primary text-xs font-bold text-primary-foreground hover:bg-primary/90"
          >
            Manage evidence sources
          </button>
        </article>
        <Worker
          title="Recheck Worker"
          worker={recheck}
          onControl={async (action) => {
            try {
              if (action === "stop") await kineticScannerApi.stopRecheck();
              else if (
                !recheck ||
                ["stopped", "completed", "failed"].includes(recheck.status)
              )
                await kineticScannerApi.startRecheck();
              qc.invalidateQueries({ queryKey: ["kinetic-state"] });
            } catch (error: any) {
              toast({
                title: "Recheck unavailable",
                description: error.message,
                variant: "destructive",
              });
            }
          }}
        />
      </section>
      <Diagnostics state={state} />
    </div>
  );
}
function Worker({
  title,
  worker,
  onControl,
}: {
  title: string;
  worker: any;
  onControl: (a: "stop" | "start") => void;
}) {
  const running = worker?.status === "running";
  return (
    <article className="rounded-2xl border border-border bg-card p-4 text-foreground">
      <div className="flex items-center">
        
        <h2 className="ml-2 text-sm font-semibold">{title}</h2>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-2xs font-semibold uppercase ${running ? "bg-warning/10 text-warning" : "bg-secondary text-secondary-foreground"}`}
        >
          {worker?.status ?? "stopped"}
        </span>
      </div>
      <div className="mt-4 text-2xs uppercase tracking-wider text-muted-foreground">
        Recheck Checked
      </div>
      <div className="mt-1 font-mono text-2xl font-bold text-foreground">
        {fmt(worker?.checked ?? 0)}
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full rounded-full bg-primary ${running ? "w-full animate-pulse" : "w-0"}`}
        />
      </div>
      <div className="mt-4 grid grid-cols-4 gap-1">
        {[
          ["Checked", worker?.checked],
          ["Found", worker?.found],
          ["Live", worker?.live],
          ["Errors", worker?.errors],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-lg bg-secondary/50 p-2">
            <div className="text-sm font-bold">{fmt(value)}</div>
            <div className="text-2xs uppercase text-muted-foreground">
              {label}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          onClick={() => onControl(running ? "stop" : "start")}
          className={`h-10 w-full rounded-xl text-xs font-bold ${running ? "border border-destructive/30 text-destructive" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}
        >
          {running ? "Stop Recheck" : "Start Recheck"}
        </button>
      </div>
    </article>
  );
}
function Diagnostics({ state }: { state: any }) {
  const values = [
    ["Checks per Second", state?.checksPerSecond ?? 0],
    ["Concurrency", state?.concurrency ?? 1],
    [
      "Heap Usage",
      state?.memory?.heapUsedMb != null ? `${state.memory.heapUsedMb} MB` : " - ",
    ],
    [
      "RSS Memory",
      state?.memory?.rssMb != null ? `${state.memory.rssMb} MB` : " - ",
    ],
    [
      "Last Heartbeat",
      state?.recheckWorker?.lastHeartbeat
        ? new Date(state.recheckWorker.lastHeartbeat).toLocaleTimeString()
        : " - ",
    ],
  ];
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">Runtime diagnostics</h2>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
        {values.map(([label, value]) => (
          <div key={label as string} className="rounded-xl bg-secondary/50 p-3">
            <div className="text-sm font-bold tabular-nums">{value}</div>
            <div className="mt-1 text-2xs uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function EvidenceCenter() {
  const qc = useQueryClient(),
    { toast } = useToast(),
    [mode, setMode] = useState("offline"),
    [confirmed, setConfirmed] = useState(false),
    [sourceName, setSourceName] = useState(""),
    [format, setFormat] = useState<"json" | "csv">("json"),
    [content, setContent] = useState(""),
    [manual, setManual] = useState({
      address: "",
      city: "",
      state: "NC",
      zip: "",
      technologyType: "",
      isLive: "unknown",
      reviewerNote: "",
    });
  const { data: config } = useQuery({
    queryKey: ["kinetic-evidence-config"],
    queryFn: kineticScannerApi.evidenceConfig,
  });
  const { data: imports } = useQuery({
    queryKey: ["kinetic-imports"],
    queryFn: kineticScannerApi.imports,
  });
  useEffect(() => {
    const configured = config?.configured;
    if (!configured) return;
    setMode(configured.mode ?? "offline");
    setSourceName(configured.sourceName ?? "");
    setConfirmed(Boolean(configured.publicUseConfirmed));
  }, [config?.configured]);
  const save = useMutation({
    mutationFn: () =>
      kineticScannerApi.setEvidenceConfig({
        mode,
        sourceName: sourceName || null,
        publicUseConfirmed: mode === "authorized_public_lookup" && confirmed,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kinetic-evidence-config"] });
      toast({ title: "Evidence mode updated" });
    },
    onError: (error: any) =>
      toast({
        title: "Mode not updated",
        description: error.message,
        variant: "destructive",
      }),
  });
  const upload = useMutation({
    mutationFn: () => {
      if (!sourceName.trim())
        throw new Error("Approved source name is required");
      if (format === "json") {
        const records = JSON.parse(content);
        if (!Array.isArray(records))
          throw new Error("JSON import must be an array");
        return kineticScannerApi.importEvidence({
          format,
          sourceName: sourceName.trim(),
          records,
        });
      }
      return kineticScannerApi.importEvidence({
        format,
        sourceName: sourceName.trim(),
        content,
      });
    },
    onSuccess: (summary: any) => {
      qc.invalidateQueries({ queryKey: ["kinetic-imports"] });
      qc.invalidateQueries({ queryKey: ["kinetic-addresses"] });
      qc.invalidateQueries({ queryKey: ["kinetic-scanner-map"] });
      setContent("");
      toast({
        title: "Evidence import complete",
        description: `${summary.accepted} accepted · ${summary.rejected} rejected · ${summary.replays} replayed`,
      });
    },
    onError: (error: any) =>
      toast({
        title: "Import rejected",
        description: error.message,
        variant: "destructive",
      }),
  });
  const verify = useMutation({
    mutationFn: () =>
      kineticScannerApi.manualVerification({
        address: manual.address,
        city: manual.city,
        state: manual.state,
        zip: manual.zip,
        unit: null,
        observedAt: new Date().toISOString(),
        latitude: null,
        longitude: null,
        technologyType: manual.technologyType || null,
        maximumQualification: null,
        isLive: manual.isLive === "unknown" ? null : manual.isLive === "true",
        isComingSoon: null,
        isCopperUpgradeCandidate: null,
        reviewerNote: manual.reviewerNote,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kinetic-addresses"] });
      qc.invalidateQueries({ queryKey: ["kinetic-scanner-map"] });
      setManual({
        address: "",
        city: "",
        state: "NC",
        zip: "",
        technologyType: "",
        isLive: "unknown",
        reviewerNote: "",
      });
      toast({ title: "Manual evidence recorded" });
    },
    onError: (error: any) =>
      toast({
        title: "Verification rejected",
        description: error.message,
        variant: "destructive",
      }),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-border bg-card p-4 lg:col-span-2">
        <div className="flex items-center gap-2">
          
          <h2 className="text-sm font-semibold">Evidence source policy</h2>
          <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-2xs font-semibold uppercase text-secondary-foreground">
            Active:{" "}
            {String(config?.configured?.mode ?? "offline").replaceAll("_", " ")}
          </span>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          A mode is policy, not proof that a source exists. Approved API and
          public lookup remain inactive unless a reviewed adapter is registered
          server-side. Public lookup additionally requires explicit
          administrator confirmation.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            className="h-11 rounded-xl border border-border bg-background px-3 text-xs"
          >
            <option value="offline">Offline</option>
            <option value="authorized_import">Authorized import</option>
            <option value="manual_verification">Manual verification</option>
            <option value="approved_api">Approved API</option>
            <option value="authorized_public_lookup">
              Authorized public lookup
            </option>
          </select>
          <input
            value={sourceName}
            onChange={(event) => setSourceName(event.target.value)}
            aria-label="Evidence source name"
            placeholder="Approved source name"
            className="h-11 rounded-xl border border-border bg-background px-3 text-xs"
          />
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="h-11 rounded-xl bg-primary px-5 text-xs font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Save mode
          </button>
        </div>
        {mode === "authorized_public_lookup" && (
          <label className="mt-3 flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/5 p-3 text-xs">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              I confirm the exact public request contract and intended automated
              use have been reviewed and are permitted. The scanner must stop on
              denial, CAPTCHA, challenge, or repeated rate limits.
            </span>
          </label>
        )}
      </section>
      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          
          <h2 className="text-sm font-semibold">Approved evidence import</h2>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Upload explicit CSV or JSON evidence. Unknown fields and malformed
          records are rejected; valid records are hashed and deduplicated.
        </p>
        <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
          <input
            value={sourceName}
            onChange={(event) => setSourceName(event.target.value)}
            aria-label="Import source name"
            placeholder="Approved source name"
            className="h-10 rounded-xl border border-border bg-background px-3 text-xs"
          />
          <select
            value={format}
            onChange={(event) =>
              setFormat(event.target.value as "json" | "csv")
            }
            className="h-10 rounded-xl border border-border bg-background px-3 text-xs"
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
        </div>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          aria-label="Evidence import content"
          rows={9}
          className="mt-2 w-full rounded-xl border border-border bg-background p-3 font-mono text-2xs"
        />
        <button
          onClick={() => upload.mutate()}
          disabled={upload.isPending || !content.trim()}
          className="mt-2 h-11 w-full rounded-xl bg-primary text-xs font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Validate and import
        </button>
      </section>
      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          
          <h2 className="text-sm font-semibold">Manual verification</h2>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Record what an authorized reviewer observed. Unknown remains
          inconclusive and never changes serviceability truth.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <input
            value={manual.address}
            onChange={(event) =>
              setManual({ ...manual, address: event.target.value })
            }
            aria-label="Street address"
            placeholder="Street address"
            className="col-span-2 h-10 rounded-xl border border-border bg-background px-3 text-xs"
          />
          <input
            value={manual.city}
            onChange={(event) =>
              setManual({ ...manual, city: event.target.value })
            }
            aria-label="City"
            placeholder="City"
            className="h-10 rounded-xl border border-border bg-background px-3 text-xs"
          />
          <input
            value={manual.state}
            onChange={(event) =>
              setManual({
                ...manual,
                state: event.target.value.toUpperCase().slice(0, 2),
              })
            }
            aria-label="State"
            className="h-10 rounded-xl border border-border bg-background px-3 text-xs"
          />
          <input
            value={manual.zip}
            onChange={(event) =>
              setManual({ ...manual, zip: event.target.value })
            }
            aria-label="ZIP code"
            placeholder="ZIP"
            className="h-10 rounded-xl border border-border bg-background px-3 text-xs"
          />
          <select
            value={manual.isLive}
            onChange={(event) =>
              setManual({ ...manual, isLive: event.target.value })
            }
            aria-label="Serviceability"
            className="h-10 rounded-xl border border-border bg-background px-3 text-xs"
          >
            <option value="unknown">Inconclusive</option>
            <option value="true">Live</option>
            <option value="false">Not live</option>
          </select>
          <input
            value={manual.technologyType}
            onChange={(event) =>
              setManual({ ...manual, technologyType: event.target.value })
            }
            aria-label="Technology type"
            placeholder="Technology returned"
            className="col-span-2 h-10 rounded-xl border border-border bg-background px-3 text-xs"
          />
          <textarea
            value={manual.reviewerNote}
            onChange={(event) =>
              setManual({ ...manual, reviewerNote: event.target.value })
            }
            aria-label="Reviewer note"
            placeholder="Describe the permitted verification source and result"
            rows={4}
            className="col-span-2 rounded-xl border border-border bg-background p-3 text-xs"
          />
        </div>
        <button
          onClick={() => verify.mutate()}
          disabled={verify.isPending}
          className="mt-2 h-11 w-full rounded-xl bg-primary text-xs font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Record signed-in review
        </button>
      </section>
      <section className="rounded-2xl border border-border bg-card p-4 lg:col-span-2">
        <h2 className="text-sm font-semibold">Recent import ledger</h2>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {imports?.items?.map((item: any) => (
            <div key={item.id} className="rounded-xl bg-secondary/50 p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold">{item.sourceName}</span>
                <span className="ml-auto text-2xs uppercase text-muted-foreground">
                  {item.format}
                </span>
              </div>
              <div className="mt-1 text-2xs text-muted-foreground">
                {item.acceptedCount} accepted · {item.rejectedCount} rejected ·{" "}
                {new Date(item.createdAt).toLocaleString()}
              </div>
            </div>
          ))}
          {!imports?.items?.length && (
            <p className="text-xs text-muted-foreground">
              No evidence imports recorded.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function Addresses({ onOpen }: { onOpen: (id: number) => void }) {
  const [search, setSearch] = useState(""),
    [state, setState] = useState(""),
    [filter, setFilter] = useState("all"),
    [page, setPage] = useState(1);
  const params = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: "50" });
    if (search) p.set("search", search);
    if (state) p.set("state", state);
    if (filter === "live") p.set("liveOnly", "true");
    if (filter === "coming") p.set("comingSoonOnly", "true");
    if (filter === "copper") p.set("copperUpgradeCandidateOnly", "true");
    return p;
  }, [search, state, filter, page]);
  const { data, isLoading } = useQuery({
    queryKey: ["kinetic-addresses", params.toString()],
    queryFn: () => kineticScannerApi.addresses(params),
  });
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap gap-2 border-b border-border p-3">
        <label className="relative min-w-48 flex-1">
          
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Address or Kinetic Address ID"
            className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-xs"
          />
        </label>
        <input
          value={state}
          maxLength={2}
          onChange={(e) => {
            setState(e.target.value.toUpperCase());
            setPage(1);
          }}
          placeholder="State"
          className="h-10 w-20 rounded-xl border border-border bg-background px-3 text-xs uppercase"
        />
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
          className="h-10 rounded-xl border border-border bg-background px-3 text-xs"
        >
          <option value="all">All statuses</option>
          <option value="live">Live only</option>
          <option value="coming">Coming Soon only</option>
          <option value="copper">Copper Upgrade Candidate only</option>
        </select>
        <button
          onClick={() => void kineticScannerApi.downloadExport()}
          className="h-10 rounded-xl border border-border px-3 text-xs font-semibold"
        >
          
          Export
        </button>
      </div>
      {isLoading ? (
        <div className="space-y-2 p-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : !data?.items.length ? (
        <div className="m-3 rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No addresses match these filters. Adjust the search or import
          evidence to populate the ledger.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className="bg-secondary/50 text-2xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  {[
                    "Sequential ID",
                    "Kinetic Address ID",
                    "Address",
                    "Technology",
                    "Qualification",
                    "Status",
                    "Last checked",
                    "",
                  ].map((h) => (
                    <th key={h} className="px-3 py-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data?.items.map((a) => {
                  const [label, tone] = badge(a);
                  return (
                    <tr
                      key={a.id}
                      className="border-t border-border hover:bg-secondary/25"
                    >
                      <td className="px-3 py-3 font-mono font-semibold">
                        {a.sequentialId ?? " - "}
                      </td>
                      <td className="px-3 py-3 font-mono text-2xs">
                        {a.kineticAddressId ?? " - "}
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-semibold">
                          {a.address ?? "Address unavailable"}
                        </div>
                        <div className="text-2xs text-muted-foreground">
                          {[a.city, a.state, a.zip].filter(Boolean).join(", ")}
                        </div>
                      </td>
                      <td className="px-3 py-3">{a.technologyType ?? " - "}</td>
                      <td className="px-3 py-3">
                        {a.maximumQualification ?? " - "}
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-2xs font-semibold ${tone}`}
                        >
                          {label}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-2xs text-muted-foreground">
                        {a.lastChecked
                          ? new Date(a.lastChecked).toLocaleString()
                          : " - "}
                      </td>
                      <td className="px-3 py-3">
                        <button
                          onClick={() => onOpen(a.id)}
                          className="h-9 rounded-lg border border-border px-3 font-semibold"
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-border p-3 text-xs text-muted-foreground">
            <span>{fmt(data?.total)} addresses · 50 per page</span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="h-9 rounded-lg border border-border px-3 disabled:opacity-30"
              >
                Previous
              </button>
              <span className="grid h-9 place-items-center px-2">
                {page} / {data?.pages ?? 1}
              </span>
              <button
                disabled={page >= (data?.pages ?? 1)}
                onClick={() => setPage((p) => p + 1)}
                className="h-9 rounded-lg border border-border px-3 disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function Hotspots() {
  const { data, isLoading } = useQuery({
    queryKey: ["kinetic-hotspots"],
    queryFn: kineticScannerApi.hotspots,
  });
  if (isLoading)
    return (
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
    );
  if (!data?.hotspots?.length)
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No hotspots yet. Verified addresses will cluster here by city and ZIP
        as evidence accumulates.
      </div>
    );
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {data?.hotspots?.map((h: any, i: number) => (
        <article
          key={`${h.city}-${h.zip}-${i}`}
          className="rounded-2xl border border-border bg-card p-4"
        >
          <div className="text-sm font-semibold">
            {h.city || "Unknown city"}, {h.state} {h.zip}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              ["Addresses", h.addressCount],
              ["Live", h.liveCount],
              ["Copper", h.copperUpgradeCount],
            ].map(([l, v]) => (
              <div key={l as string} className="rounded-lg bg-secondary/50 p-2">
                <b>{fmt(v)}</b>
                <div className="text-2xs uppercase text-muted-foreground">
                  {l}
                </div>
              </div>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
function Changes() {
  const { data, isLoading } = useQuery({
    queryKey: ["kinetic-changes"],
    queryFn: kineticScannerApi.changes,
    refetchInterval: 15_000,
  });
  if (isLoading)
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  if (!data?.items?.length)
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No field changes recorded yet. Serviceability transitions will appear
        here as rechecks land.
      </div>
    );
  return (
    <section className="space-y-2">
      {data?.items?.map((c: any) => (
        <article
          key={c.id}
          className="rounded-xl border border-border bg-card p-3"
        >
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-semibold text-primary">
              {c.fieldName}
            </span>
            <span className="ml-auto text-2xs text-muted-foreground">
              {new Date(c.changedAt).toLocaleString()}
            </span>
          </div>
          <div className="mt-2 text-xs font-semibold">
            {c.address || c.kineticAddressId}
          </div>
          <div className="mt-1 font-mono text-2xs text-muted-foreground">
            {c.previousValue ?? "unknown"} to {c.currentValue ?? "unknown"}
          </div>
        </article>
      ))}
    </section>
  );
}
function Jobs() {
  const { data, isLoading } = useQuery({
    queryKey: ["kinetic-state"],
    queryFn: kineticScannerApi.state,
    refetchInterval: 5000,
  });
  if (isLoading)
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
    );
  if (!data?.jobs?.length)
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No scan or recheck jobs have run yet. Start the recheck worker from
        the dashboard to queue work.
      </div>
    );
  return (
    <section className="space-y-2">
      {data?.jobs?.map((j: any) => (
        <article
          key={j.id}
          className="rounded-2xl border border-border bg-card p-4"
        >
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-semibold uppercase text-primary">
              {j.workerType}
            </span>
            <code className="text-2xs">{j.id}</code>
            <span className="ml-auto text-xs capitalize">{j.status}</span>
          </div>
          <div className="mt-3 font-mono text-sm">
            {j.workerType === "scan"
              ? `${fmt(j.startSequentialId)} to ${fmt(j.endSequentialId)}`
              : `${fmt(j.checked)} addresses rechecked`}
          </div>
          <div className="mt-2 text-2xs text-muted-foreground">
            {fmt(j.checked)} checked · {fmt(j.found)} found · {fmt(j.errors)}{" "}
            errors
          </div>
        </article>
      ))}
    </section>
  );
}
function AddressDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient(),
    { toast } = useToast(),
    { data, isLoading } = useQuery({
      queryKey: ["kinetic-detail", id],
      queryFn: () => kineticScannerApi.detail(id),
    });
  const act = async (type: "recheck" | "contacts" | "convert") => {
    try {
      if (type === "recheck") await kineticScannerApi.recheck(id);
      if (type === "contacts") await kineticScannerApi.refreshContacts(id);
      if (type === "convert") await kineticScannerApi.convert(id);
      await qc.invalidateQueries({ queryKey: ["kinetic-detail", id] });
      toast({
        title:
          type === "convert"
            ? "Converted to lead"
            : type === "contacts"
              ? "Contacts refreshed"
              : "Recheck queued",
      });
    } catch (e: any) {
      toast({
        title: "Action failed",
        description: e.message,
        variant: "destructive",
      });
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 bg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-3xl border border-border bg-card p-4 pb-[max(1rem,calc(env(safe-area-inset-bottom)+0.5rem))] text-foreground shadow-2xl sm:inset-y-0 sm:left-auto sm:w-[520px] sm:rounded-none sm:pb-4">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30 sm:hidden" />
        <button
          onClick={onClose}
          className="float-right h-10 rounded-xl border border-border px-3 text-xs"
        >
          Close
        </button>
        {isLoading ? (
          <Loader2 className="mx-auto mt-20 h-5 w-5 animate-spin text-primary" />
        ) : (
          <>
            <div className="pr-16">
              <div className="text-2xs uppercase tracking-wider text-muted-foreground">
                Kinetic Address ID
              </div>
              <div className="mt-1 break-all font-mono text-sm text-foreground">
                {data?.address?.kineticAddressId ?? "Not returned"}
              </div>
              <h2 className="mt-4 text-xl font-semibold">
                {data?.address?.address ?? "Address unavailable"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {[data?.address?.city, data?.address?.state, data?.address?.zip]
                  .filter(Boolean)
                  .join(", ")}
              </p>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2">
              {[
                ["Sequential ID", data?.address?.sequentialId],
                ["Exchange ID", data?.address?.exchangeId],
                ["Technology", data?.address?.technologyType],
                ["Max qualification", data?.address?.maximumQualification],
              ].map(([l, v]) => (
                <div
                  key={l as string}
                  className="rounded-xl bg-secondary/50 p-3"
                >
                  <div className="text-2xs uppercase text-muted-foreground">
                    {l}
                  </div>
                  <div className="mt-1 font-mono text-xs font-semibold">
                    {v ?? " - "}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                onClick={() => void act("recheck")}
                className="h-11 rounded-xl border border-border text-xs font-bold"
              >
                Queue recheck
              </button>
              <button
                onClick={() => void act("contacts")}
                className="h-11 rounded-xl border border-border text-xs font-bold"
              >
                
                Refresh contacts
              </button>
              <button
                onClick={() => void act("convert")}
                className="col-span-2 h-11 rounded-xl bg-primary text-xs font-bold text-primary-foreground hover:bg-primary/90"
              >
                Convert to lead
              </button>
            </div>
            <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Evidence
            </h3>
            <div className="mt-2 space-y-2">
              {data?.evidence?.map((o: any) => (
                <div
                  key={o.id}
                  className="rounded-xl border border-border bg-secondary/50 p-3"
                >
                  <div className="text-xs">
                    {new Date(o.observedAt).toLocaleString()} ·{" "}
                    <span className="font-mono text-2xs">
                      {o.responseHash.slice(0, 12)}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-2xs text-muted-foreground">
                    <span className="rounded-full bg-secondary px-2 py-1">
                      {String(o.evidenceMode).replaceAll("_", " ")}
                    </span>
                    <span className="rounded-full bg-secondary px-2 py-1">
                      {o.sourceName}
                    </span>
                    <span className="rounded-full bg-secondary px-2 py-1 font-mono">
                      parser {o.parserVersion}
                    </span>
                  </div>
                </div>
              ))}
              {!data?.evidence?.length && (
                <p className="rounded-xl bg-secondary/50 p-3 text-xs text-muted-foreground">
                  No evidence records are available for this address.
                </p>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
