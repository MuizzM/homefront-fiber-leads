import { useEffect, useRef, useState } from "react";
import { useAuth, type AuthUser } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Loader2 } from "lucide-react";
import { InstallAppBanner } from "@/components/InstallAppBanner";
import { ApiError, NetworkError, throwIfResNotOk } from "@/lib/queryClient";
import { withRequestDeadline } from "@/lib/requestDeadline";

const API_BASE = ("__PORT_5000__" as string).startsWith("__") ? "" : "__PORT_5000__";

interface LoginResponse {
  developmentCode?: string;
  emailDelivered?: boolean;
  sessionId?: string;
  user?: AuthUser;
}

async function apiFetch(path: string, body: { email: string; code?: string }): Promise<LoginResponse> {
  return withRequestDeadline(async signal => {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method: "POST", signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) { throw error instanceof TypeError ? new NetworkError(error) : error; }
    await throwIfResNotOk(res);
    try { return await res.json(); }
    catch { throw new Error("Sign-in is temporarily unavailable. Please try again."); }
  }, 20_000);
}

type Step = "email" | "code";

function useCooldown(): [number, (seconds: number) => void] {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!until) return;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (at >= until) setUntil(0);
    };
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [until]);
  return [Math.max(0, Math.ceil((until - now) / 1000)), seconds => {
    const at = Date.now();
    setNow(at);
    setUntil(seconds > 0 ? at + seconds * 1000 : 0);
  }];
}

export default function Login() {
  const { login } = useAuth();
  const { toast } = useToast();
  const [step, setStep]     = useState<Step>("email");
  const [email, setEmail]   = useState("");
  const [code, setCode]     = useState("");
  const [loading, setLoading] = useState(false);
  const [resendIn, setResendIn] = useCooldown(); // seconds until "Resend code" re-enables
  const [retryIn, setRetryIn] = useCooldown();
  const pending = useRef(false);
  // Inline, announced error — the toast alone was invisible to screen readers
  // (no live region near the field) and easy to miss on a phone in sunlight.
  const [formError, setFormError] = useState<string | null>(null);

  function showError(error: unknown) {
    const message = error instanceof Error ? error.message : "Sign-in is temporarily unavailable. Please try again.";
    if (error instanceof ApiError && error.status === 429) {
      setRetryIn(Math.max(1, Math.ceil((error.retryAfterMs ?? 30_000) / 1000)));
    }
    setFormError(message);
    toast({ title: message, variant: "destructive" });
  }

  // Request (or re-request) a one-time code for the entered email. Throws with a
  // user-facing message on any non-OK response.
  async function requestCode(): Promise<{ code: string | null; emailDelivered: boolean }> {
    const data = await apiFetch("/api/auth/otp/request", { email: email.trim().toLowerCase() });
    const code = typeof data.developmentCode === "string" && /^\d{6}$/.test(data.developmentCode)
      ? data.developmentCode
      : null;
    // emailDelivered===false → the code was generated but the mail provider was down
    // (e.g. daily quota). Keep the resend path available after its cooldown.
    return { code, emailDelivered: data.emailDelivered !== false };
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || pending.current || retryIn > 0) return;
    pending.current = true;
    setLoading(true);
    setFormError(null);
    try {
      const { code: developmentCode, emailDelivered } = await requestCode();
      setStep("code");
      if (developmentCode) setCode(developmentCode);
      setResendIn(30);
      toast({ title: developmentCode ? "Local sign-in code filled in - tap Verify & sign in."
        : emailDelivered ? "Code requested - check your email."
        : "Email delivery is delayed. Wait a moment, then request a new code.",
        ...(emailDelivered ? {} : { variant: "destructive" as const }) });
    } catch (error) {
      showError(error);
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendIn > 0 || pending.current || retryIn > 0) return;
    pending.current = true;
    setLoading(true);
    try {
      const { code: developmentCode, emailDelivered } = await requestCode();
      setCode(developmentCode ?? "");
      setFormError(null); // a fresh code invalidates the old "Invalid code"
      setResendIn(30);
      toast({ title: developmentCode ? "New local code filled in - tap Verify & sign in."
        : emailDelivered ? "New code requested - check your email."
        : "Email delivery is delayed. Wait a moment, then request a new code.",
        ...(emailDelivered ? {} : { variant: "destructive" as const }) });
    } catch (error) {
      showError(error);
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }

  // Verify a specific code — called by the form submit AND by auto-submit the
  // moment the 6th digit lands (a passcode UX should never need a second tap).
  async function verify(codeToUse: string) {
    if (codeToUse.length < 6 || pending.current || retryIn > 0) return;
    pending.current = true;
    setLoading(true);
    setFormError(null);
    // The code is only WRONG when the server rejected it (401/400). A 429 or a
    // 5xx (the server is briefly busy) says nothing about the digits the rep
    // just read off their phone — wiping the boxes there makes them re-type a
    // perfectly good code to retry.
    try {
      const data = await apiFetch("/api/auth/otp/verify", {
        email: email.trim().toLowerCase(),
        code: codeToUse.trim(),
      });
      if (typeof data.sessionId !== "string" || !data.sessionId || typeof data.user?.id !== "number") {
        throw new Error("Sign-in returned an incomplete response. Please try again.");
      }
      login(data.sessionId, data.user);
    } catch (error) {
      showError(error);
      // A network failure says nothing about the digits. Clear only an
      // explicitly rejected code, preserving input through offline/5xx/timeout.
      if (error instanceof ApiError && [400, 401].includes(error.status)) setCode("");
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }
  function handleCodeSubmit(e: React.FormEvent) { e.preventDefault(); setFormError(null); verify(code); }

  const inputClasses =
    "w-full rounded-lg border border-input bg-background text-foreground " +
    "placeholder:text-muted-foreground/60 transition-colors " +
    "focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";

  const buttonClasses =
    "flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground " +
    "transition-colors hover:bg-primary/90 " +
    "disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";

  return (
    <div className="login-backdrop flex min-h-dvh items-center justify-center px-5 py-10">
      <main className="w-full max-w-[400px]">

        {/* Card — refined layered elevation + a hairline ring so it reads as a
            crisp raised surface on both the dark ink and light grounds. */}
        <div className="rounded-2xl border border-border bg-card px-6 py-8 sm:px-8">
          {/* Brand */}
          <div className="mb-7 text-center">
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
              className="mx-auto mb-5 h-16 w-auto object-contain"
              width={200}
              height={244}
              // Lowercase on purpose, via spread: React 18's runtime only
              // forwards the lowercase DOM attribute (the camelCase prop warned
              // on every sign-in), while its TYPES only know camelCase — the
              // spread satisfies both until the React 19 upgrade.
              {...({ fetchpriority: "high" } as Record<string, string>)}
              decoding="async"
            />
            <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">Sign in</h1>
            <p className="mt-2 text-pretty text-sm text-muted-foreground">Use your Home Front work email to continue.</p>
          </div>

          {/* Step: email entry */}
          {step === "email" && (
            <form onSubmit={handleEmailSubmit} className="space-y-6">
              <div className="space-y-2">
                <label htmlFor="login-email" className="block text-sm font-medium text-foreground">
                  Email
                </label>
                {/* px-3, not pl-9: the leading icon this padding reserved space
                    for was removed, leaving the placeholder pushed off-center. */}
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  disabled={loading}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  required
                  autoComplete="email"
                  autoFocus
                  data-testid="input-email"
                  className={`h-11 px-3 text-base sm:text-sm ${inputClasses}`}
                />
              </div>

              {formError && (
                <p role="alert" className="text-sm text-destructive" data-testid="login-error">{formError}</p>
              )}

              <button
                type="submit"
                disabled={loading || !email.trim() || retryIn > 0}
                data-testid="button-send-code"
                className={buttonClasses}
              >
                {loading
                  ? (<><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Sending code…</>)
                  : retryIn > 0 ? `Try again in ${retryIn}s`
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
                  A 6-digit code was requested for{" "}
                  <span className="font-medium text-foreground">{email}</span>.
                </p>
                <p className="text-xs text-muted-foreground">If your email is registered, check your inbox and spam folder. Delivery can take a moment.</p>
              </div>

              <div className="space-y-2">
                <label id="otp-label" className="block text-sm font-medium text-foreground">
                  Verification code
                </label>
                {/* role=group + aria-labelledby ties the six digit boxes to the
                    label above — it previously labelled nothing. */}
                <div role="group" aria-labelledby="otp-label">
                  <CodeBoxes value={code} onChange={setCode} onComplete={verify} disabled={loading} />
                </div>
                <div className="flex items-center justify-between pt-1">
                  <p className="text-xs text-muted-foreground">Expires in 10 minutes.</p>
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resendIn > 0 || loading || retryIn > 0}
                    data-testid="button-resend-code"
                    className="inline-flex items-center min-h-11 px-2 -mx-2 text-xs font-medium text-primary transition-colors hover:text-primary/80 disabled:pointer-events-none disabled:text-muted-foreground/60"
                  >
                    {retryIn > 0 ? `Try again in ${retryIn}s` : resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                  </button>
                </div>
              </div>

              {formError && (
                <p role="alert" className="text-sm text-destructive" data-testid="login-code-error">{formError}</p>
              )}

              <button
                type="submit"
                disabled={loading || code.length < 6 || retryIn > 0}
                data-testid="button-verify-code"
                className={buttonClasses}
              >
                {loading
                  ? (<><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Verifying…</>)
                  : retryIn > 0 ? `Try again in ${retryIn}s`
                  : (<>Verify &amp; sign in <ArrowRight className="h-4 w-4" aria-hidden /></>)}
              </button>

              <button
                type="button"
                disabled={loading}
                onClick={() => { setStep("email"); setCode(""); setResendIn(0); setFormError(null); }}
                className="inline-flex w-full items-center justify-center gap-1.5 min-h-11 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Use a different email
              </button>
            </form>
          )}
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-muted-foreground/70">
          © {new Date().getFullYear()} Home Front Solutions
        </p>
      </main>

      {/* The install ask belongs on THIS side of the door. PushSetupCard makes
          the same case on Today, but a rep only reaches Today after signing in,
          and on iPhone there are no notifications at all until the app is on
          the Home Screen. Renders nothing when already installed or when the
          device has no install path to offer. */}
      <InstallAppBanner />
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

  // Land focus on box 0 on mount AND whenever the code is cleared - after a
  // wrong code the parent resets value to "", and without this the (blurred,
  // because disabled during verify) focus never returns, stranding the rep.
  useEffect(() => { if (!value) focusBox(0); }, [value]);

  function setAt(i: number, digit: string) {
    const arr = Array.from({ length: 6 }, (_, k) => value[k] ?? "");
    arr[i] = digit;
    const next = arr.join("").replace(/\s/g, "");
    onChange(next);
    if (digit && i < 5) focusBox(i + 1);
    if (next.replace(/\D/g, "").length === 6) onComplete(next.slice(0, 6));
  }
  // One box's onChange. A single digit types normally (onFocus selects the box,
  // so typing over an existing digit still arrives as one char). Two-or-more
  // digits means the OS one-time-code autofill dumped the whole code into one
  // box - spread it across the boxes instead of keeping only the last digit.
  function onInput(i: number, raw: string) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length <= 1) { setAt(i, digits); return; }
    const arr = Array.from({ length: 6 }, (_, k) => value[k] ?? "");
    for (let k = 0; k < digits.length && i + k < 6; k++) arr[i + k] = digits[k];
    const next = arr.join("");
    onChange(next);
    focusBox(Math.min(i + digits.length, 5));
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
          onChange={e => onInput(i, e.target.value)}
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
