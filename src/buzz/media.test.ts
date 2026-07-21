import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getBuzzMediaHostsVersion,
  isBuzzMediaUrl,
  registerBuzzMediaHost,
  resolveBuzzMediaObjectURL,
  setBuzzMediaSigner,
} from "@/buzz/media";

import type { NostrSigner } from "@nostrify/nostrify";

const HOST = "soapbox.communities.buzz.xyz";
const HASH = "ac4cd98a18dc9810c1ae281381c710d6f48e0cd1fae3272c3f2e3cffadb3889a";
const MEDIA_URL = `https://${HOST}/media/${HASH}.png`;

describe("isBuzzMediaUrl", () => {
  it("is false for a media URL on an unregistered host", () => {
    expect(isBuzzMediaUrl("https://unknown.example/media/" + HASH + ".png")).toBe(false);
  });

  it("is true for a media blob on a registered host, false for other paths", () => {
    registerBuzzMediaHost(`wss://${HOST}`);
    expect(isBuzzMediaUrl(MEDIA_URL)).toBe(true);
    expect(isBuzzMediaUrl(`https://${HOST}/media/${HASH}.thumb.jpg`)).toBe(true);
    expect(isBuzzMediaUrl(`https://${HOST}/media/${HASH}`)).toBe(true);
    // Non-media paths and non-hex names are not treated as Buzz media.
    expect(isBuzzMediaUrl(`https://${HOST}/other/${HASH}.png`)).toBe(false);
    expect(isBuzzMediaUrl(`https://${HOST}/media/not-a-hash.png`)).toBe(false);
  });

  it("registers from a ws/http URL so the http media host matches", () => {
    registerBuzzMediaHost(`https://reg-http.buzz.example/`);
    expect(isBuzzMediaUrl(`wss://reg-http.buzz.example`)).toBe(false); // not a media path
    expect(isBuzzMediaUrl(`https://reg-http.buzz.example/media/${HASH}.png`)).toBe(true);
  });

  it("bumps the hosts version only when a new host is added", () => {
    const before = getBuzzMediaHostsVersion();
    registerBuzzMediaHost(`wss://${HOST}`); // already registered above
    expect(getBuzzMediaHostsVersion()).toBe(before);
    registerBuzzMediaHost(`wss://fresh-host.buzz.example`);
    expect(getBuzzMediaHostsVersion()).toBe(before + 1);
  });

  it("handles undefined / unparseable input", () => {
    expect(isBuzzMediaUrl(undefined)).toBe(false);
    expect(isBuzzMediaUrl("not a url")).toBe(false);
  });
});

describe("resolveBuzzMediaObjectURL", () => {
  const signEvent = vi.fn(async (t: { kind: number; content: string; created_at: number; tags: string[][] }) => ({
    ...t,
    id: "00".repeat(32),
    pubkey: "11".repeat(32),
    sig: "22".repeat(64),
  }));

  const signer = {
    getPublicKey: async () => "11".repeat(32),
    signEvent,
  } as unknown as NostrSigner;

  beforeEach(() => {
    signEvent.mockClear();
    registerBuzzMediaHost(`wss://${HOST}`);
    setBuzzMediaSigner(signer);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 })),
    );
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:mock" }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setBuzzMediaSigner(undefined);
  });

  it("fetches with a signed BUD-11 GET header scoped to the host", async () => {
    const url = `https://${HOST}/media/${"a".repeat(64)}.png`;
    const objectUrl = await resolveBuzzMediaObjectURL(url);
    expect(objectUrl).toBe("blob:mock");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const auth: string = init.headers.Authorization;
    expect(auth.startsWith("Nostr ")).toBe(true);

    const event = JSON.parse(atob(auth.slice("Nostr ".length)));
    expect(event.kind).toBe(24242);
    expect(event.tags).toContainEqual(["t", "get"]);
    expect(event.tags).toContainEqual(["server", HOST]);
    expect(event.tags.some((t: string[]) => t[0] === "expiration")).toBe(true);
    expect(event.content.trim().length).toBeGreaterThan(0);
  });

  it("rejects when there is no signer", async () => {
    setBuzzMediaSigner(undefined);
    await expect(
      resolveBuzzMediaObjectURL(`https://${HOST}/media/${"b".repeat(64)}.png`),
    ).rejects.toThrow();
  });
});
