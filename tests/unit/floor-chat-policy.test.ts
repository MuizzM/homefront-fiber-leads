// The floor chat's pure rules — the validator the send button and the API
// share, and the grouping/label helpers the pane renders from. Pinned here
// because the two sides must never disagree about what sends, and because the
// grouping rule ("one header per run of messages") is the kind of thing a
// refactor breaks without noticing.
import { describe, expect, it } from "vitest";
import {
  validateChatMessage, startsNewGroup, chatDayLabel, chatInitials,
  dmPairKey, validateGroupName, dmDisplayName,
  CHAT_GROUP_GAP_MS, FLOOR_CHAT_MESSAGE_MAX, GROUP_NAME_MAX,
} from "../../shared/floorChat";

describe("validateChatMessage", () => {
  it("accepts a normal message and trims it", () => {
    expect(validateChatMessage("  morning floor  ")).toEqual({ ok: true, body: "morning floor" });
  });

  it("rejects non-strings and empty strings", () => {
    expect(validateChatMessage(undefined).ok).toBe(false);
    expect(validateChatMessage(42 as any).ok).toBe(false);
    expect(validateChatMessage("").ok).toBe(false);
    expect(validateChatMessage("   \n  ").ok).toBe(false);
  });

  it("accepts exactly the max and rejects one past it", () => {
    expect(validateChatMessage("x".repeat(FLOOR_CHAT_MESSAGE_MAX)).ok).toBe(true);
    const over = validateChatMessage("x".repeat(FLOOR_CHAT_MESSAGE_MAX + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(String(FLOOR_CHAT_MESSAGE_MAX));
  });

  it("measures the TRIMMED length — padding cannot push a valid message over", () => {
    const padded = `  ${"x".repeat(FLOOR_CHAT_MESSAGE_MAX)}  `;
    expect(validateChatMessage(padded).ok).toBe(true);
  });
});

describe("startsNewGroup", () => {
  const at = (authorUserId: number, createdAtMs: number) => ({ authorUserId, createdAtMs });

  it("first message always starts a group", () => {
    expect(startsNewGroup(null, at(1, 1000))).toBe(true);
    expect(startsNewGroup(undefined, at(1, 1000))).toBe(true);
  });

  it("same author inside the gap continues the run", () => {
    expect(startsNewGroup(at(1, 1000), at(1, 1000 + CHAT_GROUP_GAP_MS))).toBe(false);
  });

  it("a different author breaks the run, whatever the gap", () => {
    expect(startsNewGroup(at(1, 1000), at(2, 1001))).toBe(true);
  });

  it("silence past the gap breaks the run even for the same author", () => {
    expect(startsNewGroup(at(1, 1000), at(1, 1000 + CHAT_GROUP_GAP_MS + 1))).toBe(true);
  });
});

describe("chatDayLabel", () => {
  // Noon-anchored so the day math cannot straddle midnight in any zone.
  const noon = new Date(2026, 7, 5, 12, 0, 0).getTime();

  it("labels the separators a reader expects", () => {
    expect(chatDayLabel(noon, noon)).toBe("Today");
    expect(chatDayLabel(noon - 24 * 3_600_000, noon)).toBe("Yesterday");
    expect(chatDayLabel(noon - 3 * 24 * 3_600_000, noon)).toMatch(/^\w{3}, \w{3} \d{1,2}$/);
  });
});

describe("chatInitials", () => {
  it("takes first and last, uppercased", () => {
    expect(chatInitials("Marcus T.")).toBe("MT");
    expect(chatInitials("cher")).toBe("C");
    expect(chatInitials("")).toBe("?");
    expect(chatInitials(null)).toBe("?");
  });
});

describe("dmPairKey", () => {
  it("is order-independent — 'message Bo' from either side is one room", () => {
    expect(dmPairKey(7, 3)).toBe(dmPairKey(3, 7));
    expect(dmPairKey(3, 7)).toBe("dm:3:7");
  });
});

describe("validateGroupName", () => {
  it("trims, requires something, and caps the length", () => {
    expect(validateGroupName("  Lexington crew ")).toEqual({ ok: true, name: "Lexington crew" });
    expect(validateGroupName("   ").ok).toBe(false);
    expect(validateGroupName(undefined).ok).toBe(false);
    expect(validateGroupName("x".repeat(GROUP_NAME_MAX + 1)).ok).toBe(false);
    expect(validateGroupName("x".repeat(GROUP_NAME_MAX)).ok).toBe(true);
  });
});

describe("dmDisplayName", () => {
  const members = [
    { userId: 5, memberId: 10, name: "Saad Q." },
    { userId: 7, memberId: 14, name: "Zargham M." },
  ];
  it("names the DM after the OTHER person", () => {
    expect(dmDisplayName(members, 5)).toBe("Zargham M.");
    expect(dmDisplayName(members, 7)).toBe("Saad Q.");
  });
});
