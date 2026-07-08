import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Mail, ShieldCheck } from "lucide-react";

const API_BASE = ("__PORT_5000__" as string).startsWith("__") ? "" : "__PORT_5000__";

async function apiFetch(path: string, body: object) {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Step = "email" | "code";

export default function Login() {
  const { login } = useAuth();
  const { toast } = useToast();
  const [step, setStep]     = useState<Step>("email");
  const [email, setEmail]   = useState("");
  const [code, setCode]     = useState("");
  const [loading, setLoading] = useState(false);

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    try {
      const res = await apiFetch("/api/auth/otp/request", { email: email.trim().toLowerCase() });
      const data = await res.json();
      if (res.status === 429) throw new Error(data.error);
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setStep("code");
      toast({ title: "Code sent — check your email." });
    } catch (err: any) {
      toast({ title: err.message || "Something went wrong", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length < 6) return;
    setLoading(true);
    try {
      const res = await apiFetch("/api/auth/otp/verify", {
        email: email.trim().toLowerCase(),
        code: code.trim(),
      });
      const data = await res.json();
      if (res.status === 429) throw new Error(data.error);
      if (!res.ok) throw new Error(data.error ?? "Invalid code");
      login(data.sessionId, data.user);
    } catch (err: any) {
      toast({ title: err.message || "Invalid code", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: "linear-gradient(160deg, #061624 0%, #0F2A44 60%, #0a2035 100%)" }}
    >
      {/* Background glow blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[300px] rounded-full opacity-[0.07]"
          style={{ background: "#3EA394", filter: "blur(90px)" }} />
      </div>

      <div className="relative w-full max-w-[380px]">

        {/* Card */}
        <div
          className="rounded-2xl p-8 shadow-2xl"
          style={{
            background: "rgba(10,32,53,0.9)",
            border: "1px solid rgba(62,163,148,0.2)",
            backdropFilter: "blur(16px)",
          }}
        >
          {/* Brand logo */}
          <div className="text-center mb-8">
            <img
              src="/hfs-logo-full.png"
              alt="Home Front Solutions"
              className="mx-auto mb-3 h-24 w-auto object-contain drop-shadow-lg"
              width={120}
              height={120}
            />
            <h1 className="text-xl font-bold text-white tracking-tight">Home Front Solutions</h1>
            <p className="text-xs mt-1 font-medium tracking-[0.2em] uppercase" style={{ color: "#3EA394" }}>
              Direct to your door
            </p>
          </div>

          {/* Step: email entry */}
          {step === "email" && (
            <form onSubmit={handleEmailSubmit} className="space-y-5">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "#CBD4DD" }}>
                  Work Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "#5A6B76" }} />
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@email.com"
                    required
                    autoComplete="email"
                    autoFocus
                    data-testid="input-email"
                    className="w-full pl-9 pr-4 py-2.5 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none transition-all"
                    style={{
                      background: "rgba(6,22,36,0.8)",
                      border: "1px solid rgba(62,163,148,0.25)",
                    }}
                    onFocus={e => (e.target.style.borderColor = "#3EA394")}
                    onBlur={e => (e.target.style.borderColor = "rgba(62,163,148,0.25)")}
                  />
                </div>
                <p className="text-xs mt-2" style={{ color: "#5A6B76" }}>
                  We'll send a one-time code to this address.
                </p>
              </div>

              <button
                type="submit"
                disabled={loading || !email.trim()}
                data-testid="button-send-code"
                className="w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                style={{
                  background: loading ? "rgba(62,163,148,0.5)" : "linear-gradient(135deg, #3EA394, #5FB8A5)",
                  color: "white",
                  boxShadow: "0 4px 20px rgba(62,163,148,0.25)",
                }}
              >
                {loading ? "Sending…" : (<>Send Login Code <ArrowRight className="w-4 h-4" /></>)}
              </button>
            </form>
          )}

          {/* Step: code entry */}
          {step === "code" && (
            <form onSubmit={handleCodeSubmit} className="space-y-5">
              <div className="text-center space-y-1 mb-2">
                <div
                  className="w-10 h-10 rounded-full mx-auto flex items-center justify-center mb-3"
                  style={{ background: "rgba(62,163,148,0.15)", border: "1px solid rgba(62,163,148,0.3)" }}
                >
                  <ShieldCheck className="w-5 h-5" style={{ color: "#3EA394" }} />
                </div>
                <p className="text-sm text-white font-medium">Check your email</p>
                <p className="text-xs" style={{ color: "#8A96A0" }}>
                  Sent to <span className="text-white font-medium">{email}</span>
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "#CBD4DD" }}>
                  6-Digit Code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  data-testid="input-code"
                  autoFocus
                  className="w-full text-center text-2xl font-bold rounded-lg py-3 text-white focus:outline-none tracking-[0.4em] transition-all"
                  style={{
                    background: "rgba(6,22,36,0.8)",
                    border: "1px solid rgba(62,163,148,0.25)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                  onFocus={e => (e.target.style.borderColor = "#3EA394")}
                  onBlur={e => (e.target.style.borderColor = "rgba(62,163,148,0.25)")}
                  required
                />
                <p className="text-xs mt-2" style={{ color: "#5A6B76" }}>
                  Expires in 10 minutes. Do not share this code.
                </p>
              </div>

              <button
                type="submit"
                disabled={loading || code.length < 6}
                data-testid="button-verify-code"
                className="w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                style={{
                  background: loading ? "rgba(62,163,148,0.5)" : "linear-gradient(135deg, #3EA394, #5FB8A5)",
                  color: "white",
                  boxShadow: "0 4px 20px rgba(62,163,148,0.25)",
                }}
              >
                {loading ? "Verifying…" : (<><ShieldCheck className="w-4 h-4" /> Verify & Sign In</>)}
              </button>

              <button
                type="button"
                onClick={() => { setStep("email"); setCode(""); }}
                className="w-full text-xs text-center transition-colors"
                style={{ color: "#5A6B76" }}
              >
                ← Use a different email
              </button>
            </form>
          )}
        </div>

        {/* Footer */}
        <div className="text-center mt-5">
          <p className="text-xs" style={{ color: "#5A6B76" }}>
            Home Front Solutions · Team access only
          </p>
        </div>
      </div>
    </div>
  );
}
