import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
// scanOneAddress removed — single-address checks go through server /api/check-fiber to avoid CORS
import { useToast } from "@/hooks/use-toast";
import { 
  Search, Wifi, WifiOff, CheckCircle, AlertCircle, 
  Plus, Clock, MapPin, Zap, ExternalLink
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FiberCheck } from "@shared/schema";

interface FiberResult {
  address: string; city: string; state: string; zip: string;
  lat: number | null; lng: number | null;
  fiberStatus: string; fiberAvailable: boolean; isNewFiber: boolean; isTenured: boolean; isNewDeployment: boolean;
  speedTier: string | null; maxDownload: number | null; maxDownloadMbps: number | null;
  deploymentNotes: string; notes: string; confidence: string;
  householdSegmentType: string | null; billingStatus: string | null;
  techType: string | null; chipSetType: string | null; placement: string | null;
  competitorName: string | null; competitorSpeedMbps: number | null; competitorTech: string | null;
  addressCatalogDate: string | null;
}

const SPEED_TIER_LABEL: Record<string, string> = {
  "1gig": "1 Gig (1,000 Mbps)",
  "500mbps": "500 Mbps",
  "200mbps": "200 Mbps",
  "2gig": "2 Gig (2,000 Mbps)",
};

const KNOWN_PLANS = [
  { name: "Fiber 300", speed: "300 Mbps", price: "$34.99/mo", highlight: false },
  { name: "Fiber 1 Gig", speed: "1,000 Mbps", price: "$39.99/mo", highlight: true },
  { name: "Fiber 2 Gig", speed: "2,000 Mbps", price: "$59.99/mo", highlight: false },
  { name: "Fiber Max 2 Gig", speed: "2,000 Mbps + eero Pro 7", price: "$79.99/mo", highlight: false },
];

export default function FiberScanner() {
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state] = useState("NC");
  const [zip, setZip] = useState("");
  const [result, setResult] = useState<FiberResult | null>(null);
  const [addLeadOpen, setAddLeadOpen] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [leadStatus, setLeadStatus] = useState("prospect");
  const [notes, setNotes] = useState("");

  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: recentChecks = [] } = useQuery<FiberCheck[]>({ queryKey: ["/api/fiber-checks"] });

  const checkMutation = useMutation({
    mutationFn: async () => {
      // Route through server /api/check-fiber (uses v2 endpoint — no CORS, no IP ban)
      const r = await (await apiRequest("POST", "/api/check-fiber", { address, city, state, zip })).json() as any;
      return {
        address: r.address ?? address,
        city: r.city ?? city,
        state: r.state ?? state,
        zip: r.zip ?? zip,
        lat: r.lat ?? null,
        lng: r.lng ?? null,
        fiberStatus: r.fiberStatus ?? "unknown",
        fiberAvailable: r.fiberAvailable ?? false,
        isNewFiber: r.isNewFiber ?? false,
        isTenured: r.isTenured ?? false,
        isNewDeployment: r.isNewFiber ?? false,
        maxDownload: r.maxDownloadMbps ?? null,
        maxDownloadMbps: r.maxDownloadMbps ?? null,
        speedTier: r.speedTier ?? null,
        notes: r.notes ?? "",
        deploymentNotes: r.notes ?? "",
        confidence: r.confidence ?? "LOW",
        householdSegmentType: r.householdSegmentType ?? null,
        billingStatus: r.billingStatus ?? null,
        techType: r.techType ?? null,
        chipSetType: r.chipSetType ?? null,
        placement: r.placement ?? null,
        competitorName: r.competitorName ?? null,
        competitorSpeedMbps: r.competitorSpeedMbps ?? null,
        competitorTech: r.competitorTech ?? null,
        addressCatalogDate: r.addressCatalogDate ?? null,
      } as FiberResult;
    },
    onSuccess: (data: FiberResult) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ["/api/fiber-checks"] });
    },
    onError: () => toast({ title: "Check failed", description: "Could not reach the fiber API.", variant: "destructive" }),
  });

  const addLeadMutation = useMutation({
    mutationFn: async () => {
      if (!result) return;
      const body = {
        address: result.address,
        city: result.city,
        state: result.state,
        zip: result.zip,
        lat: result.lat,
        lng: result.lng,
        fiberStatus: result.fiberStatus,
        speedTier: result.speedTier,
        maxDownload: result.maxDownloadMbps ?? result.maxDownload,
        maxDownloadMbps: result.maxDownloadMbps,
        isNewDeployment: result.isNewFiber,
        isTenured: result.isTenured,
        deploymentNotes: result.notes ?? "",
        householdSegmentType: result.householdSegmentType,
        billingStatus: result.billingStatus,
        techType: result.techType,
        chipSetType: result.chipSetType,
        placement: result.placement,
        competitorName: result.competitorName,
        competitorSpeedMbps: result.competitorSpeedMbps,
        competitorTech: result.competitorTech,
        addressCatalogDate: result.addressCatalogDate,
        contactName: contactName || null,
        contactPhone: contactPhone || null,
        leadStatus,
        notes: notes || result.notes || "",
      };
      return await apiRequest("POST", "/api/leads", body);
    },
    onSuccess: () => {
      toast({ title: "Lead added", description: `${address} saved to lead management.` });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      setAddLeadOpen(false);
      setContactName(""); setContactPhone(""); setLeadStatus("prospect"); setNotes("");
    },
  });

  const fiberStatusColor = result ? {
    new_fiber: "border-green-500/40 bg-green-500/10",
    existing_fiber: "border-sky-500/40 bg-sky-500/10",
    copper: "border-amber-500/40 bg-amber-500/10",
    unknown: "border-border bg-card",
    no_service: "border-red-500/40 bg-red-500/10",
  }[result.fiberStatus] ?? "border-border bg-card" : "";

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold">Fiber Scanner</h1>
        <p className="text-sm text-muted-foreground mt-1">Check if an address has new Kinetic fiber vs legacy copper</p>
      </div>

      {/* Input form */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Search className="w-4 h-4 text-primary" /> Address Lookup
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="md:col-span-2">
              <Label className="text-xs text-muted-foreground mb-1 block">Street Address</Label>
              <Input 
                value={address} onChange={e => setAddress(e.target.value)}
                placeholder="1155 Bell Ridge Ct"
                className="bg-secondary border-input text-sm"
                data-testid="input-address"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">City</Label>
              <Input 
                value={city} onChange={e => setCity(e.target.value)}
                placeholder="City"
                className="bg-secondary border-input text-sm"
                data-testid="input-city"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">ZIP Code</Label>
              <Input 
                value={zip} onChange={e => setZip(e.target.value)}
                placeholder="ZIP Code"
                className="bg-secondary border-input text-sm"
                data-testid="input-zip"
              />
            </div>
          </div>
          <Button 
            onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending || !address || !city || !zip}
            className="mt-4 bg-primary hover:bg-primary/90 text-white"
            data-testid="btn-check-fiber"
          >
            {checkMutation.isPending ? (
              <><span className="animate-spin mr-2">⊙</span> Scanning...</>
            ) : (
              <><Search className="w-4 h-4 mr-2" /> Check Fiber Status</>
            )}
          </Button>


        </CardContent>
      </Card>

      {/* Result */}
      {result && (
        <Card className={`border ${fiberStatusColor}`}>
          <CardContent className="pt-5">
            <div className="flex items-start gap-4">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                result.isNewFiber ? "bg-green-500/20" : result.fiberAvailable ? "bg-sky-500/20" : "bg-muted"
              }`}>
                {result.fiberAvailable ? (
                  <Wifi className={`w-5 h-5 ${result.isNewFiber ? "text-green-400" : "text-sky-400"}`} />
                ) : (
                  <WifiOff className="w-5 h-5 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-foreground">{result.address}, {result.city}, {result.state} {result.zip}</span>
                  {result.isNewFiber && (
                    <Badge className="bg-green-500/20 text-green-400 border border-green-500/30 text-xs px-2 py-0.5 rounded-full">NEW FIBER</Badge>
                  )}
                  {result.isTenured && !result.isNewFiber && (
                    <Badge className="bg-purple-500/20 text-purple-300 border border-purple-500/30 text-xs px-2 py-0.5 rounded-full">TENURED</Badge>
                  )}
                  {!result.isNewFiber && !result.isTenured && result.fiberAvailable && (
                    <Badge className="bg-sky-500/20 text-sky-400 border border-sky-500/30 text-xs px-2 py-0.5 rounded-full">FIBER</Badge>
                  )}
                </div>
                <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {result.maxDownload && (
                    <div className="flex items-center gap-2">
                      <Zap className="w-3.5 h-3.5 text-primary" />
                      <span className="text-foreground font-medium">
                        {result.maxDownload >= 1000 ? `${result.maxDownload / 1000} Gbps` : `${result.maxDownload} Mbps`} available
                      </span>
                    </div>
                  )}
                  {result.billingStatus === "N" && (
                    <div className="text-xs text-green-400 font-medium">No active subscriber — door-knock ready</div>
                  )}
                  {result.billingStatus === "Y" && (
                    <div className="text-xs text-muted-foreground">Already a Kinetic subscriber</div>
                  )}
                  {result.isTenured && result.billingStatus === "N" && (
                    <div className="mt-2 text-xs rounded-md bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5 text-amber-300">
                      Fiber is wired but no active account — prime target
                    </div>
                  )}
                  {result.competitorName && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">Competitor:</span>
                      <span className="text-xs text-foreground">{result.competitorName} · {result.competitorSpeedMbps} Mbps</span>
                    </div>
                  )}
                </div>

                {/* Available plans for this address */}
                {result.fiberAvailable && (
                  <div className="mt-4">
                    <div className="text-xs font-semibold text-foreground mb-2">Available Plans (from gokinetic.com)</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {KNOWN_PLANS.map(plan => (
                        <div key={plan.name} className={`rounded-md border p-2 text-xs ${
                          plan.highlight ? "border-primary/40 bg-primary/10" : "border-border bg-secondary/50"
                        }`}>
                          <div className="font-semibold text-foreground">{plan.name}</div>
                          <div className="text-muted-foreground mt-0.5">{plan.speed}</div>
                          <div className={`mt-1 font-bold ${plan.highlight ? "text-primary" : "text-foreground"}`}>{plan.price}</div>
                          {plan.highlight && <div className="text-green-400 text-xs mt-0.5">Best value</div>}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      + $100–$200 Mastercard reward available · No annual contract · No data caps
                    </div>
                  </div>
                )}

                <div className="flex gap-2 mt-4">
                  <Button 
                    size="sm" onClick={() => setAddLeadOpen(true)}
                    className="bg-primary hover:bg-primary/90 text-white text-xs"
                    data-testid="btn-add-lead"
                  >
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add to Leads
                  </Button>
                  <a 
                    href={`https://www.gokinetic.com/shop/internet?addr=${encodeURIComponent(result.address)}&city=${encodeURIComponent(result.city)}&state=${result.state}&zip=${result.zip}`}
                    target="_blank" rel="noreferrer"
                  >
                    <Button size="sm" variant="outline" className="border-border text-xs">
                      gokinetic.com <ExternalLink className="w-3 h-3 ml-1" />
                    </Button>
                  </a>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent checks */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" /> Recent Checks
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentChecks.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">No checks yet.</div>
          ) : (
            <div className="space-y-2">
              {recentChecks.slice(0, 10).map(check => (
                <div key={check.id} className="flex items-center gap-3 text-xs py-1.5 border-b border-border last:border-0">
                  <MapPin className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="flex-1 text-foreground truncate">{check.address}</span>
                  {check.isNewFiber ? (
                    <Badge className="bg-green-500/20 text-green-400 border border-green-500/30 text-xs px-1.5 py-0 rounded-full">New Fiber</Badge>
                  ) : check.fiberAvailable ? (
                    <Badge className="bg-sky-500/20 text-sky-400 border border-sky-500/30 text-xs px-1.5 py-0 rounded-full">Fiber</Badge>
                  ) : (
                    <Badge className="bg-slate-500/20 text-slate-400 border border-slate-500/30 text-xs px-1.5 py-0 rounded-full">Unknown</Badge>
                  )}
                  <span className="text-muted-foreground font-mono">{new Date(check.checkedAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add lead dialog */}
      <Dialog open={addLeadOpen} onOpenChange={setAddLeadOpen}>
        <DialogContent className="bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-base">Add Lead</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground bg-secondary rounded px-3 py-2">
              <MapPin className="w-3.5 h-3.5 inline mr-1" />
              {result?.address}, {result?.city} {result?.zip} · 
              <span className={`ml-1 ${result?.isNewFiber ? "text-green-400" : "text-sky-400"}`}>
                {result?.isNewFiber ? "New Fiber" : result?.fiberAvailable ? "Fiber" : "Unknown"}
              </span>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Contact Name (optional)</Label>
              <Input value={contactName} onChange={e => setContactName(e.target.value)} 
                className="bg-secondary border-input mt-1" placeholder="John Smith"
                data-testid="input-contact-name" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Phone (optional)</Label>
              <Input value={contactPhone} onChange={e => setContactPhone(e.target.value)}
                className="bg-secondary border-input mt-1" placeholder="(704) 555-0100"
                data-testid="input-contact-phone" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Lead Status</Label>
              <Select value={leadStatus} onValueChange={setLeadStatus}>
                <SelectTrigger className="bg-secondary border-input mt-1" data-testid="select-lead-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="prospect">Prospect</SelectItem>
                  <SelectItem value="contacted">Contacted</SelectItem>
                  <SelectItem value="interested">Interested</SelectItem>
                  <SelectItem value="sold">Sold</SelectItem>
                  <SelectItem value="not_interested">Not Interested</SelectItem>
                  <SelectItem value="follow_up">Follow Up</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Notes</Label>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)}
                className="bg-secondary border-input mt-1 text-sm" rows={3}
                placeholder="Door knocked 7/6, no answer. Try again afternoon."
                data-testid="input-notes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddLeadOpen(false)} className="border-border">Cancel</Button>
            <Button onClick={() => addLeadMutation.mutate()} disabled={addLeadMutation.isPending}
              className="bg-primary hover:bg-primary/90 text-white" data-testid="btn-save-lead">
              Save Lead
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
