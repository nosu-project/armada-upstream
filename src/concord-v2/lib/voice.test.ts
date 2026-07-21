import { verifyEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { voiceGroupKey } from "@/concord-v2/lib/derive";
import { KIND_VOICE_PRESENCE } from "@/concord-v2/lib/kinds";
import type { OpenedEvent } from "@/concord-v2/lib/stream";
import {
  brokerRank,
  canonicalOrigin,
  foldVoicePresence,
  KIND_HTTP_AUTH,
  orderBrokers,
  parsePresence,
  parseReaction,
  presenceTags,
  reactionTag,
  rendezvousCandidates,
  signAvGrant,
  verifiedAuthorOf,
  VOICE_STALE_MS,
  type VoicePresenceEntry,
} from "@/concord-v2/lib/voice";

const A = new Uint8Array(32).fill(1);
const B = new Uint8Array(32).fill(2);

describe("canonicalOrigin (RFC 6454, §5)", () => {
  it("lowercases, strips default port / path / trailing slash", () => {
    expect(canonicalOrigin("https://Broker.Example")).toBe("https://broker.example");
    expect(canonicalOrigin("https://broker.example/")).toBe("https://broker.example");
    expect(canonicalOrigin("https://broker.example:443/x/y?z")).toBe("https://broker.example");
    expect(canonicalOrigin("https://broker.example:8443")).toBe("https://broker.example:8443");
  });

  it("refuses non-https and malformed input", () => {
    expect(canonicalOrigin("http://broker.example")).toBeNull();
    expect(canonicalOrigin("wss://broker.example")).toBeNull();
    expect(canonicalOrigin("not a url")).toBeNull();
    expect(canonicalOrigin("https://user:pw@broker.example")).toBeNull();
  });
});

describe("broker tie-break (§5)", () => {
  const room = "ab".repeat(32);

  it("is deterministic and binds the room", () => {
    expect(brokerRank(room, "https://a.example")).toBe(brokerRank(room, "https://a.example"));
    expect(brokerRank("cd".repeat(32), "https://a.example")).not.toBe(brokerRank(room, "https://a.example"));
  });

  it("orders canonicalized, deduped origins by rank", () => {
    const ordered = orderBrokers(room, [
      "https://A.example/",
      "https://b.example",
      "https://a.example",
      "http://c.example", // refused: not https
    ]);
    expect(ordered).toHaveLength(2);
    expect([...ordered].sort((x, y) => (brokerRank(room, x) < brokerRank(room, y) ? -1 : 1))).toEqual(ordered);
  });
});

describe("token grant (§2)", () => {
  it("self-signs a kind-27235 event whose pubkey IS the room name", () => {
    const voice = voiceGroupKey(A, B, 0);
    const url = `https://broker.example/.well-known/concord/av/${voice.pk}`;
    const event = JSON.parse(atob(signAvGrant(voice, url)));
    expect(event.kind).toBe(KIND_HTTP_AUTH);
    expect(event.pubkey).toBe(voice.pk);
    expect(event.tags).toContainEqual(["u", url]);
    expect(event.tags).toContainEqual(["method", "GET"]);
    expect(verifyEvent(event)).toBe(true);
  });
});

// ── Presence (§4) ────────────────────────────────────────────────────────────

function openedPresence(overrides: Partial<OpenedEvent>): OpenedEvent {
  return {
    rumorId: "r".repeat(64),
    author: "a".repeat(64),
    kind: KIND_VOICE_PRESENCE,
    content: "joined",
    tags: [["identity", "id-1"], ["broker", "https://b.example"]],
    ms: 1_000_000,
    createdAt: 1000,
    wrapId: "w".repeat(64),
    streamPk: "s".repeat(64),
    sealKind: 20013,
    seal: {} as OpenedEvent["seal"],
    ...overrides,
  };
}

describe("parsePresence (§4)", () => {
  it("parses a joined with identity + canonicalized broker", () => {
    const p = parsePresence(openedPresence({}));
    expect(p).toEqual({
      author: "a".repeat(64),
      status: "joined",
      identity: "id-1",
      broker: "https://b.example",
      hand: false,
      ms: 1_000_000,
      rumorId: "r".repeat(64),
    });
  });

  it("reads the raised-hand tag (client extension) only while joined", () => {
    const withHand = openedPresence({
      tags: [["identity", "id-1"], ["broker", "https://b.example"], ["hand", "1"]],
    });
    expect(parsePresence(withHand)?.hand).toBe(true);
    // Absent tag → hand down; a `left` never carries a raised hand.
    expect(parsePresence(openedPresence({}))?.hand).toBe(false);
    expect(parsePresence(openedPresence({ content: "left", tags: [["hand", "1"]] }))?.hand).toBe(false);
  });

  it("parses a left (identity and broker omitted)", () => {
    const p = parsePresence(openedPresence({ content: "left", tags: [] }));
    expect(p?.status).toBe("left");
    expect(p?.identity).toBeUndefined();
  });

  it("drops malformed entries: wrong kind, unknown verb, joined without identity", () => {
    expect(parsePresence(openedPresence({ kind: 23311 }))).toBeNull();
    expect(parsePresence(openedPresence({ content: "join" }))).toBeNull();
    expect(parsePresence(openedPresence({ tags: [] }))).toBeNull();
  });
});

describe("presence tags (client extensions)", () => {
  it("emits the hand tag only for a raised, joined member", () => {
    expect(presenceTags("joined", "id-1", "https://b.example", { hand: true })).toContainEqual(["hand", "1"]);
    expect(presenceTags("joined", "id-1", "https://b.example", { hand: false })).not.toContainEqual(["hand", "1"]);
    // A `left` never advertises a hand.
    expect(presenceTags("left", undefined, undefined, { hand: true })).not.toContainEqual(["hand", "1"]);
  });

  it("builds a react tag as [react, emoji, nonce]", () => {
    expect(reactionTag("🎉", "n1")).toEqual(["react", "🎉", "n1"]);
  });
});

describe("parseReaction (client extension)", () => {
  it("extracts a valid reaction, ignoring plain heartbeats", () => {
    const r = parseReaction(openedPresence({ tags: [["identity", "id-1"], ["react", "🎉", "n1"]] }));
    expect(r).toEqual({ author: "a".repeat(64), emoji: "🎉", nonce: "n1", ms: 1_000_000 });
    // No react tag → not a reaction.
    expect(parseReaction(openedPresence({}))).toBeNull();
  });

  it("rejects malformed reactions: wrong kind, missing nonce, oversize emoji", () => {
    expect(parseReaction(openedPresence({ kind: 23311, tags: [["react", "🎉", "n1"]] }))).toBeNull();
    expect(parseReaction(openedPresence({ tags: [["react", "🎉"]] }))).toBeNull();
    expect(parseReaction(openedPresence({ tags: [["react", "x".repeat(65), "n1"]] }))).toBeNull();
  });
});

describe("foldVoicePresence (§4)", () => {
  const now = 10_000_000;
  const entry = (o: Partial<VoicePresenceEntry>): VoicePresenceEntry => ({
    author: "a".repeat(64),
    status: "joined",
    identity: "id-1",
    broker: "https://b.example",
    ms: now - 1000,
    rumorId: "r1",
    ...o,
  });

  it("per author the latest wins; a left clears presence", () => {
    const fold = foldVoicePresence(
      [entry({ ms: now - 5000 }), entry({ status: "left", identity: undefined, ms: now - 1000 })],
      now,
    );
    expect(fold.present).toHaveLength(0);
  });

  it("a stale joined (three missed heartbeats) counts as absent", () => {
    const fold = foldVoicePresence([entry({ ms: now - VOICE_STALE_MS - 1 })], now);
    expect(fold.present).toHaveLength(0);
    expect(foldVoicePresence([entry({ ms: now - VOICE_STALE_MS + 1000 })], now).present).toHaveLength(1);
  });

  it("verifies an identity only when exactly one author claims it", () => {
    const contested = foldVoicePresence(
      [entry({}), entry({ author: "b".repeat(64), rumorId: "r2" })],
      now,
    );
    expect(verifiedAuthorOf(contested, "id-1")).toBeUndefined();

    const sole = foldVoicePresence([entry({})], now);
    expect(verifiedAuthorOf(sole, "id-1")).toBe("a".repeat(64));
    expect(verifiedAuthorOf(sole, "unclaimed")).toBeUndefined();
  });
});

describe("rendezvous (§5)", () => {
  const room = "ab".repeat(32);
  const now = 10_000_000;

  it("prefers occupied brokers (tie-break ordered), then own defaults", () => {
    const fold = foldVoicePresence(
      [
        {
          author: "a".repeat(64),
          status: "joined",
          identity: "id-1",
          broker: "https://x.example",
          ms: now - 1000,
          rumorId: "r1",
        },
      ],
      now,
    );
    const candidates = rendezvousCandidates(room, fold, ["https://own.example"]);
    expect(candidates[0]).toBe("https://x.example");
    expect(candidates).toContain("https://own.example");
  });

  it("an empty room falls back to the defaults in their stated order", () => {
    const fold = foldVoicePresence([], now);
    expect(rendezvousCandidates(room, fold, ["https://one.example", "https://two.example"])).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
  });
});
