// ── CopyAddressButton — one-tap copy of a full address ────────────────────────
// Reusable; used on the lead card and the tap-a-house sheet. Shows a brief
// "Copied" confirmation inline (and a toast) so the rep knows it worked.
import { useState, useCallback } from "react";
import { Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { copyText } from "@/lib/clipboard";

export function CopyAddressButton({ text, label = "Copy", className = "h-11 text-[13px]" }: {
  text: string;
  label?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  // The old version ignored what the fallback returned and toasted "Address
  // copied" either way, so a phone that could not copy told the rep it had -
  // and they pasted whatever was on the clipboard before. copyText returns an
  // honest boolean; the confirmation follows it.
  const onCopy = useCallback(async () => {
    const ok = await copyText(text);
    if (!ok) {
      toast({
        title: "Couldn't copy",
        description: "The address is on screen - read it from there.",
        variant: "destructive",
      });
      return;
    }
    setCopied(true);
    toast({ title: "Address copied", description: text });
    setTimeout(() => setCopied(false), 1600);
  }, [text, toast]);

  return (
    <button
      type="button"
      onClick={onCopy}
      data-testid="copy-address"
      aria-label={`Copy address ${text}`}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-secondary/40 px-3 font-medium text-foreground transition-colors hover:bg-secondary active:scale-[0.98] ${className}`}
    >
      {copied ? <Check className="w-4 h-4 text-emerald-500" /> : null}
      {copied ? "Copied" : label}
    </button>
  );
}
