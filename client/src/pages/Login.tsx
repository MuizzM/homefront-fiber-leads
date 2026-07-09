import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, ArrowRight, Loader2, Mail } from "lucide-react";

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
  const [resendIn, setResendIn] = useState(0); // seconds until "Resend code" re-enables

  // Tick the resend cooldown down to zero.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn(s => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  // Request (or re-request) a one-time code for the entered email. Throws with a
  // user-facing message on any non-OK response.
  async function requestCode() {
    const res = await apiFetch("/api/auth/otp/request", { email: email.trim().toLowerCase() });
    const data = await res.json();
    if (res.status === 429) throw new Error(data.error);
    // Owner's call for this internal tool: tell the rep plainly instead of a
    // neutral "if registered…" message — the endpoint stays rate-limited per
    // IP AND per email, so this can't be used to probe addresses in bulk.
    if (res.status === 404) throw new Error("This email isn't registered. Contact your manager to get access.");
    if (!res.ok) throw new Error(data.error ?? "Something went wrong");
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    try {
      await requestCode();
      setStep("code");
      setResendIn(30);
      toast({ title: "Code sent — check your email." });
    } catch (err: any) {
      toast({ title: err.message || "Something went wrong", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendIn > 0 || loading) return;
    setLoading(true);
    try {
      await requestCode();
      setCode("");
      setResendIn(30);
      toast({ title: "New code sent — check your email." });
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

  const inputClasses =
    "w-full rounded-lg border border-input bg-background text-foreground " +
    "placeholder:text-muted-foreground/60 transition-colors " +
    "focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";

  const buttonClasses =
    "flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground " +
    "shadow-lg shadow-primary/20 transition-colors hover:bg-primary/90 " +
    "disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";

  return (
    <div className="login-backdrop min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* Card */}
        <div className="rounded-2xl border border-border bg-card p-8 shadow-2xl">
          {/* Brand */}
          <div className="mb-8 text-center">
            <img
              src="/hfs-logo-full.png"
              alt="Home Front Solutions"
              className="mx-auto mb-4 h-20 w-auto object-contain"
              width={80}
              height={80}
            />
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Home Front Solutions</h1>
            <p className="mt-1 text-sm text-muted-foreground">Field Sales Intelligence</p>
          </div>

          {/* Step: email entry */}
          {step === "email" && (
            <form onSubmit={handleEmailSubmit} className="space-y-6">
              <div className="space-y-2">
                <label htmlFor="login-email" className="block text-sm font-medium text-foreground">
                  Email
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="login-email"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@email.com"
                    required
                    autoComplete="email"
                    autoFocus
                    data-testid="input-email"
                    className={`h-11 pl-9 pr-3 text-sm ${inputClasses}`}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !email.trim()}
                data-testid="button-send-code"
                className={buttonClasses}
              >
                {loading
                  ? (<><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Logging in…</>)
                  : (<>Login <ArrowRight className="h-4 w-4" aria-hidden /></>)}
              </button>
            </form>
          )}

          {/* Step: code entry */}
          {step === "code" && (
            <form onSubmit={handleCodeSubmit} className="space-y-6">
              <div className="space-y-1.5">
                <h2 className="text-lg font-semibold tracking-tight text-foreground">Check your email</h2>
                <p className="text-sm text-muted-foreground">
                  We sent a 6-digit code to{" "}
                  <span className="font-medium text-foreground">{email}</span>.
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="login-code" className="block text-sm font-medium text-foreground">
                  Verification code
                </label>
                <input
                  id="login-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  data-testid="input-code"
                  autoFocus
                  required
                  className={`py-3 text-center text-2xl font-semibold tracking-[0.4em] tabular-nums ${inputClasses}`}
                />
                <div className="flex items-center justify-between pt-0.5">
                  <p className="text-xs text-muted-foreground">Expires in 10 minutes.</p>
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resendIn > 0 || loading}
                    data-testid="button-resend-code"
                    className="text-xs font-medium text-primary transition-colors hover:text-primary/80 disabled:pointer-events-none disabled:text-muted-foreground/60"
                  >
                    {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || code.length < 6}
                data-testid="button-verify-code"
                className={buttonClasses}
              >
                {loading
                  ? (<><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Verifying…</>)
                  : (<>Verify &amp; sign in <ArrowRight className="h-4 w-4" aria-hidden /></>)}
              </button>

              <button
                type="button"
                onClick={() => { setStep("email"); setCode(""); setResendIn(0); }}
                className="flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Use a different email
              </button>
            </form>
          )}
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-muted-foreground/70">
          © {new Date().getFullYear()} Home Front Solutions
        </p>
      </div>
    </div>
  );
}
