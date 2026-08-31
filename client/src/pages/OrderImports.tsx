// ── Admin: PerfectVision order imports ───────────────────────────────────────
//
// The whole point of this screen is that nothing is assumed. The admin exports
// their own report, uploads it, SEES what the system understood, fixes the
// mapping if it read a column wrong, and only then imports. Two steps, and the
// first one writes nothing.
//
// WHAT IS DELIBERATELY NOT HERE. There is no button that logs into
// PerfectVision. Automated retrieval stays behind a server flag until the
// vendor authorizes it, and the screen says so rather than showing a control
// that would fail.
//
// PII: this page never renders a customer phone number or email address. The
// preview shows whether the column HAS them, which is the only thing a mapping
// check needs.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { apiRequest, apiUpload, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, StatStrip, StatTile } from "@/components/ui/page-scaffold";
import { useToast } from "@/hooks/use-toast";
import {
  IDENTITY_ORDER_FIELDS, MAPPABLE_ORDER_FIELDS, ORDER_FIELD_LABELS, ORDER_STATUS_LABELS,
  type MappableOrderField, type NormalizedOrderStatus, type OrderColumnMapping,
} from "@shared/orderStatusSource";

interface PreviewResponse {
  columns: string[];
  rowCount: number;
  skippedRows: number;
  truncated: boolean;
  checksum: string;
  suggested: Partial<Record<MappableOrderField, string>>;
  mapping: OrderColumnMapping;
  validation: {
    ok: boolean;
    issues: { severity: "error" | "warning"; field: string | null; code: string; message: string }[];
    statusPreview: { sourceStatus: string; normalized: NormalizedOrderStatus; count: number }[];
    sample: Record<string, unknown>[];
  };
  sampleRows: Record<string, unknown>[];
  duplicateOf: number | null;
}

interface ImportRow {
  id: number; source_file_name: string; status: string; total_rows: number;
  valid_rows: number; inserted_rows: number; updated_rows: number; duplicate_rows: number;
  matched_rows: number; unmatched_rows: number; recovery_candidates: number; error_rows: number;
  created_at: string; completed_at: string | null; safe_error_summary: string | null;
  source_file_storage_key: string | null;
}

interface ExceptionRow {
  id: number; importId: number; sourceFileName: string; sourceRowNumber: number;
  externalOrderId: string | null; externalTransactionId: string | null;
  carrier: string | null; program: string | null; productSold: string | null;
  repExternalName: string | null; serviceAddress: string | null;
  status: NormalizedOrderStatus; sourceStatus: string | null;
  matchStatus: string; confidence: number | null; exceptionReason: string | null;
  vendorOrderId: number | null;
}

const IMPORT_STATUS_TONE: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  processing: "bg-sky-500/15 text-info",
  completed: "bg-emerald-500/15 text-success",
  completed_with_errors: "bg-amber-500/15 text-warning",
  failed: "bg-destructive/15 text-destructive",
  canceled: "bg-muted text-muted-foreground",
};

const IMPORT_STATUS_LABEL: Record<string, string> = {
  pending: "Queued",
  validating: "Checking",
  processing: "Importing",
  completed: "Done",
  completed_with_errors: "Done with problems",
  failed: "Failed",
  canceled: "Canceled",
};

export default function OrderImports() {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<OrderColumnMapping | null>(null);

  const meta = useQuery<{
    reportName: string; sourceUrl: string;
    flags: { orderSyncEnabled: boolean; recoveryMessagingEnabled: boolean; scheduledDeliveryConfigured: boolean };
    scheduledDeliveryPath: string;
    encryptionReady: boolean; maxRows: number; maxFileBytes: number;
  }>({ queryKey: ["/api/order-imports/providers"] });

  const connection = useQuery<{
    connection: { mode: string; enabled: boolean; label: string } | null;
    lastTest?: { at: string | null; ok: boolean; message: string | null };
  }>({ queryKey: ["/api/order-imports/connection"] });

  const [readiness, setReadiness] = useState<{ ok: boolean; message: string } | null>(null);

  const setDelivery = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("PUT", "/api/order-imports/connection", {
        label: meta.data?.reportName ?? "PerfectVision report",
        mode: enabled ? "scheduled_export" : "manual_upload",
        enabled,
      });
      return res.json();
    },
    onSuccess: (_data, enabled) => {
      toast({ title: enabled ? "Scheduled delivery turned on" : "Back to manual upload" });
      setReadiness(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/order-imports/connection"] });
    },
    onError: (e: any) => toast({ title: "The connection was not changed", description: e?.message, variant: "destructive" }),
  });

  const checkReadiness = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/order-imports/connection/test", {});
      return (await res.json()) as { ok: boolean; message: string };
    },
    onSuccess: (data) => {
      setReadiness({ ok: data.ok, message: data.message });
      void queryClient.invalidateQueries({ queryKey: ["/api/order-imports/connection"] });
    },
    onError: (e: any) => toast({ title: "The check did not run", description: e?.message, variant: "destructive" }),
  });

  const saved = useQuery<{ mapping: OrderColumnMapping; version: number; savedAt: string | null }>({
    queryKey: ["/api/order-imports/mapping"],
  });

  const imports = useQuery<{ imports: ImportRow[] }>({
    queryKey: ["/api/order-imports"],
    // An import is worked by a background process, so the history has to move
    // on its own. Five seconds is the worker's own poll interval.
    refetchInterval: (q) =>
      (q.state.data?.imports ?? []).some((i) => i.status === "pending" || i.status === "processing") ? 5_000 : false,
  });

  const exceptions = useQuery<{ exceptions: ExceptionRow[] }>({
    queryKey: ["/api/order-imports/exceptions/list"],
  });

  const activeMapping = mapping ?? preview?.mapping ?? saved.data?.mapping ?? null;
  // The screen's promise is "fix the mapping, then import" - but the import
  // runs under the SAVED mapping. On-screen edits that were never saved must
  // gate the button, or the file imports under yesterday's columns.
  const mappingDirty =
    activeMapping != null &&
    saved.data?.mapping != null &&
    JSON.stringify(activeMapping) !== JSON.stringify(saved.data.mapping);

  const previewMutation = useMutation({
    mutationFn: async (chosen: File) => {
      const form = new FormData();
      form.append("file", chosen);
      if (mapping) form.append("mapping", JSON.stringify(mapping));
      const res = await apiUpload("/api/order-imports/preview", form);
      return (await res.json()) as PreviewResponse;
    },
    onSuccess: (data) => {
      setPreview(data);
      setMapping(data.mapping);
    },
    onError: (e: any) => toast({ title: "That file could not be read", description: e?.message, variant: "destructive" }),
  });

  const saveMapping = useMutation({
    mutationFn: async () => {
      if (!activeMapping) throw new Error("Nothing to save");
      const res = await apiRequest("PUT", "/api/order-imports/mapping", {
        mapping: activeMapping,
        sampleRows: preview?.sampleRows ?? [],
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Mapping saved" });
      void queryClient.invalidateQueries({ queryKey: ["/api/order-imports/mapping"] });
    },
    onError: (e: any) => toast({ title: "The mapping was not saved", description: e?.message, variant: "destructive" }),
  });

  const runImport = useMutation({
    mutationFn: async (allowDuplicate: boolean) => {
      if (!file) throw new Error("Choose a file first");
      const form = new FormData();
      form.append("file", file);
      if (allowDuplicate) form.append("allowDuplicate", "true");
      const res = await apiUpload("/api/order-imports", form);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Import queued", description: "It runs in the background. The history below updates itself." });
      setFile(null);
      setPreview(null);
      if (fileInput.current) fileInput.current.value = "";
      void queryClient.invalidateQueries({ queryKey: ["/api/order-imports"] });
    },
    onError: (e: any) => toast({ title: "The import was not started", description: e?.message, variant: "destructive" }),
  });

  const identityBound = useMemo(
    () => IDENTITY_ORDER_FIELDS.some((f) => activeMapping?.columns?.[f]),
    [activeMapping],
  );

  const errors = preview?.validation.issues.filter((i) => i.severity === "error") ?? [];
  const warnings = preview?.validation.issues.filter((i) => i.severity === "warning") ?? [];

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-16 pt-5 md:px-6" data-testid="order-imports-page">
      <PageHeader
        title="PerfectVision order imports"
        subtitle="Import the Total Submitted Orders by Program report and match every order to the sale it came from."
      />

      {meta.data && (
        <Card className="mb-4">
          <CardContent className="space-y-2 pt-5 text-sm">
            <p className="text-muted-foreground">
              Export <span className="font-medium text-foreground">{meta.data.reportName}</span> from the PerfectVision
              portal as CSV or XLSX, then upload it here. Automated retrieval is{" "}
              <span className="font-medium text-foreground">
                {meta.data.flags.orderSyncEnabled ? "enabled on the server" : "turned off"}
              </span>{" "}
              and stays off until PerfectVision authorizes it for this dealer.
            </p>
            {!meta.data.encryptionReady && (
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-warning" data-testid="encryption-warning">
                No encryption key is configured on the server, so uploaded files and original row data are not kept.
                Imports still work. Ask an administrator to set VENDOR_ORDER_ENCRYPTION_KEY to retain them.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Scheduled delivery ───────────────────────────────────────────── */}
      {meta.data && (
        <Card className="mb-4" data-testid="scheduled-delivery-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Scheduled delivery</CardTitle>
            {(() => {
              const conn = connection.data?.connection;
              const live = !!conn && conn.mode === "scheduled_export" && conn.enabled
                && meta.data.flags.orderSyncEnabled && meta.data.flags.scheduledDeliveryConfigured;
              const armed = !!conn && conn.mode === "scheduled_export" && conn.enabled;
              return (
                <Badge className={live ? "bg-emerald-500/15 text-success" : "bg-muted text-muted-foreground"} data-testid="delivery-state">
                  {live ? "Receiving" : armed ? "Waiting on the server" : "Off"}
                </Badge>
              );
            })()}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Instead of exporting the report by hand every day, the portal's own report subscription can email it out
              on a schedule, and a delivery bridge posts the file to{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{meta.data.scheduledDeliveryPath}</code>. Each
              delivery lands in the import history below exactly like a manual upload, under the same saved mapping.
            </p>
            <ul className="space-y-1 text-muted-foreground">
              <li>
                {meta.data.flags.orderSyncEnabled ? "The server sync flag is on." : "The server sync flag is off. It stays off until PerfectVision authorizes automated delivery for this dealer."}
              </li>
              <li>
                {meta.data.flags.scheduledDeliveryConfigured ? "The delivery secret is configured." : "No delivery secret is set. Ask an administrator to set ORDER_REPORT_DELIVERY_SECRET on the server."}
              </li>
              <li>
                {saved.data?.savedAt ? "A column mapping is saved." : "No column mapping is saved yet. Run one import manually first - saving the mapping there teaches deliveries how to read the report."}
              </li>
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              {connection.data?.connection?.mode === "scheduled_export" && connection.data.connection.enabled ? (
                <Button variant="outline" size="sm" data-testid="delivery-off"
                  disabled={setDelivery.isPending} onClick={() => setDelivery.mutate(false)}>
                  Turn off scheduled delivery
                </Button>
              ) : (
                <Button size="sm" data-testid="delivery-on"
                  disabled={setDelivery.isPending} onClick={() => setDelivery.mutate(true)}>
                  Turn on scheduled delivery
                </Button>
              )}
              <Button variant="outline" size="sm" data-testid="delivery-check"
                disabled={checkReadiness.isPending} onClick={() => checkReadiness.mutate()}>
                Check readiness
              </Button>
            </div>
            {readiness && (
              <p className={`rounded-md px-3 py-2 ${readiness.ok ? "bg-emerald-500/10 text-success" : "bg-amber-500/10 text-warning"}`}
                data-testid="delivery-readiness">
                {readiness.message}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Step 1: choose a file and look at it ─────────────────────────── */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">1. Choose the export</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              ref={fileInput}
              type="file"
              aria-label="Choose a PerfectVision order export"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="max-w-sm"
              data-testid="import-file-input"
              onChange={(e) => {
                const chosen = e.target.files?.[0] ?? null;
                setFile(chosen);
                setPreview(null);
                if (chosen) previewMutation.mutate(chosen);
              }}
            />
            {previewMutation.isPending && <span className="text-sm text-muted-foreground">Reading the file...</span>}
          </div>

          {preview && (
            <div className="space-y-3">
              <StatStrip columns={4}>
                <StatTile label="Rows" value={preview.rowCount.toLocaleString()} />
                <StatTile label="Columns" value={String(preview.columns.length)} />
                <StatTile label="Skipped" value={String(preview.skippedRows)} />
                <StatTile label="Mapped fields" value={String(Object.keys(activeMapping?.columns ?? {}).length)} />
              </StatStrip>

              {preview.duplicateOf != null && (
                <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-warning" data-testid="duplicate-warning">
                  This exact file has already been imported (import #{preview.duplicateOf}). Importing it again is
                  harmless but will not change anything.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Step 2: bind the columns ─────────────────────────────────────── */}
      {preview && activeMapping && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">2. Map the columns</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Each field below is bound to a column from your file. Suggestions are a starting point, not a decision:
              nothing imports until you save this mapping.
            </p>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {MAPPABLE_ORDER_FIELDS.map((field) => {
                const isIdentity = (IDENTITY_ORDER_FIELDS as readonly string[]).includes(field);
                return (
                  <div key={field} className="space-y-1">
                    <Label className="text-xs">
                      {ORDER_FIELD_LABELS[field]}
                      {isIdentity && <span className="ml-1 text-muted-foreground">(identity)</span>}
                    </Label>
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      data-testid={`map-${field}`}
                      value={activeMapping.columns[field] ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        setMapping({
                          ...activeMapping,
                          columns: { ...activeMapping.columns, [field]: value || undefined },
                        });
                      }}
                    >
                      <option value="">Not mapped</option>
                      {preview.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs">Report timezone</Label>
                <Input
                  value={activeMapping.timeZone}
                  data-testid="map-timezone"
                  onChange={(e) => setMapping({ ...activeMapping, timeZone: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Carrier when the report has no column</Label>
                <Input
                  value={activeMapping.defaults?.carrier ?? ""}
                  onChange={(e) => setMapping({ ...activeMapping, defaults: { ...activeMapping.defaults, carrier: e.target.value } })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Program when the report has no column</Label>
                <Input
                  value={activeMapping.defaults?.program ?? ""}
                  onChange={(e) => setMapping({ ...activeMapping, defaults: { ...activeMapping.defaults, program: e.target.value } })}
                />
              </div>
            </div>

            {!identityBound && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Map at least one of order ID, transaction ID or account number. Without a stable identity an order
                cannot be matched or updated on a later import.
              </p>
            )}

            {errors.length > 0 && (
              <div className="space-y-1" data-testid="mapping-errors">
                {errors.map((issue, i) => (
                  <p key={i} className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{issue.message}</p>
                ))}
              </div>
            )}
            {warnings.length > 0 && (
              <div className="space-y-1" data-testid="mapping-warnings">
                {warnings.map((issue, i) => (
                  <p key={i} className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-warning">{issue.message}</p>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => file && previewMutation.mutate(file)}
                variant="outline"
                data-testid="revalidate-button"
                disabled={!file || previewMutation.isPending}
              >
                Re-check with this mapping
              </Button>
              <Button
                onClick={() => saveMapping.mutate()}
                data-testid="save-mapping-button"
                disabled={saveMapping.isPending || errors.length > 0}
              >
                Save mapping
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Status coverage ──────────────────────────────────────────────── */}
      {preview && preview.validation.statusPreview.length > 0 && (
        <Card className="mb-4">
          <CardHeader><CardTitle className="text-base">What each status becomes</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr><th className="py-1 pr-4">In your report</th><th className="py-1 pr-4">Read as</th><th className="py-1">Rows</th></tr>
                </thead>
                <tbody>
                  {preview.validation.statusPreview.map((s) => (
                    <tr key={s.sourceStatus} className="border-t border-border/60">
                      <td className="py-1.5 pr-4">{s.sourceStatus}</td>
                      <td className="py-1.5 pr-4">
                        <Badge className={s.normalized === "unknown" ? "bg-amber-500/15 text-warning" : "bg-muted text-muted-foreground"}>
                          {ORDER_STATUS_LABELS[s.normalized]}
                        </Badge>
                      </td>
                      <td className="py-1.5">{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Step 3: import ───────────────────────────────────────────────── */}
      {preview && (
        <Card className="mb-4">
          <CardHeader><CardTitle className="text-base">3. Import</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The import runs in the background. Orders that already exist are updated, orders that cannot be matched
              to a sale go to the review queue below, and nothing is messaged to anybody.
            </p>
            <Button
              onClick={() => runImport.mutate(preview.duplicateOf != null)}
              data-testid="start-import-button"
              loading={runImport.isPending}
              disabled={errors.length > 0 || !saved.data?.version || mappingDirty}
            >
              {preview.duplicateOf != null ? "Import again anyway" : "Start import"}
            </Button>
            {!saved.data?.version && (
              <p className="text-sm text-muted-foreground">Save the mapping first.</p>
            )}
            {mappingDirty && (
              <p className="text-sm text-warning" data-testid="mapping-dirty-note">
                Your mapping edits above are not saved - the import would run under the previously saved
                mapping. Save the mapping in step 2 first.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── History ──────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Import history</CardTitle></CardHeader>
        <CardContent>
          {imports.isLoading && <Skeleton className="h-24 w-full" />}
          {imports.data?.imports.length === 0 && (
            <p className="text-sm text-muted-foreground">No imports yet.</p>
          )}
          <div className="space-y-2">
            {imports.data?.imports.map((row) => (
              <div key={row.id} className="rounded-lg border border-border/60 p-3" data-testid={`import-${row.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{row.source_file_name}</p>
                    <p className="text-xs text-muted-foreground">{new Date(row.created_at).toLocaleString()}</p>
                  </div>
                  <Badge className={IMPORT_STATUS_TONE[row.status] ?? "bg-muted text-muted-foreground"}>
                    {IMPORT_STATUS_LABEL[row.status] ?? row.status}
                  </Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                  <span>Rows: {row.total_rows}</span>
                  <span>New: {row.inserted_rows}</span>
                  <span>Updated: {row.updated_rows}</span>
                  <span>Unchanged: {row.duplicate_rows}</span>
                  <span>Matched: {row.matched_rows}</span>
                  <span>Needs review: {row.unmatched_rows}</span>
                  <span>Recovery cases: {row.recovery_candidates}</span>
                  <span>Problems: {row.error_rows}</span>
                </div>
                {row.safe_error_summary && (
                  <p className="mt-2 text-xs text-warning">{row.safe_error_summary}</p>
                )}
                {row.source_file_storage_key && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    The original file was kept and is downloadable by an administrator. Every download is recorded.
                  </p>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Match exceptions ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle className="text-base">Orders that need a decision</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            These orders could not be matched to a sale with enough confidence to act on. They are visible and counted,
            they do not enter the recovery queue, and nobody is contacted about them until someone here confirms which
            sale they belong to.
          </p>
          {exceptions.isLoading && <Skeleton className="h-24 w-full" />}
          {!exceptions.isLoading && exceptions.isError && (
            <div role="alert" className="flex items-center justify-between gap-3 py-2">
              <p className="text-sm text-muted-foreground">Couldn't load unmatched orders - they may still need a decision.</p>
              <Button variant="outline" size="sm" onClick={() => exceptions.refetch()}>Retry</Button>
            </div>
          )}
          {!exceptions.isLoading && !exceptions.isError && exceptions.data?.exceptions.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing waiting.</p>
          )}
          <div className="space-y-2">
            {exceptions.data?.exceptions.map((row) => (
              <ExceptionCard key={row.id} row={row} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ExceptionCard({ row }: { row: ExceptionRow }) {
  const { toast } = useToast();
  const [saleId, setSaleId] = useState("");
  // "Not ours" closes the order for good - arm it so one ghost-button tap
  // can't silently drop a real order (and its commission) from the queue.
  const [confirmIgnore, setConfirmIgnore] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/order-imports/exceptions/list"] });
  };

  const rematch = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/order-imports/exceptions/${row.id}/rematch`)).json(),
    onSuccess: () => { toast({ title: "Re-checked" }); invalidate(); },
    onError: (e: any) => toast({ title: "Could not re-check", description: e?.message, variant: "destructive" }),
  });

  const resolve = useMutation({
    mutationFn: async (payload: { decision: string; saleId?: number }) =>
      (await apiRequest("POST", `/api/order-imports/exceptions/${row.id}/resolve`, payload)).json(),
    onSuccess: (_d, vars) => { toast({ title: vars.decision === "ignore" ? "Order dropped - it will not be recovered" : "Saved" }); invalidate(); },
    onError: (e: any) => toast({ title: "Not saved", description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="rounded-lg border border-border/60 p-3" data-testid={`exception-${row.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {row.externalOrderId ?? row.externalTransactionId ?? `Row ${row.sourceRowNumber}`}
          </p>
          <p className="text-xs text-muted-foreground">{row.serviceAddress ?? "No address on the row"}</p>
          <p className="text-xs text-muted-foreground">
            {[row.carrier, row.productSold, row.program].filter(Boolean).join(" / ") || "No product details"}
            {row.repExternalName ? ` - ${row.repExternalName}` : ""}
          </p>
        </div>
        <Badge className="bg-amber-500/15 text-warning">{ORDER_STATUS_LABELS[row.status]}</Badge>
      </div>
      {row.exceptionReason && <p className="mt-2 text-xs text-warning">{row.exceptionReason}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          aria-label="Sale ID to link this order"
          className="h-11 w-32 md:h-8"
          placeholder="Sale ID"
          value={saleId}
          data-testid={`exception-sale-${row.id}`}
          onChange={(e) => setSaleId(e.target.value.replace(/\D/g, ""))}
        />
        <Button
          size="sm"
          className="min-h-11 md:min-h-9"
          data-testid={`exception-link-${row.id}`}
          disabled={!saleId || resolve.isPending}
          onClick={() => resolve.mutate({ decision: "link", saleId: Number(saleId) })}
        >
          Link to this sale
        </Button>
        <Button size="sm" variant="outline" className="min-h-11 md:min-h-9" disabled={rematch.isPending} onClick={() => rematch.mutate()}>
          Re-check
        </Button>
        {confirmIgnore ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              className="min-h-11 md:min-h-9"
              disabled={resolve.isPending}
              data-testid="confirm-not-ours"
              onClick={() => resolve.mutate({ decision: "ignore" })}
            >
              Drop this order
            </Button>
            <Button size="sm" variant="ghost" className="min-h-11 md:min-h-9" onClick={() => setConfirmIgnore(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 md:min-h-9"
            disabled={resolve.isPending}
            data-testid="not-ours"
            onClick={() => setConfirmIgnore(true)}
          >
            Not ours
          </Button>
        )}
      </div>
    </div>
  );
}
