// ── clipboard.ts — the ONE way this app copies text ──────────────────────────
//
// Every copy control in the app routes through copyText(). Three rules, each
// paid for by a bug a rep hit at a door:
//
// 1. HONEST RESULT. copyText resolves to true only when a path actually
//    reported success. CopyAddressButton used to ignore its fallback's return
//    value and toast "Address copied" unconditionally - so on any device where
//    the copy failed, the rep was told it had worked and pasted the PREVIOUS
//    address into their notes.
//
// 2. CALL writeText SYNCHRONOUSLY. The Clipboard API needs transient user
//    activation. Awaiting anything before writeText (a fetch, a state settle)
//    spends the activation and the write is rejected. copyText must therefore
//    be the FIRST await in a click handler - never behind one.
//
// 3. A FALLBACK THAT WORKS IN WEBKIT. The classic textarea + .select() +
//    execCommand recipe is a no-op in some iOS Safari versions when the
//    textarea is `readonly`: WebKit wants a real Range and setSelectionRange.
//    The fallback below does both, so it degrades correctly on plain http (a
//    LAN dev box) and in in-app browsers that withhold the Clipboard API.
//
// tests/rtl/clipboard.test.ts pins all three, and
// tests/unit/clipboard-single-seam.test.ts stops a fourth copy path from being
// hand-rolled somewhere else.

/**
 * Copy `text`, reporting honestly whether it landed.
 *
 * MUST be called inside a user gesture (a click/tap handler) and must not be
 * placed after another `await` - both spend the activation the Clipboard API
 * requires. Never throws: a caller can branch on the boolean alone.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  // The modern path. Secure contexts only, which is why the fallback below is
  // not dead code: `navigator.clipboard` is undefined on plain http.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Rejected - permissions policy, an in-app browser, a document that lost
    // focus mid-gesture. Fall through rather than reporting a copy we did not make.
  }

  return legacyCopy(text);
}

/**
 * document.execCommand("copy") against a throwaway field, written the way
 * WebKit needs it. Exported for the tests that pin the WebKit specifics.
 */
export function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const active = document.activeElement as HTMLElement | null;
  let ta: HTMLTextAreaElement | null = null;
  try {
    ta = document.createElement("textarea");
    ta.value = text;
    // NOT `readonly`: WebKit refuses to select the contents of a readonly field
    // for a copy, which is the exact shape of the fallback that silently did
    // nothing on iPhones. contentEditable is what makes the selection stick.
    ta.contentEditable = "true";
    ta.readOnly = false;
    ta.setAttribute("aria-hidden", "true");
    ta.tabIndex = -1;
    // font-size 16px keeps iOS from zooming the viewport if it ever paints;
    // 1x1 + fixed keeps it off-screen without `display:none`, which would make
    // the field unselectable.
    ta.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;" +
      "margin:0;outline:0;box-shadow:none;background:transparent;font-size:16px;opacity:0;";
    document.body.appendChild(ta);

    const selection = document.getSelection();
    const saved = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    const range = document.createRange();
    range.selectNodeContents(ta);
    selection?.removeAllRanges();
    selection?.addRange(range);
    ta.setSelectionRange(0, text.length);
    ta.focus({ preventScroll: true });

    const ok = document.execCommand("copy") === true;

    // Put the page back the way it was: leaving our range selected would show
    // the rep a phantom selection, and stealing focus would drop the keyboard.
    selection?.removeAllRanges();
    if (saved) selection?.addRange(saved);
    return ok;
  } catch {
    return false;
  } finally {
    ta?.remove();
    try { active?.focus?.({ preventScroll: true }); } catch { /* element went away */ }
  }
}
