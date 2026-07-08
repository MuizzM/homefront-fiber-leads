import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { MapPin, Radio, Navigation, Users, Clock } from "lucide-react";

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
  const [mapReady, setMapReady] = useState(false);
  const [tracking, setTracking] = useState(false);
  const trackingInterval = useRef<any>(null);

  // Fetch map token
  const { data: config } = useQuery<{ token: string }>({
    queryKey: ["/api/config/map"],
    queryFn: () => apiRequest("GET", "/api/config/map").then(r => r.json()),
  });

  // Fetch latest pings per rep
  const { data: pings = [], isLoading } = useQuery<LocationPing[]>({
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

  // Init map — mapboxgl loaded via CDN <script> in index.html
  useEffect(() => {
    if (!config?.token || !mapContainer.current || mapRef.current) return;
    const token = config.token;
    const tryInit = () => {
      const mgl = (window as any).mapboxgl;
      if (!mgl) { setTimeout(tryInit, 150); return; }
      mgl.accessToken = token;
      mapRef.current = new mgl.Map({
        container: mapContainer.current!,
        style: "mapbox://styles/mapbox/dark-v11",
        center: [-80.4139, 35.5501],
        zoom: 12,
      });
      mapRef.current!.on("load", () => setMapReady(true));
    };
    tryInit();
    return () => { mapRef.current?.remove(); mapRef.current = null; };
  }, [config?.token]);

  // Update markers when pings change
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const currentIds = new Set(pings.map(p => p.repId));
    // Remove stale markers
    markersRef.current.forEach((marker, repId) => {
      if (!currentIds.has(repId)) { marker.remove(); markersRef.current.delete(repId); }
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
        markersRef.current.get(ping.repId).setLngLat([ping.lng, ping.lat]);
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

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Live Field Map</h1>
          <p className="text-sm text-muted-foreground">Real-time rep locations · updates every 60 seconds</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Clocked in reps count */}
          {isManager && (
            <Badge className={pings.length > 0 ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : "bg-secondary text-muted-foreground border-border"}>
              <Radio className="w-3 h-3 mr-1" /> {pings.length} active
            </Badge>
          )}
          {/* Rep tracking toggle */}
          {!isManager && (
            tracking ? (
              <Button size="sm" variant="outline" onClick={stopTracking} className="border-red-500/30 text-red-400 hover:bg-red-500/10" data-testid="button-stop-tracking">
                Stop Sharing Location
              </Button>
            ) : (
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-white" onClick={startTracking} data-testid="button-start-tracking" disabled={!clockStatus?.clockedIn}>
                <Navigation className="w-4 h-4 mr-2" />
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
              {!mapReady && (
                <div className="h-full flex items-center justify-center">
                  <Skeleton className="w-full h-full bg-secondary" />
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Rep list */}
          {isManager && (
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
                  <Users className="w-4 h-4 text-primary" /> Reps in Field
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-3 space-y-2">
                    {[1,2,3].map(i => <Skeleton key={i} className="h-10 bg-secondary" />)}
                  </div>
                ) : pings.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-3 pb-3">No active reps</p>
                ) : (
                  <div className="divide-y divide-border">
                    {pings.map(p => (
                      <div key={p.repId}
                        className="px-3 py-2.5 flex items-center gap-2 cursor-pointer hover:bg-secondary/50 transition-colors"
                        onClick={() => mapRef.current?.flyTo({ center: [p.lng, p.lat], zoom: 15 })}
                        data-testid={`rep-ping-${p.repId}`}
                      >
                        <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                          {p.repName.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-white font-medium truncate">{p.repName}</p>
                          <p className="text-xs text-muted-foreground">{timeAgo(p.pingAt)}</p>
                        </div>
                        <div className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                      </div>
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
                  <Clock className="w-4 h-4 text-primary" />
                  <span className="text-sm text-white font-medium">Field Status</span>
                </div>
                <div className="space-y-1">
                  <Badge className={clockStatus?.clockedIn ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : "bg-secondary text-muted-foreground border-border"}>
                    {clockStatus?.clockedIn ? "Clocked In" : "Clocked Out"}
                  </Badge>
                  {tracking && (
                    <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 ml-2">
                      <Radio className="w-3 h-3 mr-1 animate-pulse" /> Sharing Location
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
                <MapPin className="w-4 h-4 text-primary" />
                <span className="text-xs text-white font-medium">Map Legend</span>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded-full bg-primary border-2 border-white" />
                  <span className="text-xs text-muted-foreground">Active rep</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-emerald-400" />
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
