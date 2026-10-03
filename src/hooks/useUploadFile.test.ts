import { afterEach, describe, expect, it, vi } from "vitest";

import { mirrorToServers, repairDoubledScheme, uploadToServers } from "./useUploadFile";

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";

describe("repairDoubledScheme", () => {
  it("collapses a doubled scheme with the second colon missing", () => {
    expect(
      repairDoubledScheme("https://https//blossom.dreamith.to/3c25.png"),
    ).toBe("https://blossom.dreamith.to/3c25.png");
  });

  it("collapses a doubled scheme with the second colon intact", () => {
    expect(
      repairDoubledScheme("https://https://blossom.dreamith.to/3c25.png"),
    ).toBe("https://blossom.dreamith.to/3c25.png");
  });

  it("collapses a doubled http scheme", () => {
    expect(repairDoubledScheme("http://http//host/x")).toBe("http://host/x");
  });

  it("normalizes the surviving scheme to lowercase", () => {
    expect(repairDoubledScheme("HTTPS://HTTPS//host/x")).toBe("https://host/x");
  });

  it("leaves a well-formed URL untouched", () => {
    expect(repairDoubledScheme("https://blossom.dreamith.to/3c25.png")).toBe(
      "https://blossom.dreamith.to/3c25.png",
    );
  });

  it("does not touch a host that merely starts with the scheme name", () => {
    expect(repairDoubledScheme("https://httpsworld.example/x")).toBe(
      "https://httpsworld.example/x",
    );
  });
});

/**
 * BUD-04 mirroring, checked against what a conforming server actually
 * validates (BUD-11): a `PUT /mirror` per target server carrying `{url}`, with
 * a kind-24242 token whose verb is `upload` (there is no `mirror` verb), whose
 * `x` tag names the blob, encoded as base64url. A token missing any of those
 * is a 403 from a server that has the blob's origin perfectly reachable —
 * which is how Armada's earlier hand-built `t=mirror` event failed.
 */
describe("mirrorToServers", () => {
  const HASH = "c".repeat(64);
  const SOURCE = `https://blossom.dreamith.to/${HASH}.png`;
  const PUBKEY = "e".repeat(64);

  const signer: NostrSigner = {
    getPublicKey: async () => PUBKEY,
    signEvent: async (t) => ({ ...t, pubkey: PUBKEY, id: "f".repeat(64), sig: "0".repeat(128) }) as NostrEvent,
  };

  /** The event out of a `Nostr <base64url>` header. */
  function tokenOf(headers: HeadersInit | undefined): NostrEvent {
    const auth = new Headers(headers).get("authorization") ?? "";
    expect(auth.startsWith("Nostr ")).toBe(true);
    const b64 = auth.slice(6);
    // Base64url, unpadded (BUD-11) — this is the encoding blossom.primal.net
    // is known to reject on /upload, and the one the spec requires.
    expect(b64).not.toMatch(/[+/=]/);
    return JSON.parse(atob(b64.replace(/-/g, "+").replace(/_/g, "/")));
  }

  afterEach(() => vi.unstubAllGlobals());

  it("sends one PUT /mirror per server with a BUD-11 upload token naming the blob", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      new Response(JSON.stringify({ url: `${new URL(String(input)).origin}/${HASH}.png`, sha256: HASH, size: 3 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await mirrorToServers(SOURCE, ["https://a.example/", "https://b.example/"], signer);

    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      method: init?.method,
      body: JSON.parse(String(init?.body)),
      token: tokenOf(init?.headers),
    }));
    expect(calls.map((c) => c.url)).toEqual(["https://a.example/mirror", "https://b.example/mirror"]);
    for (const c of calls) {
      expect(c.method).toBe("PUT");
      expect(c.body).toEqual({ url: SOURCE });
      expect(c.token.kind).toBe(24242);
      expect(c.token.tags).toContainEqual(["t", "upload"]);
      expect(c.token.tags).toContainEqual(["x", HASH]);
      expect(c.token.tags.some(([name]) => name === "expiration")).toBe(true);
    }
  });

  it("keeps going when one server rejects, and never throws", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith("https://a.example")
        ? new Response(null, { status: 502 })
        : new Response(JSON.stringify({ url: `https://b.example/${HASH}.png`, sha256: HASH, size: 3 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mirrorToServers(SOURCE, ["https://a.example/", "https://b.example/"], signer),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://a.example/mirror",
      "https://b.example/mirror",
    ]);
  });
});

/**
 * Which server's URL an upload embeds: the preferred one's whenever it takes
 * the blob, however slow, with the others that already hold it as NIP-94
 * `fallback`s, and a `PUT /mirror` only for servers whose PUT failed.
 */
describe("uploadToServers", () => {
  const PUBKEY = "e".repeat(64);
  const signer: NostrSigner = {
    getPublicKey: async () => PUBKEY,
    signEvent: vi.fn(async (t) => ({ ...t, pubkey: PUBKEY, id: "f".repeat(64), sig: "0".repeat(128) }) as NostrEvent),
  };
  const file = () => new File(["hello"], "note.txt", { type: "text/plain" });
  const HASH = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

  type Behaviour = { status?: number; delay?: number; error?: boolean }[];

  /** A fetch whose answers, per origin and per call, follow `plan`. */
  function stubServers(plan: Record<string, Behaviour>) {
    const calls: string[] = [];
    const seen: Record<string, number> = {};
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.origin}${url.pathname}`);
      const n = seen[url.origin] = (seen[url.origin] ?? 0) + 1;
      const step = url.pathname === "/mirror" ? {} : (plan[url.origin]?.[n - 1] ?? {});
      if (step.delay) await new Promise((resolve) => setTimeout(resolve, step.delay));
      if (step.error) throw new TypeError("network down");
      if (step.status && step.status >= 400) {
        return new Response("nope", { status: step.status, headers: { "x-reason": `refused by ${url.host}` } });
      }
      return new Response(JSON.stringify({ url: `${url.origin}/${HASH}`, sha256: HASH, size: 5 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

  afterEach(() => vi.unstubAllGlobals());

  it("embeds the preferred server's URL even when another answers first", async () => {
    stubServers({ "https://pref.example": [{ delay: 30 }] });
    const tags = await uploadToServers(file(), ["https://pref.example/", "https://other.example/"], signer, {
      preferred: "https://pref.example/",
    });
    expect(tags[0]).toEqual(["url", `https://pref.example/${HASH}.txt`]);
    expect(tags).toContainEqual(["fallback", `https://other.example/${HASH}.txt`]);
  });

  it("signs one token for every server", async () => {
    stubServers({});
    vi.mocked(signer.signEvent).mockClear();
    await uploadToServers(file(), ["https://a.example/", "https://b.example/"], signer);
    expect(signer.signEvent).toHaveBeenCalledTimes(1);
  });

  it("falls back at once when the preferred server refuses the blob", async () => {
    const calls = stubServers({ "https://pref.example": [{ status: 415 }] });
    const tags = await uploadToServers(file(), ["https://pref.example/", "https://other.example/"], signer, {
      preferred: "https://pref.example/",
    });
    await flush();
    expect(tags[0]).toEqual(["url", `https://other.example/${HASH}.txt`]);
    expect(tags.some(([name]) => name === "fallback")).toBe(false);
    // Neither retried nor mirrored to: it would refuse again.
    expect(calls.filter((c) => c.startsWith("https://pref.example"))).toEqual(["https://pref.example/upload"]);
  });

  it("retries the preferred server once after a transient failure", async () => {
    stubServers({ "https://pref.example": [{ status: 503 }, {}] });
    const tags = await uploadToServers(file(), ["https://pref.example/", "https://other.example/"], signer, {
      preferred: "https://pref.example/",
    });
    expect(tags[0]).toEqual(["url", `https://pref.example/${HASH}.txt`]);
  });

  it("mirrors to a server whose PUT failed in transit", async () => {
    const calls = stubServers({ "https://flaky.example": [{ error: true }] });
    const tags = await uploadToServers(file(), ["https://a.example/", "https://flaky.example/"], signer, {
      preferred: "https://a.example/",
    });
    await flush();
    expect(tags[0]).toEqual(["url", `https://a.example/${HASH}.txt`]);
    expect(calls).toContain("https://flaky.example/mirror");
    expect(calls).not.toContain("https://a.example/mirror");
  });

  it("takes the first to answer without a preference", async () => {
    stubServers({ "https://a.example": [{ delay: 30 }] });
    const tags = await uploadToServers(file(), ["https://a.example/", "https://b.example/"], signer);
    expect(tags[0]).toEqual(["url", `https://b.example/${HASH}.txt`]);
  });

  it("reports every server's reason when all fail", async () => {
    stubServers({ "https://a.example": [{ status: 413 }], "https://b.example": [{ status: 415 }] });
    const failure = await uploadToServers(file(), ["https://a.example/", "https://b.example/"], signer, {
      preferred: "https://a.example/",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "Blossom request failed (413): refused by a.example",
      "Blossom request failed (415): refused by b.example",
    ]);
  });
});
