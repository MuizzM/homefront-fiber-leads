import { useEffect, useRef, useState } from "react";
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
  async function requestCode(): Promise<{ code: string | null; emailDelivered: boolean }> {
    const res = await apiFetch("/api/auth/otp/request", { email: email.trim().toLowerCase() });
    const data = await res.json();
    if (res.status === 429) throw new Error(data.error);
    // Owner's call for this internal tool: tell the rep plainly instead of a
    // neutral "if registered…" message — the endpoint stays rate-limited per
    // IP AND per email, so this can't be used to probe addresses in bulk.
    if (res.status === 404) throw new Error("This email isn't registered. Contact your manager to get access.");
    if (!res.ok) throw new Error(data.error ?? "Something went wrong");
    const code = typeof data.developmentCode === "string" && /^\d{6}$/.test(data.developmentCode)
      ? data.developmentCode
      : null;
    // emailDelivered===false → the code was generated but the mail provider was down
    // (e.g. daily-quota). We still advance to code entry so a code obtained another
    // way works; the toast tells the user the email may not arrive.
    return { code, emailDelivered: data.emailDelivered !== false };
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    try {
      const { code: developmentCode, emailDelivered } = await requestCode();
      setStep("code");
      if (developmentCode) setCode(developmentCode);
      setResendIn(30);
      toast({ title: developmentCode ? "Local sign-in code filled in — tap Verify & sign in."
        : emailDelivered ? "Code sent — check your email."
        : "Code created, but email is delayed — ask your manager for it.",
        ...(emailDelivered ? {} : { variant: "destructive" as const }) });
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
      const { code: developmentCode, emailDelivered } = await requestCode();
      setCode(developmentCode ?? "");
      setResendIn(30);
      toast({ title: developmentCode ? "New local code filled in — tap Verify & sign in."
        : emailDelivered ? "New code sent — check your email."
        : "New code created, but email is delayed — ask your manager for it.",
        ...(emailDelivered ? {} : { variant: "destructive" as const }) });
    } catch (err: any) {
      toast({ title: err.message || "Something went wrong", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  // Verify a specific code — called by the form submit AND by auto-submit the
  // moment the 6th digit lands (a passcode UX should never need a second tap).
  async function verify(codeToUse: string) {
    if (codeToUse.length < 6 || loading) return;
    setLoading(true);
    // The code is only WRONG when the server rejected it (401/400). A 429 or a
    // 5xx (the server is briefly busy) says nothing about the digits the rep
    // just read off their phone — wiping the boxes there makes them re-type a
    // perfectly good code to retry.
    let codeStillGood = false;
    try {
      const res = await apiFetch("/api/auth/otp/verify", {
        email: email.trim().toLowerCase(),
        code: codeToUse.trim(),
      });
      // Set BEFORE parsing: a 502 from the proxy has an HTML body, so res.json()
      // itself throws, and that is exactly a case where the code is still good.
      codeStillGood = res.status === 429 || res.status >= 500;
      const data = await res.json();
      if (res.status === 429) throw new Error(data.error);
      if (!res.ok) throw new Error(data.error ?? "Invalid code");
      login(data.sessionId, data.user);
    } catch (err: any) {
      toast({ title: err.message || "Invalid code", variant: "destructive" });
      if (!codeStillGood) setCode(""); // wrong code → clear the boxes so they can retype cleanly
    } finally {
      setLoading(false);
    }
  }
  function handleCodeSubmit(e: React.FormEvent) { e.preventDefault(); verify(code); }

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

        {/* Card — refined layered elevation + a hairline ring so it reads as a
            crisp raised surface on both the dark ink and light grounds. */}
        <div className="rounded-2xl border border-border bg-card p-8 shadow-xl shadow-black/25 ring-1 ring-border/50">
          {/* Brand */}
          <div className="mb-8 text-center">
            {/* This is the LCP element of every unauthenticated load, and the
                session id lives in sessionStorage — so a PWA relaunch lands
                here too. It used to point at hfs-logo-full.png: 420x512 and
                209 KB, rendered into an ~66x80 CSS px box, i.e. ~4% of the
                shipped pixels were used. hfs-logo-login.webp is the same mark
                at 200x244 (3x the rendered box) for 21 KB. hfs-logo-full.png
                stays in public/ — server/onboardingPdf.ts embeds it in
                generated PDFs, where the full resolution is the point.
                width/height carry the real aspect so the box is reserved
                correctly; the h-20 class still decides the rendered size. */}
            <img
              src="/hfs-logo-login.webp"
              alt="Home Front Solutions"
              className="mx-auto mb-5 h-20 w-auto object-contain"
              width={200}
              height={244}
              fetchPriority="high"
              decoding="async"
            />
            <h1 className="text-[1.35rem] font-semibold tracking-tight text-foreground">Home Front Solutions</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">Field Sales Intelligence</p>
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
                  ? (<><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Sending code…</>)
                  : (<>Continue <ArrowRight className="h-4 w-4" aria-hidden /></>)}
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
                <label className="block text-sm font-medium text-foreground">
                  Verification code
                </label>
                <CodeBoxes value={code} onChange={setCode} onComplete={verify} disabled={loading} />
                <div className="flex items-center justify-between pt-1">
                  <p className="text-xs text-muted-foreground">Expires in 10 minutes.</p>
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resendIn > 0 || loading}
                    data-testid="button-resend-code"
                    className="inline-flex items-center min-h-11 px-2 -mx-2 text-xs font-medium text-primary transition-colors hover:text-primary/80 disabled:pointer-events-none disabled:text-muted-foreground/60"
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
                className="inline-flex w-[calc(100%+1rem)] items-center justify-center gap-1.5 min-h-11 px-2 -mx-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
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

// ── Segmented 6-digit passcode input (Slack / 1Password pattern) ──────────────
// Six boxes with auto-advance, backspace-to-previous, arrow nav, full-code paste,
// and auto-submit on the last digit. Numeric keyboard + one-time-code autofill.
function CodeBoxes({ value, onChange, onComplete, disabled }: {
  value: string; onChange: (v: string) => void; onComplete: (v: string) => void; disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const chars = Array.from({ length: 6 }, (_, i) => value[i] ?? "");
  const focusBox = (i: number) => refs.current[Math.max(0, Math.min(5, i))]?.focus();

  useEffect(() => { focusBox(0); }, []); // land focus on the first box

  function setAt(i: number, digit: string) {
    const arr = Array.from({ length: 6 }, (_, k) => value[k] ?? "");
    arr[i] = digit;
    const next = arr.join("").replace(/\s/g, "");
    onChange(next);
    if (digit && i < 5) focusBox(i + 1);
    if (next.replace(/\D/g, "").length === 6) onComplete(next.slice(0, 6));
  }
  function onKey(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      if (!chars[i] && i > 0) { e.preventDefault(); focusBox(i - 1); setAt(i - 1, ""); }
      else setAt(i, "");
    } else if (e.key === "ArrowLeft" && i > 0) focusBox(i - 1);
    else if (e.key === "ArrowRight" && i < 5) focusBox(i + 1);
  }
  function onPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const d = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!d) return;
    onChange(d);
    focusBox(Math.min(d.length, 5));
    if (d.length === 6) onComplete(d);
  }
  return (
    <div className="flex gap-2 justify-between" onPaste={onPaste}>
      {chars.map((c, i) => (
        <input
          key={i}
          ref={el => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={c}
          disabled={disabled}
          onChange={e => setAt(i, e.target.value.replace(/\D/g, "").slice(-1))}
          onKeyDown={e => onKey(i, e)}
          onFocus={e => e.currentTarget.select()}
          aria-label={`Digit ${i + 1} of 6`}
          data-testid={`code-box-${i}`}
          className="h-14 w-full min-w-0 rounded-xl border border-input bg-background text-center text-2xl font-semibold tabular-nums text-foreground transition-colors focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
      ))}
    </div>
  );
}
