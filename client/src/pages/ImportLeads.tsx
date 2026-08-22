// ── Import leads — a spreadsheet onto the map ────────────────────────────────
// Three steps on one page, in the order a manager thinks: choose the file,
// check the column matching the server guessed, read what will happen and
// import. Every number on screen comes from the server's preview of THIS
// file under THIS mapping (POST /api/leads/import/preview); nothing is
// estimated client-side. Phone columns are locked to "Not imported": the app
// only takes phone data through the licensed Calling workspace, and the page
// says so beside the column rather than silently dropping it.
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, apiUpload, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, StatStrip, StatTile } from "@/components/ui/page-scaffold";
import { useToast } from "@/hooks/use-toast";
import { FOCUS } from "@/lib/a11y";
import { LEAD_IMPORT_TARGETS, isPhoneHeader, isEmailHeader, type LeadImportMapping, type LeadImportTarget } from "@shared/leadImport";

interface Preview {
  fileName: string;
  columns: string[];
  rowCount: number;
  truncated: boolean;
  maxRows: number;
  mapping: LeadImportMapping;
  validation: { ok: boolean; issues: Array<{ column: number | null; message: string }> };
  sampleRows: string[][];
  summary: null | {
    rows: number; ready: number; missingAddress: number; missingCity: number; duplicatesInFile: number; alreadyOnMap: number;
    unknownReps: string[]; repMatched: number; countyMatched: number; addressNotFound: number;
  };
  needsFix: Array<{ rowNumber: number; status: string; address: string; city: string; state: string; zip: string; repName: string | null }>;
}
interface ImportResult {
  created: number; existing: number; geocoded: number; ungeocoded: number; assigned: number;
  skipped: { missingAddress: number; missingCity: number; duplicatesInFile: number; alreadyOnMap: number };
  unknownReps: string[];
}
type AssignMode = "pool" | "file" | "rep";

const fmt = (n: number) => n.toLocaleString("en-US");
const STATUS_WORDS: Record<string, string> = {
  missing_address: "No street address",
  missing_city: "No city",
  duplicate_in_file: "Same door twice in the file",
  already_on_map: "Already on the map",
};

export default function ImportLeads() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<LeadImportMapping | null>(null);
  const [assignMode, setAssignMode] = useState<AssignMode>("file");
  const [oneRep, setOneRep] = useState<string>("");
  const [result, setResult] = useState<ImportResult | null>(null);

  const { data: team = [] } = useQuery<Array<{ id: number; name: string; active: boolean }>>({
    queryKey: ["/api/team"],
    queryFn: () => apiRequest("GET", "/api/team").then((r) => r.json()),
    staleTime: 60_000,
  });
  const reps = useMemo(() => team.filter((m) => m.active), [team]);

  const previewMutation = useMutation({
    mutationFn: async ({ chosen, map }: { chosen: File; map: LeadImportMapping | null }) => {
      const form = new FormData();
      form.append("file", chosen);
      if (map) form.append("mapping", JSON.stringify(map));
      const res = await apiUpload("/api/leads/import/preview", form);
      return (await res.json()) as Preview;
    },
    onSuccess: (data) => { setPreview(data); setMapping(data.mapping); setResult(null); },
    onError: (e: any) => toast({ title: "That file could not be read", description: e?.message, variant: "destructive" }),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file || !mapping) throw new Error("Choose a file first");
      const form = new FormData();
      form.append("file", file);
      form.append("mapping", JSON.stringify(mapping));
      form.append("assign", assignMode === "rep" ? `rep:${oneRep}` : assignMode);
      const res = await apiUpload("/api/leads/import", form);
      return (await res.json()) as ImportResult;
    },
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leads/map"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: `${fmt(data.created)} leads imported`, severity: "success" });
    },
    onError: (e: any) => toast({ title: "The import did not run", description: e?.message, variant: "destructive" }),
  });

  const choose = (chosen: File | null) => {
    setFile(chosen); setPreview(null); setMapping(null); setResult(null);
    if (chosen) previewMutation.mutate({ chosen, map: null });
  };
  const remap = (column: number, target: LeadImportTarget) => {
    if (!file || !mapping) return;
    const next = { ...mapping, [String(column)]: target };
    setMapping(next);
    previewMutation.mutate({ chosen: file, map: next });
  };

  const summary = preview?.summary ?? null;
  const issueFor = (i: number) => preview?.validation.issues.find((x) => x.column === i)?.message ?? null;
  const canImport = !!preview && preview.validation.ok && !!summary && summary.ready > 0 && !preview.truncated
    && (assignMode !== "rep" || oneRep !== "") && !importMutation.isPending && !previewMutation.isPending;

  // The rows that will not import, as a file the manager can fix and re-send.
  const needsFixHref = useMemo(() => {
    if (!preview?.needsFix.length) return null;
    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["Row,Why,Address,City,State,Zip,Rep", ...preview.needsFix.map((r) =>
      [r.rowNumber, STATUS_WORDS[r.status] ?? r.status, r.address, r.city, r.state, r.zip, r.repName ?? ""].map((v) => esc(String(v))).join(","))];
    return `data:text/csv;charset=utf-8,${encodeURIComponent(lines.join("\n"))}`;
  }, [preview]);

  return (
    <div className="min-h-full bg-background p-4 sm:p-6 lg:p-7 space-y-4 max-w-5xl">
      <PageHeader
        title="Import leads"
        subtitle="Bring a spreadsheet from another tool onto the map. Each row becomes a door; addresses in the county file get their pin straight away."
      />

      {/* ── 1. Choose the file ─────────────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-5">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            aria-label="Choose a CSV or XLSX file"
            data-testid="import-file-input"
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-foreground">
              1. Choose the file
              {preview && <span className="font-medium text-muted-foreground"> · {preview.fileName}</span>}
            </div>
            <div className="mt-0.5 text-[12px] text-muted-foreground tabular-nums" data-testid="import-file-facts">
              {preview
                ? `${fmt(preview.rowCount)} rows · ${preview.columns.length} columns${file ? ` · ${Math.max(1, Math.round(file.size / 1024))} KB` : ""}`
                : previewMutation.isPending ? "Reading the file..." : "CSV or XLSX, first row as headers, up to 5,000 rows per import."}
            </div>
            {preview?.truncated && (
              <p className="mt-1 text-[12px] font-medium text-warning" data-testid="import-truncated">
                This file has {fmt(preview.rowCount)} rows. At most {fmt(preview.maxRows)} import at a time: split it and import the halves.
              </p>
            )}
          </div>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => fileInput.current?.click()} data-testid="import-choose">
            {preview ? "Change file" : "Choose file"}
          </Button>
        </CardContent>
      </Card>

      {/* ── 2. Match the columns ───────────────────────────────────────── */}
      {preview && mapping && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[14px] font-semibold">
              2. Match the columns
              <span className="ml-3 text-[12px] font-normal text-muted-foreground">Matched by header name. Change any that landed wrong.</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto px-2 pb-2">
            <table className="w-full border-collapse" data-testid="import-mapping">
              <thead>
                <tr>
                  {["Column in your file", "First row", "Becomes", ""].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.columns.map((col, i) => {
                  const phone = isPhoneHeader(col);
                  const email = isEmailHeader(col);
                  const target = mapping[String(i)] ?? "ignore";
                  const issue = issueFor(i);
                  return (
                    <tr key={i} className="border-t border-border" data-testid={`import-col-${i}`}>
                      <td className="px-3 py-2 text-[13px] font-semibold text-foreground">{col || <span className="text-muted-foreground">(blank header)</span>}</td>
                      <td className="px-3 py-2 text-[13px] tabular-nums text-muted-foreground">{preview.sampleRows[0]?.[i] ?? ""}</td>
                      <td className="px-3 py-1.5">
                        <select
                          value={phone ? "ignore" : target}
                          disabled={phone}
                          aria-label={`Field for ${col}`}
                          data-testid={`import-target-${i}`}
                          onChange={(e) => remap(i, e.target.value as LeadImportTarget)}
                          className={`h-11 md:h-9 min-w-[168px] rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground disabled:opacity-60 ${FOCUS}`}
                        >
                          {LEAD_IMPORT_TARGETS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-[12px]">
                        {phone ? (
                          <span className="text-muted-foreground">Phones come in through Calling only</span>
                        ) : issue ? (
                          <span className="font-semibold text-warning">{issue}</span>
                        ) : target === "ignore" ? (
                          <span className="text-muted-foreground">{email ? "Not imported" : "Skipped"}</span>
                        ) : (
                          <span className="font-semibold text-success">Matched</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {preview.validation.issues.some((x) => x.column == null) && (
              <ul className="mx-3 mt-2 space-y-1" data-testid="import-mapping-issues">
                {preview.validation.issues.filter((x) => x.column == null).map((x, i) => (
                  <li key={i} className="text-[12px] font-semibold text-warning">{x.message}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── 3. Review and import ───────────────────────────────────────── */}
      {preview && summary && preview.validation.ok && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-[14px] font-semibold">3. Review and import</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <StatStrip columns={4}>
              <StatTile label="Will be imported" value={fmt(summary.ready)} accent testId="import-ready" />
              <StatTile label="Pin from the county file" value={fmt(summary.countyMatched)} testId="import-county" />
              <StatTile label="No pin yet" value={fmt(summary.addressNotFound)} testId="import-nopin" />
              <StatTile label="Will be skipped" value={fmt(summary.rows - summary.ready)} testId="import-skipped" />
            </StatStrip>
            <p className="text-[12px] text-muted-foreground">
              Skipped: {fmt(summary.alreadyOnMap)} already on the map, {fmt(summary.duplicatesInFile)} repeated in the file,
              {" "}{fmt(summary.missingAddress + summary.missingCity)} without an address or city.
              {summary.addressNotFound > 0 && " Doors with no pin still import and show in Leads; they get a pin once their address is found."}
            </p>

            <div className="flex flex-wrap items-center gap-3" data-testid="import-assign">
              <span className="text-[13px] font-semibold text-foreground">New doors go to</span>
              <div role="radiogroup" aria-label="New doors go to" className="inline-flex items-center gap-0.5 rounded-full bg-secondary p-[3px]">
                {([["pool", "Unassigned pool"], ["file", "The rep in the file"], ["rep", "One rep"]] as Array<[AssignMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={assignMode === mode}
                    data-testid={`import-assign-${mode}`}
                    onClick={() => setAssignMode(mode)}
                    className={`h-11 md:h-9 rounded-full px-3.5 text-[13px] font-semibold transition ${FOCUS} ${assignMode === mode ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {assignMode === "rep" && (
                <select
                  value={oneRep}
                  onChange={(e) => setOneRep(e.target.value)}
                  aria-label="Rep"
                  data-testid="import-one-rep"
                  className={`h-11 md:h-9 min-w-[180px] rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground ${FOCUS}`}
                >
                  <option value="">Pick a rep</option>
                  {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              )}
              {assignMode === "file" && (
                <span className="text-[12px] text-muted-foreground" data-testid="import-file-reps">
                  {fmt(summary.repMatched)} of {fmt(summary.ready)} rows name a rep you manage.
                  {summary.unknownReps.length > 0 && ` Unknown names fall back to the pool: ${summary.unknownReps.slice(0, 4).join(", ")}${summary.unknownReps.length > 4 ? ` and ${summary.unknownReps.length - 4} more` : ""}.`}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button
                disabled={!canImport}
                onClick={() => importMutation.mutate()}
                data-testid="import-run"
                className="h-11 md:h-10 px-5 text-[14px] font-semibold tabular-nums"
              >
                {importMutation.isPending ? "Importing..." : `Import ${fmt(summary.ready)} leads`}
              </Button>
              {needsFixHref && (
                <a
                  href={needsFixHref}
                  download="rows-to-fix.csv"
                  data-testid="import-needs-fix"
                  className={`inline-flex h-11 md:h-10 items-center rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground hover:bg-secondary/60 ${FOCUS}`}
                >
                  Download the {fmt(preview.needsFix.length)} rows to fix
                </a>
              )}
              <span className="text-[12px] text-muted-foreground">Importing the same file twice adds nothing: a door already on the map is skipped.</span>
            </div>

            {result && (
              <div className="rounded-xl border border-success/30 bg-success/[0.06] px-4 py-3 text-[13px] text-foreground" role="status" data-testid="import-result">
                <span className="font-semibold tabular-nums">{fmt(result.created)} leads imported</span>
                {" · "}{fmt(result.geocoded)} with a pin{result.ungeocoded > 0 ? ` · ${fmt(result.ungeocoded)} waiting for an address match` : ""}
                {" · "}{fmt(result.assigned)} assigned{result.existing > 0 ? ` · ${fmt(result.existing)} were already on the map` : ""}.
                <span className="ml-3 inline-flex gap-2">
                  <button type="button" onClick={() => navigate("/map")} className={`font-semibold text-primary ${FOCUS}`}>Open the map</button>
                  <button type="button" onClick={() => navigate("/leads")} className={`font-semibold text-primary ${FOCUS}`}>Open Leads</button>
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
