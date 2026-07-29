// The links we TEXT to a customer, and everything that must not be possible
// with one.
//
// These tokens travel by SMS, so they end up in message logs, in screenshots,
// in carrier systems and link-shortener databases. The realistic attacker is
// not a cryptographer — it is the recipient of a perfectly ordinary
// "here's how to prep for your install" text, poking at their own link:
//
//   • bumping a number in it to reach the next customer's appointment
//   • editing the expiry so the link keeps working
//   • replaying the harmless prep link against the confirm-install endpoint
//   • pasting back a link a carrier chopped in half
//
// Every describe block below is one of those attempts failing. The expiry and
// purpose tests matter most: an expiry outside the signature is not an expiry,
// and a purpose outside the signature turns the most freely-handed-out token
// into the most privileged one.
import { describe, expect, it } from "vitest";
import {
  deriveRef,
  signLink,
  verifyLink,
  type LinkPurpose,
  type SignedLinkPayload,
} from "../../shared/signedLinks";

const SECRET = "test-secret-do-not-ship-2f8b41c9aa07e5d3";
const OTHER_SECRET = "a-completely-different-secret-91c4ff20b6";

// A distinctive id, so "does this appear in the token?" cannot pass or fail by
// coincidence the way a short id like 7 would.
const INSTALL_ID = 918273645;

const NOW = 1_760_000_000; // fixed clock: expiry boundaries must be exact, not approximate

function refFor(id: string | number = INSTALL_ID): string {
  return deriveRef("installation", id, SECRET);
}

function mint(overrides: {
  purpose?: LinkPurpose;
  ttlSeconds?: number;
  now?: number;
  ref?: string;
  notBefore?: number;
  meta?: Record<string, string | number | boolean>;
  secret?: string;
} = {}): string {
  return signLink(
    {
      ref: overrides.ref ?? refFor(),
      purpose: overrides.purpose ?? "confirm-installation",
      notBefore: overrides.notBefore,
      meta: overrides.meta,
    },
    {
      secret: overrides.secret ?? SECRET,
      ttlSeconds: overrides.ttlSeconds ?? 3600,
      now: overrides.now ?? NOW,
    },
  );
}

/** Re-sign a token's body with a secret, so we can forge only what we mean to. */
function bodyOf(token: string): string {
  return token.split(".")[1];
}

function decodeBody(token: string): SignedLinkPayload {
  return JSON.parse(Buffer.from(bodyOf(token), "base64url").toString("utf8"));
}

describe("round trip", () => {
  it("returns the payload the caller signed, field for field", () => {
    const ref = refFor();
    const token = signLink(
      { ref, purpose: "view-prep-instructions", meta: { window: "8-12" } },
      { secret: SECRET, ttlSeconds: 7200, now: NOW, nonce: "fixed-nonce-abc" },
    );

    const result = verifyLink(token, {
      secret: SECRET,
      purpose: "view-prep-instructions",
      now: NOW,
    });

    expect(result).toEqual({
      valid: true,
      payload: {
        v: "v1",
        ref,
        purpose: "view-prep-instructions",
        exp: NOW + 7200,
        nonce: "fixed-nonce-abc",
        meta: { window: "8-12" },
      },
    });
  });

  it("omits optional fields rather than emitting undefined placeholders", () => {
    // Absent nbf/meta must stay absent: a null-ish nbf that parsed as 0 would
    // silently pass the not-yet-valid gate for every token.
    const payload = decodeBody(mint());
    expect(payload).not.toHaveProperty("nbf");
    expect(payload).not.toHaveProperty("meta");
  });

  it("mints a different token each time for the same record", () => {
    // The per-token nonce. Without it, two links for the same install/purpose/
    // expiry are byte-identical, so anything built later on "revoke this one
    // link" would have nothing to key on.
    expect(mint()).not.toEqual(mint());
  });
});

describe("tampering", () => {
  it("rejects a token whose payload was edited", () => {
    const token = mint();
    const forgedBody = Buffer.from(
      JSON.stringify({ ...decodeBody(token), ref: refFor(INSTALL_ID + 1) }),
      "utf8",
    ).toString("base64url");
    const forged = `v1.${forgedBody}.${token.split(".")[2]}`;

    expect(verifyLink(forged, { secret: SECRET, purpose: "confirm-installation", now: NOW }))
      .toEqual({ valid: false, reason: "bad-signature" });
  });

  it("rejects a token whose EXPIRY was pushed out", () => {
    // The whole reason exp lives inside the signed bytes. If exp were carried
    // beside the signature — a ?exp= parameter, a second segment excluded from
    // the MAC — this rewrite would succeed and the link would never die.
    const token = mint({ ttlSeconds: 60 });
    const extended = Buffer.from(
      JSON.stringify({ ...decodeBody(token), exp: NOW + 999_999 }),
      "utf8",
    ).toString("base64url");
    const forged = `v1.${extended}.${token.split(".")[2]}`;

    const result = verifyLink(forged, {
      secret: SECRET,
      purpose: "confirm-installation",
      now: NOW + 120, // past the real expiry, inside the forged one
    });
    expect(result).toEqual({ valid: false, reason: "bad-signature" });
  });

  it("rejects a flipped bit in the signature without leaking which bit", () => {
    // Flip the FIRST character, not the last.
    //
    // A 32-byte HMAC is 43 base64url characters: 43 × 6 = 258 bits carrying 256
    // significant ones, so the FINAL character holds only 4 significant bits and
    // its low 2 bits are padding the decoder throws away. Swapping that last
    // char between "A" (000000) and "B" (000001) therefore changes nothing at
    // all — it decodes to a byte-identical signature, verifies correctly, and
    // this test fails. It flaked rather than failed outright only because the
    // nonce is random, so the last character differs per run.
    //
    // A flaky security test is worse than a missing one: it teaches people to
    // re-run until green. The first character carries six significant bits, so
    // changing it always changes the signature.
    const token = mint();
    const sig = token.split(".")[2];
    const flipped = `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    expect(verifyLink(`v1.${bodyOf(token)}.${flipped}`, {
      secret: SECRET,
      purpose: "confirm-installation",
      now: NOW,
    })).toEqual({ valid: false, reason: "bad-signature" });
  });

  it("rejects a truncated token WITHOUT throwing", () => {
    // A carrier or a shortener chopping the tail is everyday traffic, not an
    // attack. A short signature buffer must not reach timingSafeEqual, which
    // throws on a length mismatch and would turn this into a 500.
    const token = mint();
    for (const cut of [token.slice(0, 10), token.slice(0, -5), token.slice(0, -32)]) {
      let result: ReturnType<typeof verifyLink> | undefined;
      expect(() => {
        result = verifyLink(cut, { secret: SECRET, purpose: "confirm-installation", now: NOW });
      }).not.toThrow();
      expect(result!.valid).toBe(false);
    }
  });

  it("rejects garbage, empty and structurally wrong input without throwing", () => {
    for (const junk of ["", "....", "v1.only-two", "v2.abc.def", "not a token at all", "v1..x"]) {
      expect(() =>
        verifyLink(junk, { secret: SECRET, purpose: "confirm-installation", now: NOW }),
      ).not.toThrow();
      expect(
        verifyLink(junk, { secret: SECRET, purpose: "confirm-installation", now: NOW }).valid,
      ).toBe(false);
    }
  });

  it("does not accept a body padded with base64 characters it should reject", () => {
    // Lenient base64 decoding would let two different strings decode to the
    // same bytes, so a mangled link could be "repaired" into a valid one.
    const token = mint();
    expect(verifyLink(`v1.${bodyOf(token)}=.${token.split(".")[2]}`, {
      secret: SECRET,
      purpose: "confirm-installation",
      now: NOW,
    })).toEqual({ valid: false, reason: "malformed" });
  });
});

describe("expiry", () => {
  it("accepts a token one second before it expires", () => {
    // The boundary, not the comfortable middle. An off-by-one here either kills
    // links a second early or keeps them alive a second late.
    const token = mint({ ttlSeconds: 900 });
    expect(
      verifyLink(token, {
        secret: SECRET,
        purpose: "confirm-installation",
        now: NOW + 900 - 1,
      }).valid,
    ).toBe(true);
  });

  it("rejects a token AT its expiry instant — exp is exclusive", () => {
    const token = mint({ ttlSeconds: 900 });
    expect(
      verifyLink(token, { secret: SECRET, purpose: "confirm-installation", now: NOW + 900 }),
    ).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects a long-expired token", () => {
    expect(
      verifyLink(mint({ ttlSeconds: 900 }), {
        secret: SECRET,
        purpose: "confirm-installation",
        now: NOW + 86_400,
      }),
    ).toEqual({ valid: false, reason: "expired" });
  });

  it("holds a not-yet-valid token closed until its instant, then opens it", () => {
    const token = mint({ notBefore: NOW + 100, ttlSeconds: 3600 });
    expect(
      verifyLink(token, { secret: SECRET, purpose: "confirm-installation", now: NOW + 99 }),
    ).toEqual({ valid: false, reason: "not-yet-valid" });
    expect(
      verifyLink(token, { secret: SECRET, purpose: "confirm-installation", now: NOW + 100 }).valid,
    ).toBe(true);
  });

  it("refuses to mint a token with no real lifetime", () => {
    for (const ttl of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        signLink({ ref: refFor(), purpose: "contact-rep" }, {
          secret: SECRET,
          ttlSeconds: ttl,
          now: NOW,
        }),
      ).toThrow(/ttlSeconds/);
    }
  });
});

describe("purpose binding", () => {
  // The privilege-escalation case. "View prep instructions" is the link we send
  // to everyone and the one most likely to be forwarded; "confirm installation"
  // commits a customer to an appointment. Neither may stand in for the other.

  it("rejects a prep-instructions token at the confirm-installation endpoint", () => {
    const token = mint({ purpose: "view-prep-instructions" });
    expect(
      verifyLink(token, { secret: SECRET, purpose: "confirm-installation", now: NOW }),
    ).toEqual({ valid: false, reason: "purpose-mismatch" });
  });

  it("rejects a confirm-installation token at the prep-instructions endpoint", () => {
    // Asserted in BOTH directions on purpose: a one-way test passes even if the
    // check is a bug like `granted !== "confirm-installation"`.
    const token = mint({ purpose: "confirm-installation" });
    expect(
      verifyLink(token, { secret: SECRET, purpose: "view-prep-instructions", now: NOW }),
    ).toEqual({ valid: false, reason: "purpose-mismatch" });
  });

  it("keeps every purpose distinct from every other purpose", () => {
    const purposes: LinkPurpose[] = [
      "confirm-installation",
      "reschedule-installation",
      "view-prep-instructions",
      "contact-rep",
    ];
    for (const minted of purposes) {
      const token = mint({ purpose: minted });
      for (const granted of purposes) {
        const result = verifyLink(token, { secret: SECRET, purpose: granted, now: NOW });
        if (minted === granted) {
          expect(result.valid).toBe(true);
        } else {
          expect(result).toEqual({ valid: false, reason: "purpose-mismatch" });
        }
      }
    }
  });

  it("cannot be re-purposed by editing the payload — purpose is signed", () => {
    // Swapping the purpose field is the direct attack. It fails as a signature
    // failure, which is the proof that purpose is inside the MAC and not merely
    // compared afterwards.
    const token = mint({ purpose: "view-prep-instructions" });
    const escalated = Buffer.from(
      JSON.stringify({ ...decodeBody(token), purpose: "confirm-installation" }),
      "utf8",
    ).toString("base64url");

    expect(
      verifyLink(`v1.${escalated}.${token.split(".")[2]}`, {
        secret: SECRET,
        purpose: "confirm-installation",
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: "bad-signature" });
  });

  it("will not verify without the caller naming the purpose it grants", () => {
    // Making purpose mandatory is what stops a route from accepting any
    // validly-signed token regardless of what it was minted for.
    const token = mint();
    expect(() =>
      verifyLink(token, { secret: SECRET, purpose: undefined as unknown as LinkPurpose, now: NOW }),
    ).toThrow(/purpose/);
  });
});

describe("the secret", () => {
  it("rejects a token signed with a different secret", () => {
    const token = signLink(
      { ref: refFor(), purpose: "reschedule-installation" },
      { secret: OTHER_SECRET, ttlSeconds: 3600, now: NOW },
    );
    expect(
      verifyLink(token, { secret: SECRET, purpose: "reschedule-installation", now: NOW }),
    ).toEqual({ valid: false, reason: "bad-signature" });
  });

  it("refuses to SIGN without a secret", () => {
    // An empty secret is not a weak secret, it is no secret: every forgery
    // verifies. Falling back to "" or a hardcoded default must be impossible.
    for (const bad of ["", "   ", undefined, null, 0]) {
      expect(() =>
        signLink({ ref: refFor(), purpose: "contact-rep" }, {
          secret: bad as unknown as string,
          ttlSeconds: 3600,
          now: NOW,
        }),
      ).toThrow(/secret/);
    }
  });

  it("refuses to VERIFY without a secret", () => {
    const token = mint();
    for (const bad of ["", "   ", undefined, null]) {
      expect(() =>
        verifyLink(token, {
          secret: bad as unknown as string,
          purpose: "confirm-installation",
          now: NOW,
        }),
      ).toThrow(/secret/);
    }
  });

  it("refuses to verify even a garbage token without a secret", () => {
    // The refusal must come BEFORE the malformed check, or a caller with a
    // broken config sees { valid: false } and concludes their setup is fine.
    expect(() =>
      verifyLink("nonsense", { secret: "", purpose: "contact-rep", now: NOW }),
    ).toThrow(/secret/);
  });
});

describe("internal ids never reach the wire", () => {
  it("does not contain the installation id in plain or base64 form", () => {
    const token = mint();
    const id = String(INSTALL_ID);
    const encodings = [
      id,
      Buffer.from(id, "utf8").toString("base64"),
      Buffer.from(id, "utf8").toString("base64url"),
      Buffer.from(id, "utf8").toString("hex"),
      INSTALL_ID.toString(16),
    ];
    for (const form of encodings) {
      expect(token).not.toContain(form);
    }
    // And the decoded body — where a lazy implementation would stash it.
    expect(JSON.stringify(decodeBody(token))).not.toContain(id);
  });

  it("gives neighbouring ids references with nothing in common", () => {
    // Enumeration is the threat: a customer who holds their own link must not
    // be able to step to the next appointment.
    const a = refFor(INSTALL_ID);
    const b = refFor(INSTALL_ID + 1);
    expect(a).not.toEqual(b);
    expect(a.slice(0, 6)).not.toEqual(b.slice(0, 6));
  });

  it("namespaces references by record kind", () => {
    // Otherwise a reference for lead 7 unlocks installation 7.
    expect(deriveRef("installation", 7, SECRET)).not.toEqual(deriveRef("lead", 7, SECRET));
  });

  it("produces a reference nobody can derive without the secret", () => {
    expect(deriveRef("installation", INSTALL_ID, SECRET)).not.toEqual(
      deriveRef("installation", INSTALL_ID, OTHER_SECRET),
    );
  });

  it("refuses to sign a bare numeric id dressed up as a reference", () => {
    // The failure mode this module exists to prevent, caught at the one place
    // every caller passes through.
    expect(() =>
      signLink({ ref: "918273645918273645", purpose: "contact-rep" }, {
        secret: SECRET,
        ttlSeconds: 3600,
        now: NOW,
      }),
    ).toThrow(/numeric id/);
  });

  it("refuses a reference too short to be anything but an id", () => {
    for (const ref of ["4218", "abc", ""]) {
      expect(() =>
        signLink({ ref, purpose: "contact-rep" }, { secret: SECRET, ttlSeconds: 3600, now: NOW }),
      ).toThrow(/ref/);
    }
  });
});

describe("survives a text message", () => {
  it("emits no +, / or = anywhere in the token", () => {
    // Those three characters are what link shorteners and carrier rewriting
    // mangle. One mangled character makes the link a support call.
    for (let i = 0; i < 200; i++) {
      const token = signLink(
        { ref: refFor(i), purpose: "contact-rep", meta: { n: i } },
        { secret: SECRET, ttlSeconds: 3600, now: NOW },
      );
      expect(token).not.toMatch(/[+/=]/);
    }
  });

  it("emits only base64url characters and two separators", () => {
    expect(mint()).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("produces references that are themselves URL-safe", () => {
    for (let i = 0; i < 200; i++) {
      expect(deriveRef("installation", i, SECRET)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("stays within a bounded size budget", () => {
    // Not a security property — a regression alarm. The token is ~205 chars,
    // which with a domain already spills past one 160-char SMS segment, so
    // these links are expected to be shortened before sending. What this pins
    // is that nobody quietly starts stuffing fields into the payload: a token
    // that grows without bound is a token carrying data it should not.
    expect(mint().length).toBeLessThan(256);
    expect(mint({ meta: { window: "8-12", tech: "R. Alvarez" } }).length).toBeLessThan(320);
  });
});
