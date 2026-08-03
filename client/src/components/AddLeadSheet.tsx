// ── AddLeadSheet — manual "add a lead" flow ───────────────────────────────────
// Opens prefilled from a tapped house or a scanned dot (address/city/state/zip
// carried through), or blank for a pure manual entry. Posts to POST /api/leads
// (tenant stamped server-side; coordinates forward-geocoded server-side when
// missing, so a typed-in lead ALWAYS lands a pin). Real <form> so the mobile
// keyboard's Go key submits; correct autoComplete/enterKeyHint/autoCapitalize
// per field; NC/SC segmented state toggle; "Use my location" fills the address
// from a live GPS fix. A duplicate address returns the existing lead
// (existed:true) — the map flies to it instead of ghosting a second pin.
// Submit is perceived-instant: the sheet closes on the tap and the POST runs
// in the background (success/duplicate/failure all land as toasts).
import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, MapPin, LocateFixed } from "lucide-react";
import type { CardProperty } from "@/components/LeadCard";

// Server-computed reason the caller may NOT see an already-existing lead's pin
// (POST /api/leads existed branch). Additive to the {existed:true} contract —
// the client uses it to explain honestly and open the lead by id, never to
// fabricate a pin. `inYourScope` mirrors GET /api/leads/:id's access gate.
export interface LeadVisibility {
  geocoded: boolean;
  hiddenStatus: string | null;
  inYourScope: boolean;
  assignedRepName: string | null;
  reason: "ungeocoded" | "hidden_status" | "out_of_scope" | "visible";
}

// Plain-language reason a suppressed lead is off the map (server hiddenStatus →
// field-honest words). Falls back to a neutral phrase for any unknown status.
export function hiddenStatusPlain(hiddenStatus: string | null | undefined): string {
  switch (hiddenStatus) {
    case "competitor_suppressed": return "a competitor already serves this address";
    case "scope_suppressed": return "it's outside the current service area";
    case "address_review": return "its address is under review";
    default: return "it's currently held back from the map";
  }
}

// The reason-aware decision for a duplicate ("existed:true") lead — a PURE
// function so both the map handler and its tests read the same logic. Never
// fabricates a pin: `open` means "select the lead id and load its detail", which
// the sheet does WITHOUT requiring a rendered map feature.
//   • visible      → genuinely on the caller's map: flash + fly + open.
//   • ungeocoded / hidden_status / out_of_scope → explain WHY in plain words and
//     open by id ONLY when the caller may access it (inYourScope — the same gate
//     GET /api/leads/:id uses, so opening can't 404). No flash, no fly.
export interface ExistedLeadPlan {
  reason: LeadVisibility["reason"];
  onMap: boolean;   // true only for a genuinely-rendered pin
  fly: boolean;     // camera fly (visible only)
  flash: boolean;   // ring confirm-flash (visible only)
  open: boolean;    // select the lead id (load detail; no pin required)
  toastTitle: string;
  toastDescription: string;
  severity?: "success";
}
export function planExistingLead(address: string, visibility?: LeadVisibility): ExistedLeadPlan {
  const reason = visibility?.reason ?? "visible";
  if (reason === "visible") {
    return {
      reason, onMap: true, fly: true, flash: true, open: true,
      toastTitle: "Already on the map", toastDescription: address, severity: "success",
    };
  }
  const why =
    reason === "ungeocoded" ? "it doesn't have map coordinates yet"
    : reason === "hidden_status" ? hiddenStatusPlain(visibility?.hiddenStatus)
    : visibility?.assignedRepName ? `it's assigned to ${visibility.assignedRepName}`
    : "it's assigned to another rep or team";
  const canOpen = visibility?.inYourScope === true;
  return {
    reason, onMap: false, fly: false, flash: false, open: canOpen,
    toastTitle: "Already a lead — not on your map",
    toastDescription: canOpen ? `${address}: ${why}. Opening it…` : `${address}: ${why}.`,
  };
}

export function AddLeadSheet({ initial, onClose, onCreated }: {
  initial: Partial<CardProperty> | null;
  onClose: () => void;
  onCreated?: (leadId: number, opts?: { existed?: boolean; visibility?: LeadVisibility; address?: string }) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("NC");
  const [zip, setZip] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  // lat/lng travel with the form so a "Use my location" fix or a tapped-house
  // coordinate survives the user editing the text fields.
  const geoRef = useRef<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });

  // Re-seed the form whenever a new source property opens the sheet.
  useEffect(() => {
    if (!initial) return;
    setAddress(initial.address ?? "");
    setCity(initial.city ?? "");
    setState((initial.state ?? "NC").toUpperCase() === "SC" ? "SC" : "NC");
    setZip(initial.zip ?? "");
    setOwnerName("");
    setSaving(false); // a background save from the LAST open must not lock this one
    geoRef.current = { lat: initial.lat ?? null, lng: initial.lng ?? null };
  }, [initial]);

  const open = !!initial;
  const prefilled = !!initial?.address;
  // ZIP must be a real 5-digit code — 3 digits used to pass and then die at the
  // server's stricter schema with an unreadable error.
  const missing: string[] = [];
  if (address.trim().length < 3) missing.push("street address");
  if (city.trim().length < 2) missing.push("city");
  if (!/^\d{5}$/.test(zip.trim())) missing.push("5-digit ZIP");
  const canSave = missing.length === 0 && !saving;

  async function useMyLocation() {
    if (locating) return;
    setLocating(true);
    try {
      const fix = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000,
        });
      });
      const { latitude, longitude } = fix.coords;
      geoRef.current = { lat: latitude, lng: longitude };
      const res = await apiRequest("GET", `/api/geocode/reverse?lat=${latitude}&lng=${longitude}`);
      const a = await res.json();
      if (a?.address) setAddress(a.address);
      if (a?.city) setCity(a.city);
      if (a?.state) setState(String(a.state).toUpperCase() === "SC" ? "SC" : "NC");
      if (a?.zip) setZip(a.zip);
    } catch {
      toast({ title: "Couldn't get your location", description: "Type the address instead.", variant: "destructive" });
    } finally {
      setLocating(false);
    }
  }

  function submit() {
    if (!canSave) return;
    // One-frame double-submit guard: the button disables on this render while
    // the sheet is already closing from the same tap.
    setSaving(true);
    // Deliberately NO fiber/provenance fields: the server hard-rejects any
    // client-supplied fresh-fiber claim (the cross-verified scan pipeline is
    // the only author). Carrying them here is what 400'd the scan-dot path.
    const submittedAddress = address.trim();
    const body: Record<string, unknown> = {
      address: submittedAddress, city: city.trim(), state, zip: zip.trim(),
      leadStatus: "prospect",
      lat: geoRef.current.lat, lng: geoRef.current.lng,
    };
    if (ownerName.trim()) body.ownerName = ownerName.trim();
    // Perceived-instant add (owner ask 2026-07-31): the sheet closes on the
    // SAME tap — no "Adding…" phase — and the POST runs in the background.
    // Everything the continuation touches (toast store, query cache, parent
    // callbacks) is safe to call after this component unmounts.
    onClose();
    void (async () => {
      try {
        const res = await apiRequest("POST", "/api/leads", body);
        const lead = await res.json();
        const existed = lead?.existed === true;
        // Paint the pin NOW (knock pattern): insert into the map query cache and
        // let the follow-up invalidate reconcile against the durable source.
        if (!existed && lead?.id != null && lead?.lat != null && lead?.lng != null) {
          qc.setQueryData(["/api/leads/map"], (old: any) => {
            if (!old?.pins || old.pins.some((p: any) => p.id === lead.id)) return old;
            return {
              ...old,
              total: (old.total ?? old.pins.length) + 1,
              pins: [
                ...old.pins,
                {
                  id: lead.id, address: lead.address, city: lead.city, state: lead.state,
                  zip: lead.zip, lat: lead.lat, lng: lead.lng,
                  leadStatus: lead.leadStatus ?? "prospect", visited: false,
                  assignedRepId: lead.assignedRepId ?? null,
                },
              ],
            };
          });
        }
        try { navigator.vibrate?.(10); } catch { /* no haptics */ }
        // A NEW lead gets the plain success toast here. A DUPLICATE is handed
        // wholesale to onCreated (MapView), which owns the reason-aware honest
        // message + open-by-id — the old blanket "opening it" toast lied when
        // the existing lead was ungeocoded / suppressed / out of the caller's
        // scope (there was nothing to open).
        if (!existed) {
          // When the client had no coordinates (a typed address, not a rooftop
          // tap), the server geocodes in the background and the pin lands a beat
          // later — say so instead of implying it's already on the map.
          const placing = lead?.lat == null || lead?.lng == null;
          toast({ title: "Lead added", description: placing ? `${submittedAddress} — placing on map…` : submittedAddress });
        }
        qc.invalidateQueries({ queryKey: ["/api/leads"] });
        qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
        // The map's camera fly to the real pin is a follow-on flourish — it
        // rides the server response, never the open sheet.
        if (lead?.id != null) onCreated?.(lead.id, { existed, visibility: lead.visibility, address: submittedAddress });
      } catch (e: any) {
        // The sheet is long closed — a loud toast is the only honest signal
        // that this door did NOT save.
        const msg = String(e?.message ?? "").replace(/^\s*\d{3}:\s*/, "");
        toast({
          title: "Couldn't add lead",
          description: `${submittedAddress} didn't save${msg ? ` — ${msg}` : ". Try again."}`,
          variant: "destructive",
        });
      } finally {
        setSaving(false); // no-op after unmount; unlocks a still-mounted sheet
      }
    })();
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="bottom"
        // transition-none kills the sheet base's transition-all on this large
        // surface; open/close run on the base's 200ms/150ms GPU slide+fade
        // keyframes. The form renders complete on the open frame — no fetch
        // gates mounting.
        className="glass-sheet glass-ink-scope rounded-t-3xl p-0 border-white/10 max-h-[92dvh] overflow-y-auto transition-none will-change-transform"
        data-testid="add-lead-sheet"
      >
        {/* Real form: the mobile keyboard's Go/Enter submits the happy path. */}
        <form
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
          className="flex max-h-[inherit] flex-col"
        >
          <div className="p-5 pb-3">
            <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-white/40" aria-hidden="true" />
            <div className="flex items-center gap-2">
              <h2 className="text-[19px] font-bold tracking-tight text-foreground flex items-center gap-2 flex-1">
                <span className="grid place-items-center w-8 h-8 rounded-xl bg-primary/12 text-primary"><Plus className="w-4 h-4" /></span>
                Add a lead
              </h2>
              {!prefilled && (
                <button
                  type="button"
                  onClick={() => void useMyLocation()}
                  disabled={locating}
                  data-testid="add-lead-use-location"
                  className="h-11 inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3.5 text-[12.5px] font-semibold text-primary active:scale-[0.97] transition disabled:opacity-60"
                >
                  {locating ? <Loader2 className="w-4 h-4 animate-spin" /> : <LocateFixed className="w-4 h-4" />}
                  Use my location
                </button>
              )}
            </div>
            {initial?.lat != null && (
              <p className="text-[12px] text-muted-foreground mt-1 flex items-center gap-1"><MapPin className="w-3 h-3" /> From the map — check the address below.</p>
            )}

            <div className="mt-4 space-y-3">
              {/* autoFocus ONLY when blank: a prefilled sheet opens keyboard-down
                  so the rep reviews and thumbs Save in one motion. */}
              <Field label="Street address" value={address} onChange={setAddress} placeholder="402 Nard Ln"
                testid="add-lead-address" autoFocus={!prefilled} autoComplete="street-address"
                autoCapitalize="words" enterKeyHint="next" />
              <div className="grid grid-cols-[1fr_112px] gap-2">
                <Field label="City" value={city} onChange={setCity} placeholder="Inman"
                  testid="add-lead-city" autoComplete="address-level2" autoCapitalize="words" enterKeyHint="next" />
                <Field label="ZIP" value={zip} onChange={(v) => setZip(v.replace(/\D/g, "").slice(0, 5))}
                  placeholder="29349" inputMode="numeric" testid="add-lead-zip"
                  autoComplete="postal-code" enterKeyHint="next" />
              </div>
              <div>
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">State</span>
                <div className="flex items-center gap-1 rounded-full bg-white/10 p-0.5" role="radiogroup" aria-label="State">
                  {(["NC", "SC"] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      role="radio"
                      aria-checked={state === st}
                      onClick={() => setState(st)}
                      data-testid={`add-lead-state-${st.toLowerCase()}`}
                      className={`flex-1 h-11 rounded-full text-[13px] font-semibold transition ${state === st ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>
              <Field label="Owner name (optional)" value={ownerName} onChange={setOwnerName} placeholder="—"
                testid="add-lead-owner" autoComplete="name" autoCapitalize="words" enterKeyHint="done" />
              <p className="rounded-xl border border-border bg-secondary/50 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                Phone data is added only through the licensed, compliance-gated Calling workspace.
              </p>
            </div>
          </div>

          {/* Sticky submit row: always visible above the keyboard/home bar. */}
          <div className="sticky bottom-0 mt-auto bg-transparent px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">
            {!canSave && !saving && (
              <p className="mb-1.5 text-center text-[12px] text-muted-foreground" data-testid="add-lead-missing">
                Add {missing.join(" and ")}
              </p>
            )}
            {/* No loading phase: the tap closes the sheet and the save runs in
                the background. `disabled` still flips for the one frame before
                close so a double tap can't post twice. */}
            <button type="submit" disabled={!canSave} data-testid="add-lead-submit"
              className="w-full h-12 rounded-2xl bg-primary text-primary-foreground text-[15px] font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99] transition">
              Add lead
            </button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value, onChange, placeholder, inputMode, autoFocus, testid, autoComplete, autoCapitalize, enterKeyHint }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
  inputMode?: "text" | "numeric"; autoFocus?: boolean; testid?: string;
  autoComplete?: string; autoCapitalize?: string; enterKeyHint?: "next" | "done" | "go";
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</span>
      <input
        value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        inputMode={inputMode} autoFocus={autoFocus} data-testid={testid}
        autoComplete={autoComplete} autoCapitalize={autoCapitalize} enterKeyHint={enterKeyHint}
        className="w-full h-11 rounded-xl border border-border bg-card px-3 text-[15px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
    </label>
  );
}
