import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, Check, FileCheck2, Gauge, LockKeyhole, RefreshCw, ShieldCheck, Upload, UserCheck, UserRoundX, WalletCards, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CallingAvailability, CallingChrome, CallingPageSkeleton, CallingUnknownState } from "@/components/calling/CallingChrome";
import {
  formatDecision, getCallingAudit, getCallingComplianceStatus, getProviderMetrics, getRepresentativeCallingHolds,
  importSignedDncDataset, placeRepresentativeCallingHold, releaseRepresentativeCallingHold, updateCallingProfile,
  type CallingProfile, type DncImportProgress, type SignedDncImportManifest,
} from "@/lib/callingApi";
import { useCan } from "@/lib/capabilities";
import { useToast } from "@/hooks/use-toast";

function dateLabel(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function Gate({ label, ready, detail }: { label: string; ready: boolean; detail: string }) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${ready ? "bg-emerald-500/12 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
        {ready ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1"><div className="text-xs font-semibold">{label}</div><div className="truncate text-[11px] text-muted-foreground">{detail}</div></div>
    </div>
  );
}

type EditableProfile = Omit<CallingProfile, "tenantId" | "policyVersion">;

function editableProfile(profile: CallingProfile): EditableProfile {
  return {
    callingEnabled: profile.callingEnabled, emergencyDisabled: profile.emergencyDisabled,
    counselApproved: profile.counselApproved, sellerAuthorized: profile.sellerAuthorized,
    sellerName: profile.sellerName, sellerAuthorizationRef: profile.sellerAuthorizationRef,
    stateRulesApproved: profile.stateRulesApproved, defaultTimeZone: profile.defaultTimeZone,
    allowedStartLocal: profile.allowedStartLocal, allowedEndLocal: profile.allowedEndLocal,
    minimumIdentityConfidence: profile.minimumIdentityConfidence, maxAttempts7Days: profile.maxAttempts7Days,
    maxAttempts30Days: profile.maxAttempts30Days, dncMaxAgeDays: profile.dncMaxAgeDays,
    propagateOptOutPlatformWide: profile.propagateOptOutPlatformWide,
    callerIdAuthorized: profile.callerIdAuthorized, callerIdReference: profile.callerIdReference,
  };
}

function ProfileEditor({ profile }: { profile: CallingProfile }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState<EditableProfile>(() => editableProfile(profile));
  useEffect(() => setValue(editableProfile(profile)), [profile]);
  const mutation = useMutation({ mutationFn: (next: EditableProfile) => updateCallingProfile(next), onSuccess: () => { void queryClient.invalidateQueries({ predicate: query => String(query.queryKey[0] ?? "").startsWith("/api/v1/calling") }); toast({ title: "Calling policy saved", description: "New authorizations now use the updated policy version." }); }, onError: (error: Error) => toast({ title: "Policy not saved", description: error.message, variant: "destructive" }) });
  const valid = Boolean(value.sellerName?.trim() && value.sellerAuthorizationRef?.trim() && value.callerIdReference?.trim()
    && value.allowedStartLocal >= "08:00" && value.allowedEndLocal <= "21:00" && value.allowedStartLocal < value.allowedEndLocal
    && value.minimumIdentityConfidence >= 0.5 && value.minimumIdentityConfidence <= 1
    && value.maxAttempts7Days > 0 && value.maxAttempts30Days >= value.maxAttempts7Days && value.dncMaxAgeDays >= 1 && value.dncMaxAgeDays <= 31);
  const checkbox = (key: keyof Pick<EditableProfile, "callingEnabled" | "emergencyDisabled" | "counselApproved" | "sellerAuthorized" | "stateRulesApproved" | "callerIdAuthorized" | "propagateOptOutPlatformWide">, label: string, help: string) => (
    <label className="flex min-h-14 cursor-pointer items-start gap-3 border-b border-border px-4 py-3 last:border-b-0"><input type="checkbox" checked={Boolean(value[key])} onChange={event => setValue(current => ({ ...current, [key]: event.target.checked }))} className="mt-0.5 h-5 w-5 accent-[hsl(var(--primary))]" /><span><span className="block text-xs font-semibold">{label}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{help}</span></span></label>
  );

  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border p-4"><div><div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Organization policy</div><h2 className="mt-0.5 text-base font-semibold">Authorization controls</h2></div><span className="rounded-full bg-secondary px-2.5 py-1 text-2xs font-semibold text-muted-foreground">v{profile.policyVersion}</span></div>
      <div>{checkbox("emergencyDisabled", "Keep organization emergency disable active", "Checked blocks every new authorization. Uncheck only after reviewing all controls; the environment kill switch can still block calling.")}{checkbox("callingEnabled", "Calling pilot enabled", "Still requires environment flags, emergency switch, DNC data, scripts, registration, and per-rep authorization.")}{checkbox("counselApproved", "Counsel configuration approved", "Administrative attestation only; retain counsel advice outside the application.")}{checkbox("stateRulesApproved", "State rules approved", "Each called state still needs an active registration or approved exemption record.")}{checkbox("sellerAuthorized", "Seller is authorized", "The organization has documented authority to place these calls for the named seller.")}{checkbox("callerIdAuthorized", "Caller ID authorized", "The caller ID reference is documented and permitted for this seller.")}{checkbox("propagateOptOutPlatformWide", "Platform-wide opt-out propagation", "If counsel and business policy require it, every new organization opt-out also enters the immutable platform suppression list. This cannot be reversed by sales users.")}</div>
      <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-2">
        <label className="text-xs font-semibold">Seller name<input value={value.sellerName ?? ""} onChange={event => setValue(current => ({ ...current, sellerName: event.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <label className="text-xs font-semibold">Seller authorization reference<input value={value.sellerAuthorizationRef ?? ""} onChange={event => setValue(current => ({ ...current, sellerAuthorizationRef: event.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <label className="text-xs font-semibold">Caller ID authorization reference<input value={value.callerIdReference ?? ""} onChange={event => setValue(current => ({ ...current, callerIdReference: event.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <label className="text-xs font-semibold">Default time zone<input value={value.defaultTimeZone} onChange={event => setValue(current => ({ ...current, defaultTimeZone: event.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <label className="text-xs font-semibold">Earliest local call<input type="time" value={value.allowedStartLocal} onChange={event => setValue(current => ({ ...current, allowedStartLocal: event.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <label className="text-xs font-semibold">Latest local call<input type="time" value={value.allowedEndLocal} onChange={event => setValue(current => ({ ...current, allowedEndLocal: event.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <label className="text-xs font-semibold">Minimum identity confidence<input type="number" min="0.5" max="1" step="0.01" value={value.minimumIdentityConfidence} onChange={event => setValue(current => ({ ...current, minimumIdentityConfidence: Number(event.target.value) }))} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <label className="text-xs font-semibold">DNC maximum age (days)<input type="number" min="1" max="31" value={value.dncMaxAgeDays} onChange={event => setValue(current => ({ ...current, dncMaxAgeDays: Number(event.target.value) }))} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <label className="text-xs font-semibold">Max attempts / 7 days<input type="number" min="1" max="20" value={value.maxAttempts7Days} onChange={event => setValue(current => ({ ...current, maxAttempts7Days: Number(event.target.value) }))} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <label className="text-xs font-semibold">Max attempts / 30 days<input type="number" min="1" max="50" value={value.maxAttempts30Days} onChange={event => setValue(current => ({ ...current, maxAttempts30Days: Number(event.target.value) }))} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
      </div>
      <div className="border-t border-border p-4"><Button className="w-full" disabled={!valid || mutation.isPending} onClick={() => mutation.mutate(value)}>{mutation.isPending ? "Saving policy…" : "Save new policy version"}</Button></div>
    </section>
  );
}

function DncImport() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [manifestFile, setManifestFile] = useState<File | null>(null);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<DncImportProgress | null>(null);
  const mutation = useMutation({ mutationFn: async () => {
    if (!manifestFile || !datasetFile) throw new Error("Select both the signed manifest and its phone-number export");
    if (manifestFile.size > 1_000_000) throw new Error("Signed manifest exceeds the 1 MB safety limit");
    if (datasetFile.size > 100_000_000) throw new Error("Browser imports are limited to 100 MB; use the resumable admin API for larger licensed datasets");
    let manifest: SignedDncImportManifest;
    try { manifest = JSON.parse(await manifestFile.text()) as SignedDncImportManifest; }
    catch { throw new Error("Signed manifest is not valid JSON"); }
    const requiredText = [manifest.versionLabel, manifest.authorizedAccountRef, manifest.sourceManifestSha256,
      manifest.sourceAsOf, manifest.sourceRetrievedAt, manifest.manifestSignature];
    if (!["national", "state"].includes(manifest.sourceType) || requiredText.some(value => typeof value !== "string" || !value)
        || !Array.isArray(manifest.coveredAreaCodes) || !manifest.coveredAreaCodes.includes("ALL")
        || !Number.isInteger(manifest.expectedRecordCount) || manifest.expectedRecordCount < 1
        || !Number.isInteger(manifest.expectedChunkCount) || manifest.expectedChunkCount < 1
        || !Number.isInteger(manifest.chunkSize) || manifest.chunkSize < 1 || manifest.chunkSize > 3_000) {
      throw new Error("Signed manifest is incomplete or uses an unsupported format");
    }
    const phoneLines = (await datasetFile.text()).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    return importSignedDncDataset(manifest, phoneLines, setProgress);
  },
    onSuccess: result => { void queryClient.invalidateQueries({ predicate: query => String(query.queryKey[0] ?? "").startsWith("/api/v1/calling") }); setDatasetFile(null); setManifestFile(null); toast({ title: "Signed DNC dataset activated", description: `${result.recordCount.toLocaleString()} unique suppressions verified, hashed, and activated.` }); },
    onError: (error: Error) => toast({ title: "DNC import failed", description: error.message, variant: "destructive" }) });
  const valid = Boolean(manifestFile && datasetFile);
  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="border-b border-border p-4"><div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Authorized data only</div><h2 className="mt-0.5 text-base font-semibold">Signed resumable DNC import</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">The offline registry exporter must sign the tenant, licensed account, complete coverage, source age, counts, and chunk checksums. Raw numbers are never retained by this application.</p></div>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <label className="text-xs font-semibold">Signed manifest (.json)<input type="file" accept="application/json,.json" onChange={event => setManifestFile(event.target.files?.[0] ?? null)} className="mt-1 block min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2 font-normal file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5" /><span className="mt-1 block truncate text-[11px] font-normal text-muted-foreground">{manifestFile?.name ?? "No manifest selected"}</span></label>
        <label className="text-xs font-semibold">Licensed export (.txt, one number/line)<input type="file" accept="text/plain,.txt" onChange={event => setDatasetFile(event.target.files?.[0] ?? null)} className="mt-1 block min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2 font-normal file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5" /><span className="mt-1 block truncate text-[11px] font-normal text-muted-foreground">{datasetFile?.name ?? "No export selected"}</span></label>
        {progress && <div className="sm:col-span-2 rounded-xl bg-secondary/70 p-3 text-xs"><div className="flex items-center justify-between gap-3"><span className="font-semibold capitalize">{progress.phase}</span><span className="font-mono tabular-nums">{progress.uploadedChunks}/{progress.totalChunks} chunks</span></div><div className="mt-1 text-[11px] text-muted-foreground">{progress.stagedUnique.toLocaleString()} unique hashes staged</div></div>}
      </div>
      <div className="border-t border-border p-4"><Button className="w-full" disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}><Upload className="h-4 w-4" />{mutation.isPending ? "Verifying signed chunks…" : "Verify and import signed dataset"}</Button></div>
    </section>
  );
}

function RepresentativeHoldControls() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const query = useQuery({ queryKey: ["/api/v1/calling/compliance/representative-holds"],
    queryFn: getRepresentativeCallingHolds, staleTime: 5_000, retry: 1 });
  const mutation = useMutation({ mutationFn: async (input: { userId: number; release: boolean; reason: string }) => input.release
    ? releaseRepresentativeCallingHold(input.userId, input.reason)
    : placeRepresentativeCallingHold(input.userId, input.reason),
    onSuccess: (_result, input) => {
      setReasons(current => ({ ...current, [input.userId]: "" }));
      void query.refetch();
      void queryClient.invalidateQueries({ predicate: item => String(item.queryKey[0] ?? "").startsWith("/api/v1/calling") });
      toast({ title: input.release ? "Representative hold released" : "Representative calling stopped",
        description: input.release
          ? "The representative must pass a fresh compliance evaluation before another call."
          : "Unused authorizations were invalidated and open attempts were ended immediately." });
    },
    onError: (error: Error) => toast({ title: "Representative hold was not changed", description: error.message, variant: "destructive" }),
  });
  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex items-start gap-3 border-b border-border p-4"><UserRoundX className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" /><div><h2 className="text-sm font-semibold">Representative emergency holds</h2><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">A hold invalidates that representative's unused authorizations, ends every open attempt, and blocks evaluation, reveal, start, and copy actions.</p></div></div>
      {query.isLoading ? <div className="p-4"><div className="app-skeleton h-24 rounded-xl" /></div>
        : query.isError ? <div className="p-4 text-xs text-red-400">Representative hold state is unavailable. No representative is assumed clear from this screen.</div>
          : query.data?.representatives.length ? <div className="divide-y divide-border">{query.data.representatives.map(representative => {
            const reason = reasons[representative.id] ?? "";
            const reasonValid = reason.trim().length >= 3;
            return <div key={representative.id} className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-xs font-semibold">{representative.name}</div><div className="truncate text-[11px] text-muted-foreground">{representative.email} · {formatDecision(representative.role)}</div></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-2xs font-semibold ${representative.hold ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400"}`}>{representative.hold ? "On hold" : "Clear"}</span></div>{representative.hold && <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-[11px]"><div className="font-semibold text-red-400">{representative.hold.reason}</div><div className="mt-1 text-muted-foreground">Placed {dateLabel(representative.hold.placedAt)}</div></div>}<label className="mt-3 block text-xs font-semibold">{representative.hold ? "Release reason" : "Hold reason"}<textarea value={reason} onChange={event => setReasons(current => ({ ...current, [representative.id]: event.target.value }))} maxLength={1000} rows={2} placeholder={representative.hold ? "Document why this representative may resume" : "Document the operational or compliance reason"} className="mt-1 w-full rounded-xl border border-border bg-background p-3 font-normal" /></label>{representative.hold ? <Button variant="outline" className="mt-2 min-h-11 w-full" disabled={!reasonValid || mutation.isPending} onClick={() => mutation.mutate({ userId: representative.id, release: true, reason })}><UserCheck className="h-4 w-4" />Release hold</Button> : <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" className="mt-2 min-h-11 w-full" disabled={!representative.active || !reasonValid || mutation.isPending}>Place emergency hold</Button></AlertDialogTrigger><AlertDialogContent className="max-w-[calc(100vw-2rem)] rounded-2xl"><AlertDialogHeader><AlertDialogTitle>Stop calling for {representative.name}?</AlertDialogTitle><AlertDialogDescription>This immediately invalidates unused authorizations and terminates open manual attempts for this representative. It does not disable the entire organization.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={() => mutation.mutate({ userId: representative.id, release: false, reason })}>Place hold now</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}</div>;
          })}</div> : <div className="p-4 text-xs text-muted-foreground">No active users with manual Calling permission are in this organization.</div>}
    </section>
  );
}

export default function CallingCompliance() {
  const canManage = useCan("calling.policy.manage");
  const canAudit = useCan("audit.read.org") || canManage;
  const canDnc = useCan("calling.dnc.manage");
  const canProviders = useCan("calling.providers.manage");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ["/api/v1/calling/compliance/summary"], queryFn: getCallingComplianceStatus, staleTime: 10_000, retry: 1 });
  const metricsQuery = useQuery({ queryKey: ["/api/v1/calling/compliance/provider-usage"], queryFn: getProviderMetrics, enabled: canProviders, staleTime: 60_000, retry: 1 });
  const auditQuery = useQuery({ queryKey: ["/api/v1/calling/compliance/audit"], queryFn: getCallingAudit, enabled: canAudit, staleTime: 10_000, retry: 1 });
  const disableMutation = useMutation({ mutationFn: () => updateCallingProfile({ ...editableProfile(statusQuery.data!.profile), emergencyDisabled: true }),
    onSuccess: () => { void queryClient.invalidateQueries({ predicate: query => String(query.queryKey[0] ?? "").startsWith("/api/v1/calling") }); toast({ title: "Emergency disable activated", description: "New authorizations are blocked and the server re-checks this before every attempt." }); },
    onError: (error: Error) => toast({ title: "Emergency disable failed", description: error.message, variant: "destructive" }) });

  return (
    <CallingChrome>
      <div className="flex-1 space-y-4 px-4 pb-24 pt-4 md:px-6 md:pb-8">
        {statusQuery.isLoading ? <CallingPageSkeleton /> : statusQuery.isError || !statusQuery.data ? <CallingUnknownState retry={() => void statusQuery.refetch()} /> : <>
          <CallingAvailability status={statusQuery.data} />
          <section className="rounded-2xl border border-red-500/25 bg-red-500/[0.05] p-4"><div className="flex items-start gap-3"><AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-red-400" /><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold text-red-400">Emergency stop</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Immediately blocks new calling authorizations for this organization. Environment emergency disable remains the higher-level kill switch.</p></div></div>{canManage && !statusQuery.data.profile.emergencyDisabled && <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" className="mt-3 w-full">Activate emergency disable</Button></AlertDialogTrigger><AlertDialogContent className="max-w-[calc(100vw-2rem)] rounded-2xl"><AlertDialogHeader><AlertDialogTitle>Disable calling now?</AlertDialogTitle><AlertDialogDescription>This blocks all new call authorizations for the organization. Re-enabling requires reviewing and saving the organization policy.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => disableMutation.mutate()} className="bg-red-600 text-white">Disable calling</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}{statusQuery.data.profile.emergencyDisabled && <div className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-400">Organization emergency disable is active</div>}</section>

          <section className="overflow-hidden rounded-2xl border border-border bg-card"><div className="border-b border-border p-4"><div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Fail-closed readiness</div><h2 className="mt-0.5 text-base font-semibold">Authoritative gates</h2></div><div className="divide-y divide-border">
            <Gate label="Environment module" ready={statusQuery.data.environment.moduleEnabled} detail="CALLING_MODULE_ENABLED and tenant pilot allowlist" />
            <Gate label="Emergency control" ready={!statusQuery.data.environment.emergencyDisabled && !statusQuery.data.profile.emergencyDisabled} detail="Environment and organization kill switches are clear" />
            <Gate label="Encryption and signing secrets" ready={statusQuery.data.environment.secretsReady} detail="Encrypted phones and one-use authorization signatures" />
            <Gate label="National DNC" ready={Boolean(statusQuery.data.dnc.national?.fresh)} detail={statusQuery.data.dnc.national ? `Expires ${dateLabel(statusQuery.data.dnc.national.expiresAt)}` : "No fresh authorized dataset"} />
            <Gate label="Approved script" ready={Boolean(statusQuery.data.activeScript)} detail={statusQuery.data.activeScript ? `Version ${statusQuery.data.activeScript.version}` : "No active counsel-approved script"} />
            <Gate label="Rules version" ready={Boolean(statusQuery.data.activeRuleVersion)} detail={statusQuery.data.activeRuleVersion?.version ?? "No active approved rules"} />
            <Gate label="Manual human action" ready={statusQuery.data.environment.manualClickRequired} detail="One lead, one user, one-use authorization; no auto-dial" />
          </div></section>

          <section className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3"><div className="bg-card p-4"><div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Internal DNC</div><div className="mt-1 text-xl font-semibold tabular-nums">{statusQuery.data.dnc.internalCount}</div><div className="mt-1 text-[11px] text-muted-foreground">permanent suppressions</div></div><div className="bg-card p-4"><div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">National dataset</div><div className={`mt-1 text-sm font-semibold ${statusQuery.data.dnc.national?.fresh ? "text-emerald-400" : "text-red-400"}`}>{statusQuery.data.dnc.national?.fresh ? "Fresh" : "Missing / stale"}</div><div className="mt-1 text-[11px] text-muted-foreground">{statusQuery.data.dnc.national?.versionLabel ?? "No version"}</div></div><div className="bg-card p-4"><div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">State datasets</div><div className="mt-1 text-xl font-semibold tabular-nums">{statusQuery.data.dnc.states.filter(item => item.fresh).length}</div><div className="mt-1 text-[11px] text-muted-foreground">fresh active states</div></div></section>

          {canManage ? <ProfileEditor profile={statusQuery.data.profile} /> : <div className="rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground"><LockKeyhole className="mb-2 h-4 w-4" />Read-only compliance access. Policy changes require the calling.policy.manage capability.</div>}
          {canManage && <RepresentativeHoldControls />}
          {canDnc && <DncImport />}

          {canProviders && <section className="rounded-2xl border border-border bg-card"><div className="flex items-center gap-2 border-b border-border p-4"><WalletCards className="h-4 w-4 text-primary" /><div><h2 className="text-sm font-semibold">Licensed provider cost controls</h2><p className="text-[11px] text-muted-foreground">No provider is usable unless its contract and permitted-use approval pass server checks.</p></div></div>{metricsQuery.isLoading ? <div className="p-4"><div className="app-skeleton h-16 rounded-xl" /></div> : metricsQuery.isError ? <div className="p-4 text-xs text-red-400">Provider metrics are unavailable; provider state is not assumed.</div> : metricsQuery.data?.length ? <div className="divide-y divide-border">{metricsQuery.data.map(metric => <div key={metric.id} className="grid grid-cols-[1fr_auto] gap-3 p-4"><div><div className="text-xs font-semibold">{metric.providerName}</div><div className="mt-1 text-[11px] text-muted-foreground">{metric.queries} queries · {metric.compliantUsableMatches} compliant usable matches</div></div><div className="text-right"><div className="text-xs font-semibold tabular-nums">${(metric.totalCostMicros / 1_000_000).toFixed(2)}</div><div className="text-2xs text-muted-foreground">total cost</div></div></div>)}</div> : <div className="p-4 text-xs text-muted-foreground">No contract-approved enrichment providers configured.</div>}</section>}

          {canAudit && <section className="rounded-2xl border border-border bg-card"><div className="flex items-center justify-between gap-3 border-b border-border p-4"><div className="flex items-center gap-2"><Gauge className="h-4 w-4 text-primary" /><div><h2 className="text-sm font-semibold">Calling audit stream</h2><p className="text-[11px] text-muted-foreground">Hash-chained policy, DNC, compliance, authorization, and attempt events.</p></div></div><button type="button" onClick={() => void auditQuery.refetch()} aria-label="Refresh calling audit" className="grid h-11 w-11 place-items-center rounded-xl text-muted-foreground hover:bg-secondary"><RefreshCw className="h-4 w-4" /></button></div>{auditQuery.isLoading ? <div className="p-4"><div className="app-skeleton h-24 rounded-xl" /></div> : auditQuery.isError ? <div className="flex items-start gap-2 p-4 text-xs text-amber-400"><AlertTriangle className="h-4 w-4 shrink-0" />Audit data is unavailable. Operational state is not inferred from an empty feed.</div> : auditQuery.data?.length ? <div className="max-h-96 divide-y divide-border overflow-y-auto px-4">{auditQuery.data.map(event => <div key={event.id} className="py-3"><div className="flex items-baseline justify-between gap-3"><span className="truncate text-xs font-semibold">{formatDecision(event.eventType)}</span><time className="shrink-0 text-2xs text-muted-foreground">{dateLabel(event.createdAt)}</time></div><div className="mt-1 truncate font-mono text-2xs text-muted-foreground">{event.eventSha256}</div></div>)}</div> : <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><FileCheck2 className="h-4 w-4" />No calling audit events yet.</div>}</section>}

          <div className="rounded-2xl border border-border bg-card p-4 text-[11px] leading-relaxed text-muted-foreground"><ShieldCheck className="mb-2 h-4 w-4 text-primary" />This dashboard is an operational control surface, not legal advice. Organization counsel must approve scripts, registrations/exemptions, consent standards, calling windows, and provider permitted use before enabling a market.</div>
        </>}
      </div>
    </CallingChrome>
  );
}
