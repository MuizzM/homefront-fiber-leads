import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { basemapStyle } from "@/lib/basemapStyles";

interface LocationPing {
  id: number; repId: number; userId: number; lat: number; lng: number;
  accuracy: number | null; pingAt: string; repName: string;
}

declare const mapboxgl: any;

export default function LiveMap() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isManager = user?.role === "admin" || user?.role === "manager";
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<Map<number, any>>(new Map());
  // Live references to each popup's time line, so a refreshed ping can
  // update an already-open popup in place.
  const popupTimeElsRef = useRef(new Map<number, HTMLElement>());
  const [mapReady, setMapReady] = useState(false);
  // Library load failed. Without this the skeleton below is the terminal state:
  // a blocked CDN, a captive portal or a dropped LTE fetch left this screen
  // showing a shimmer forever, with nothing to tell the manager why and nothing
  // to retry with. mapLibrary.ts calls its callbacks WITH an error precisely so
  // callers can render this.
  const [mapUnavailable, setMapUnavailable] = useState(false);
  // Bumped by the Retry button. __retryMapbox() clears the loader's failure
  // latch and refetches, but the callback list was already flushed with the
  // error - so the init below has to RE-REGISTER, which is what re-running the
  // effect does. Without this the button reloads the library and then nothing
  // builds the map with it.
  const [libRetry, setLibRetry] = useState(0);
  const [tracking, setTracking] = useState(false);
  const trackingInterval = useRef<any>(null);

  // Fetch map token
  const { data: config } = useQuery<{ token: string }>({
    queryKey: ["/api/config/map"],
    queryFn: () => apiRequest("GET", "/api/config/map").then(r => r.json()),
  });

  // Fetch latest pings per rep
  const { data: pings = [], isLoading, isError, refetch } = useQuery<LocationPing[]>({
    queryKey: ["/api/location-pings/latest"],
    queryFn: () => apiRequest("GET", "/api/location-pings/latest").then(r => r.json()),
    enabled: isManager,
    refetchInterval: 15000,
  });

  // Clock status
  const { data: clockStatus } = useQuery<{ clockedIn: boolean; session: any }>({
    queryKey: ["/api/clock/status"],
    queryFn: () => apiRequest("GET", "/api/clock/status").then(r => r.json()),
    refetchInterval: 30000,
  });

  // Ping mutation
  const pingMutation = useMutation({
    mutationFn: (data: { lat: number; lng: number; accuracy: number }) =>
      apiRequest("POST", "/api/location-pings", data).then(r => r.json()),
  });

  // Start/stop tracking
  function startTracking() {
    if (!("geolocation" in navigator)) {
      toast({ title: "GPS not available", variant: "destructive" });
      return;
    }
    setTracking(true);
    const sendPing = () => {
      navigator.geolocation.getCurrentPosition(
        pos => {
          pingMutation.mutate({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        },
        err => console.warn("GPS error:", err),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    };
    sendPing();
    trackingInterval.current = setInterval(sendPing, 60000);
    toast({ title: "Location sharing active" });
  }

  function stopTracking() {
    setTracking(false);
    if (trackingInterval.current) { clearInterval(trackingInterval.current); trackingInterval.current = null; }
    toast({ title: "Location sharing stopped" });
  }

  // Leaving the page must stop the pinger: without this cleanup, navigating
  // away with sharing on kept posting the rep's GPS position every 60s for the
  // rest of the session, with the "Sharing Location" badge no longer visible
  // to tell them. Privacy first, battery second.
  useEffect(() => () => {
    if (trackingInterval.current) { clearInterval(trackingInterval.current); trackingInterval.current = null; }
  }, []);

  // Init map — Mapbox GL is lazy-loaded (index.html); trigger the fetch on mount.
  useEffect(() => {
    // No token gate: MapLibre does not use one. Only the container matters.
    if (!mapContainer.current || mapRef.current) return;
    const token = config?.token ?? "";
    // Go through the loader's own contract rather than polling for the global.
    // The old init was a 150ms timer that rescheduled itself until the global
    // appeared: no bail, so a failed load span forever behind the skeleton, and
    // no cleanup, so unmounting mid-load left a pending timer that then
    // constructed a map into a null container. __onMapboxReady answers exactly
    // once, with an error when the library could not be fetched.
    let cancelled = false;
    const init = (err?: Error) => {
      if (cancelled || mapRef.current) return;
      const mgl = (window as any).mapboxgl;
      if (err || !mgl || !mapContainer.current) { setMapUnavailable(true); return; }
      setMapUnavailable(false);
      mgl.accessToken = token;
      mapRef.current = new mgl.Map({
        container: mapContainer.current,
        style: basemapStyle("dark"),
        center: [-80.4139, 35.5501],
        zoom: 12,
      });
      mapRef.current!.on("load", () => { if (!cancelled) setMapReady(true); });
    };
    const onReady = (window as any).__onMapboxReady;
    if (typeof onReady === "function") onReady(init);
    else init(new Error("map library loader missing"));
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [config?.token, libRetry]);

  // Update markers when pings change
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const currentIds = new Set(pings.map(p => p.repId));
    // Remove stale markers
    markersRef.current.forEach((marker, repId) => {
      if (!currentIds.has(repId)) { marker.remove(); markersRef.current.delete(repId); popupTimeElsRef.current.delete(repId); }
    });
    // Add/update markers
    pings.forEach(ping => {
      const el = document.createElement("div");
      el.style.cssText = `width:36px;height:36px;border-radius:50%;background:#3EA394;border:3px solid #fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 0 0 4px rgba(62,163,148,0.3)`;
      // Use textContent (never innerHTML) for user-supplied names — prevents stored XSS
      const initials = document.createElement("span");
      initials.style.cssText = "color:white;font-size:11px;font-weight:700";
      initials.textContent = ping.repName.charAt(0);
      el.appendChild(initials);
      el.title = ping.repName;
      if (markersRef.current.has(ping.repId)) {
        const existing = markersRef.current.get(ping.repId);
        existing.setLngLat([ping.lng, ping.lat]);
        // The marker keeps its ORIGINAL element - update that one, not the
        // fresh `el` built above (which is discarded on this path).
        existing.getElement().title = ping.repName;
        const liveTimeEl = popupTimeElsRef.current.get(ping.repId);
        if (liveTimeEl) liveTimeEl.textContent = `Last seen: ${new Date(ping.pingAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
      } else {
        // Build popup using DOM nodes — never setHTML with user data
        const popupEl = document.createElement("div");
        popupEl.style.cssText = "background:#0F2A44;color:#fff;padding:8px 12px;border-radius:6px;min-width:140px";
        const nameEl = document.createElement("p");
        nameEl.style.cssText = "font-weight:700;margin:0 0 2px";
        nameEl.textContent = ping.repName;
        const timeEl = document.createElement("p");
        timeEl.style.cssText = "color:#3EA394;font-size:11px;margin:0";
        timeEl.textContent = `Last seen: ${new Date(ping.pingAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
        popupEl.appendChild(nameEl);
        popupEl.appendChild(timeEl);
        popupTimeElsRef.current.set(ping.repId, timeEl);
        if (ping.accuracy) {
          const accEl = document.createElement("p");
          accEl.style.cssText = "color:#7a9ab5;font-size:10px;margin:2px 0 0";
          accEl.textContent = `±${Math.round(ping.accuracy)}m`;
          popupEl.appendChild(accEl);
        }
        const popup = new mapboxgl.Popup({ offset: 20 }).setDOMContent(popupEl);
        const marker = new mapboxgl.Marker(el).setLngLat([ping.lng, ping.lat]).setPopup(popup).addTo(mapRef.current);
        markersRef.current.set(ping.repId, marker);
      }
    });
  }, [pings, mapReady]);

  function timeAgo(ts: string) {
    const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }

  // "Active" means what the legend says: a ping in the last 15 minutes. Reps
  // with older (≤8h, server-windowed) pings still render, as "earlier today".
  const activeCount = pings.filter(p => Date.now() - new Date(p.pingAt).getTime() <= 15 * 60_000).length;

  return (
    <div className="w-full max-w-7xl mx-auto p-4 pt-5 pb-24 space-y-4 md:p-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Live Field Map</h1>
          <p className="text-sm text-muted-foreground">Real-time rep locations · updates every 60 seconds</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Clocked in reps count */}
          {isManager && (
            <Badge className={activeCount > 0 ? "bg-success/10 text-success border-success/25" : "bg-secondary text-muted-foreground border-border"}>
               <span className="tabular-nums">{activeCount}</span>&nbsp;active
            </Badge>
          )}
          {/* Rep tracking toggle */}
          {!isManager && (
            tracking ? (
              <Button size="sm" variant="outline" onClick={stopTracking} className="border-destructive/30 text-destructive hover:bg-destructive/10" data-testid="button-stop-tracking">
                Stop Sharing Location
              </Button>
            ) : (
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={startTracking} data-testid="button-start-tracking" disabled={!clockStatus?.clockedIn}>
                
                {clockStatus?.clockedIn ? "Share My Location" : "Clock In First"}
              </Button>
            )
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Map */}
        <div className="lg:col-span-3">
          <Card className="bg-card border-border overflow-hidden">
            <div ref={mapContainer} style={{ height: "520px", width: "100%" }}>
              {mapUnavailable ? (
                <div
                  className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center"
                  role="alert"
                  data-testid="livemap-library-error"
                >
                  <p className="text-sm text-muted-foreground">
                    The map could not be loaded. Check your connection and try again.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="livemap-library-retry"
                    onClick={() => {
                      setMapUnavailable(false);
                      (window as any).__retryMapbox?.();
                      setLibRetry(n => n + 1); // re-register the ready callback
                    }}
                  >
                    Retry
                  </Button>
                </div>
              ) : !mapReady ? (
                <div className="h-full flex items-center justify-center">
                  <Skeleton className="w-full h-full bg-secondary" />
                </div>
              ) : null}
            </div>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Rep list */}
          {isManager && (
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                   Reps in Field
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-3 space-y-2">
                    {[1,2,3].map(i => <Skeleton key={i} className="h-10 bg-secondary" />)}
                  </div>
                ) : isError ? (
                  /* An outage must not read as "every rep is offline" — that
                     false-negative would send a manager chasing phantom idle
                     reps. Distinct error + retry instead of the empty branch. */
                  <div className="px-3 pb-3 pt-1" role="alert" data-testid="livemap-pings-error">
                    <p className="text-xs text-destructive font-medium">Couldn&apos;t load rep locations</p>
                    <button type="button" onClick={() => refetch()} data-testid="livemap-pings-retry"
                      className="mt-2 inline-flex h-8 items-center rounded-lg border border-border bg-secondary px-3 text-xs font-semibold text-foreground active:scale-95 transition-transform">
                      Retry
                    </button>
                  </div>
                ) : pings.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-3 pb-3">No active reps</p>
                ) : (
                  <div className="divide-y divide-border">
                    {pings.map(p => (
                      <button key={p.repId} type="button"
                        aria-label={`Fly map to ${p.repName}`}
                        className="w-full text-left px-3 py-2.5 flex items-center gap-2 cursor-pointer hover:bg-secondary/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        onClick={() => mapRef.current?.flyTo({ center: [p.lng, p.lat], zoom: 15 })}
                        data-testid={`rep-ping-${p.repId}`}
                      >
                        <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold flex-shrink-0">
                          {p.repName.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-foreground font-medium truncate">{p.repName}</p>
                          <p className="text-xs text-muted-foreground">{timeAgo(p.pingAt)}</p>
                        </div>
                        {/* The legend defines green as "Online (last 15 min)" -
                            an unconditional green dot beside "6h ago" was an
                            explicit falsehood. Grey past the window. */}
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${Date.now() - new Date(p.pingAt).getTime() < 15 * 60_000 ? "bg-success" : "bg-muted-foreground/40"}`} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Rep self-status */}
          {!isManager && (
            <Card className="bg-card border-border">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2">
                  
                  <span className="text-sm text-foreground font-medium">Field Status</span>
                </div>
                <div className="space-y-1">
                  <Badge className={clockStatus?.clockedIn ? "bg-success/10 text-success border-success/25" : "bg-secondary text-muted-foreground border-border"}>
                    {clockStatus?.clockedIn ? "Clocked In" : "Clocked Out"}
                  </Badge>
                  {tracking && (
                    <Badge className="bg-info/10 text-info border-info/25 ml-2">
                       Sharing Location
                    </Badge>
                  )}
                </div>
                {clockStatus?.session && (
                  <p className="text-xs text-muted-foreground">
                    Since {new Date(clockStatus.session.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Map Legend</span>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded-full border-2 border-white" style={{ background: "#3EA394" }} />
                  <span className="text-xs text-muted-foreground">Active rep</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-success" />
                  <span className="text-xs text-muted-foreground">Online (last 15 min)</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
