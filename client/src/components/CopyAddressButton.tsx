// ── CopyAddressButton — one-tap copy of a full address ────────────────────────
// Reusable; used on the lead card and the tap-a-house sheet. Shows a brief
// "Copied" confirmation inline (and a toast) so the rep knows it worked.
import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function CopyAddressButton({ text, label = "Copy", className = "h-11 text-[13px]" }: {
  text: string;
  label?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        // Fallback for non-secure contexts / older iOS webviews.
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
      }
      setCopied(true);
      toast({ title: "Address copied", description: text });
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ title: "Couldn't copy", description: "Copy the address manually.", variant: "destructive" });
    }
  }, [text, toast]);

  return (
    <button
      type="button"
      onClick={onCopy}
      data-testid="copy-address"
      aria-label={`Copy address ${text}`}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-secondary/40 px-3 font-medium text-foreground transition-colors hover:bg-secondary active:scale-[0.98] ${className}`}
    >
      {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
      {copied ? "Copied" : label}
    </button>
  );
}
