import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import {
  AlertTriangle, Download, CheckCircle2, Globe, Shield,
  ChevronRight, Wifi, Info, ExternalLink, Copy
} from "lucide-react";

// The deployed server URL for the app
const APP_SERVER = ("__PORT_5000__" as string).startsWith("__")
  ? window.location.origin
  : "__PORT_5000__";

export default function BrowserScanner() {
  const { user } = useAuth();
  const [copied, setCopied] = useState<string | null>(null);
  const [scannerSecret, setScannerSecret] = useState<string>("Loading...");

  const canScan = user?.role === "admin" || user?.role === "manager";

  // Fetch scanner secret from server — never hardcoded in client bundle
  useEffect(() => {
    if (!canScan) return;
    apiRequest("GET", "/api/config/scanner-secret")
      .then(r => r.json())
      .then((d: { secret: string }) => setScannerSecret(d.secret))
      .catch(() => setScannerSecret("Error loading secret"));
  }, [canScan]);

  function copyText(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  if (!canScan) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-orange-400" />
          <p className="font-medium">Manager or Admin access required</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-5 space-y-5">

      {/* Header */}
      <div>
        <h1 className="text-base font-bold text-foreground">Standalone Scanner</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Download and run the scanner directly from your computer — no Cloudflare blocks, no CORS restrictions
        </p>
      </div>

      {/* Why the in-app scanner fails */}
      <div className="rounded-2xl bg-orange-500/10 border border-orange-500/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0" />
          <p className="text-sm font-semibold text-orange-300">Why the in-app scan doesn't work</p>
        </div>
        <div className="space-y-2 text-xs text-muted-foreground leading-relaxed">
          <div className="flex gap-2">
            <span className="text-red-400 font-bold">✗</span>
            <span><span className="text-foreground font-medium">Server-side scan:</span> Kinetic's Cloudflare blocks our cloud server's IP address (Google Cloud Oregon) permanently. Every server request gets a 429 or 403.</span>
          </div>
          <div className="flex gap-2">
            <span className="text-red-400 font-bold">✗</span>
            <span><span className="text-foreground font-medium">Browser-in-app scan:</span> The app runs inside an iframe on pplx.app. When the browser tries to call buy.gokinetic.com from a different domain, the browser blocks the response — this is called CORS. Kinetic never added pplx.app to their allowed origins.</span>
          </div>
          <div className="flex gap-2">
            <span className="text-green-400 font-bold">✓</span>
            <span><span className="text-foreground font-medium">Standalone scanner (the fix):</span> An HTML file opened directly in Chrome uses <span className="italic">your home IP</span> with no cross-origin restrictions — same as Kinetic's own sales reps use. Leads are saved directly to this app.</span>
          </div>
        </div>
      </div>

      {/* Download card */}
      <div className="rounded-2xl bg-card border border-primary/30 p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center flex-shrink-0">
            <Download className="w-5 h-5 text-primary" />
          </div>
          <div>
            <p className="font-semibold text-foreground">KFS Standalone Scanner</p>
            <p className="text-xs text-muted-foreground">Single HTML file · 1,248 Rockwell addresses built-in · Saves leads here automatically</p>
          </div>
        </div>

        <a
          href="/api/scan/scanner-download"
          download="kfs-rockwell-scanner.html"
          className="flex items-center justify-center gap-2 w-full bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-bold py-3.5 rounded-xl transition-colors"
          data-testid="button-download-scanner"
        >
          <Download className="w-4 h-4" />
          Download Scanner (HTML)
        </a>
        <p className="text-xs text-muted-foreground text-center">
          Or ask your admin for the file directly
        </p>
      </div>

      {/* Setup steps */}
      <div className="rounded-2xl bg-card border border-border p-5 space-y-4">
        <p className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Info className="w-4 h-4 text-blue-400" />
          How to run it
        </p>
        <ol className="space-y-3">
          {[
            { step: "1", title: "Download the scanner file", desc: "Click the button above and save to your Desktop" },
            { step: "2", title: "Open with Chrome or Firefox", desc: "Double-click the file — open it directly, don't drag into the app" },
            { step: "3", title: "Enter your server URL", desc: "Copy the URL below and paste it into the scanner's config box" },
            { step: "4", title: "Secret key is pre-filled", desc: "The scanner already has the correct secret — don't change it" },
            { step: "5", title: "Click Start Scanning Rockwell", desc: "All 1,248 addresses scan one by one. New fiber leads save here automatically" },
          ].map(item => (
            <li key={item.step} className="flex gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                {item.step}
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{item.title}</p>
                <p className="text-xs text-muted-foreground">{item.desc}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Config values to copy */}
      <div className="rounded-2xl bg-card border border-border p-5 space-y-4">
        <p className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Shield className="w-4 h-4 text-purple-400" />
          Scanner Configuration (copy these)
        </p>

        <div className="space-y-3">
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">App Server URL</p>
            <div className="flex items-center gap-2 bg-secondary/50 rounded-xl border border-border px-3 py-2.5">
              <span className="text-xs font-mono text-foreground flex-1 truncate" data-testid="text-server-url">{APP_SERVER}</span>
              <button
                onClick={() => copyText(APP_SERVER, "url")}
                className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                data-testid="button-copy-url"
              >
                {copied === "url" ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Scanner Secret Key</p>
            <div className="flex items-center gap-2 bg-secondary/50 rounded-xl border border-border px-3 py-2.5">
              <span className="text-xs font-mono text-foreground flex-1 truncate" data-testid="text-scanner-secret">{scannerSecret}</span>
              <button
                onClick={() => copyText(scannerSecret, "secret")}
                className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                data-testid="button-copy-secret"
              >
                {copied === "secret" ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Tips */}
      <div className="rounded-2xl bg-blue-500/10 border border-blue-500/20 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Wifi className="w-4 h-4 text-blue-400" />
          <p className="text-sm font-semibold text-blue-300">Tips for best results</p>
        </div>
        <ul className="text-xs text-muted-foreground space-y-1.5 leading-relaxed">
          <li>• Run from your home Wi-Fi or phone hotspot — NOT from a VPN or data center</li>
          <li>• The scanner auto-refreshes the Kinetic token so you don't need to paste one</li>
          <li>• Scan speed is 400ms per address — 1,248 addresses takes ~10 minutes</li>
          <li>• Leads save in batches of 5 — even if you stop early, found leads are saved</li>
          <li>• If you get rate-limited, the scanner pauses 30 seconds automatically</li>
          <li>• Only saves NEW FIBER addresses where no customer exists yet</li>
        </ul>
      </div>

      {/* Lead check link */}
      <div className="flex items-center justify-between rounded-xl bg-green-500/10 border border-green-500/20 p-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <span className="text-sm text-foreground font-medium">Check your map for leads after scanning</span>
        </div>
        <a href="#/map" className="flex items-center gap-1 text-xs font-semibold text-primary bg-primary/10 px-3 py-1.5 rounded-lg hover:bg-primary/20 transition-colors">
          Open Map <ChevronRight className="w-3.5 h-3.5" />
        </a>
      </div>

    </div>
  );
}
