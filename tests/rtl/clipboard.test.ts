// The copy contract, pinned. Every failure mode here was live in the app:
// a fallback whose return value was ignored (so the UI claimed a copy that
// never happened), a WebKit-hostile `readonly` textarea, and a bare
// navigator.clipboard call with no fallback at all.
import { describe, it, expect, vi, afterEach } from "vitest";
import { copyText, legacyCopy } from "@/lib/clipboard";

function stubClipboard(value: any) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

afterEach(() => {
  stubClipboard(undefined);
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the Clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    await expect(copyText("148 Maple St")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("148 Maple St");
  });

  it("falls back to execCommand when the Clipboard API is absent (plain http)", async () => {
    stubClipboard(undefined);
    const copied: string[] = [];
    const exec = vi.fn((cmd: string) => {
      if (cmd === "copy") copied.push((document.activeElement as HTMLTextAreaElement).value);
      return true;
    });
    (document as any).execCommand = exec;
    await expect(copyText("148 Maple St")).resolves.toBe(true);
    expect(copied).toEqual(["148 Maple St"]);
  });

  it("falls back when the Clipboard API REJECTS (permissions policy, lost focus)", async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });
    const exec = vi.fn(() => true);
    (document as any).execCommand = exec;
    await expect(copyText("148 Maple St")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  // THE bug: the old CopyAddressButton ignored what the fallback returned and
  // toasted "Address copied" regardless, so a rep pasted a stale address.
  it("reports FALSE when every path fails - it never claims a copy it did not make", async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error("nope")) });
    (document as any).execCommand = vi.fn(() => false);
    await expect(copyText("148 Maple St")).resolves.toBe(false);
  });

  it("reports FALSE when execCommand does not exist at all", async () => {
    stubClipboard(undefined);
    (document as any).execCommand = undefined;
    await expect(copyText("148 Maple St")).resolves.toBe(false);
  });

  it("empty text is not a copy", async () => {
    const writeText = vi.fn();
    stubClipboard({ writeText });
    await expect(copyText("")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("legacyCopy - the WebKit specifics", () => {
  // iOS Safari refuses to select the contents of a `readonly` field for a copy.
  // The shipped fallback set readonly and called .select(), which is why it was
  // a silent no-op on iPhones exactly when it was the only path left.
  it("the scratch field is NOT readonly and IS contentEditable", () => {
    let seen: { readOnly: boolean; contentEditable: string; selStart: number; selEnd: number } | null = null;
    (document as any).execCommand = vi.fn(() => {
      const ta = document.activeElement as HTMLTextAreaElement;
      seen = {
        readOnly: ta.readOnly,
        contentEditable: ta.contentEditable,
        selStart: ta.selectionStart ?? -1,
        selEnd: ta.selectionEnd ?? -1,
      };
      return true;
    });
    expect(legacyCopy("148 Maple St")).toBe(true);
    expect(seen).toMatchObject({ readOnly: false, contentEditable: "true", selStart: 0, selEnd: 12 });
  });

  it("leaves no scratch node behind, on success or failure", () => {
    (document as any).execCommand = vi.fn(() => true);
    legacyCopy("a");
    (document as any).execCommand = vi.fn(() => { throw new Error("boom"); });
    expect(legacyCopy("b")).toBe(false);
    expect(document.querySelectorAll("textarea[aria-hidden='true']")).toHaveLength(0);
  });

  it("restores focus to whatever the rep was using", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    (document as any).execCommand = vi.fn(() => true);
    legacyCopy("148 Maple St");
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});
