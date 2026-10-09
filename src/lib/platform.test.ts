import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `LINK_PREVIEW_ENDPOINT` is read from `window.ENV` at module load, so each
 * case stubs it and re-imports the module rather than calling a setter.
 */
async function loadLinkPreviewUrl(endpoint?: string) {
  if (endpoint === undefined) {
    vi.unstubAllGlobals();
  } else {
    vi.stubGlobal("window", { ENV: { LINK_PREVIEW_ENDPOINT: endpoint } });
  }
  vi.resetModules();
  const { linkPreviewUrl } = await import("./platform");
  return linkPreviewUrl;
}

describe("linkPreviewUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("defaults to the public proxy when unconfigured", async () => {
    const linkPreviewUrl = await loadLinkPreviewUrl();
    expect(linkPreviewUrl("https://example.com/a")).toBe(
      "https://api.ditto.pub/link-preview/https%3A%2F%2Fexample.com%2Fa",
    );
  });

  it("substitutes the encoded URL for the {url} placeholder", async () => {
    const linkPreviewUrl = await loadLinkPreviewUrl("https://unfurl.test/api/{url}/preview");
    expect(linkPreviewUrl("https://example.com/a?b=c")).toBe(
      "https://unfurl.test/api/https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc/preview",
    );
  });

  it("appends the encoded URL when there is no placeholder", async () => {
    const linkPreviewUrl = await loadLinkPreviewUrl("https://unfurl.test/oembed?url=");
    expect(linkPreviewUrl("https://example.com/a")).toBe(
      "https://unfurl.test/oembed?url=https%3A%2F%2Fexample.com%2Fa",
    );
  });

  it("returns null when set empty, disabling generic previews", async () => {
    const linkPreviewUrl = await loadLinkPreviewUrl("   ");
    expect(linkPreviewUrl("https://example.com/a")).toBeNull();
  });
});

describe("RELAYS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load(value?: string) {
    if (value !== undefined) vi.stubGlobal("window", { ENV: { RELAYS: value } });
    vi.resetModules();
    const [platform, { RELEASE_RELAYS }, { STOCK_RELAYS }] = await Promise.all([
      import("./platform"),
      import("./releases"),
      import("@/concord/lib/stockRelays"),
    ]);
    return { ...platform, RELEASE_RELAYS, STOCK_RELAYS };
  }

  it("leaves Armada's public relays and the stock set when unset", async () => {
    const relays = await load();
    expect(relays.APP_RELAYS).toEqual([
      "wss://relay.ditto.pub",
      "wss://relay.dreamith.to",
      "wss://jskitty.com/nostr",
      "wss://asia.vectorapp.io/nostr",
    ]);
    expect(relays.SEARCH_RELAYS).toEqual(["wss://relay.ditto.pub", "wss://relay.dreamith.to"]);
    expect(relays.COMMUNITY_RELAYS).toEqual(relays.STOCK_RELAYS);
    expect(relays.RESCUE_RELAYS).toEqual(relays.STOCK_RELAYS);
    expect(relays.BROADCAST_RELAYS).toEqual(["wss://relay.primal.net"]);
    expect(relays.RELAY_LIST_DISCOVERY_RELAYS).not.toEqual([]);
    expect(relays.GIT_ANNOUNCEMENT_DISCOVERY_RELAY).toBe("wss://index.ngit.dev");
  });

  it("counts empty as unset", async () => {
    const relays = await load(" ");
    expect(relays.APP_RELAYS).toContain("wss://relay.ditto.pub");
    expect(relays.RESCUE_RELAYS).toEqual(relays.STOCK_RELAYS);
  });

  it("is every relay default when set, with no helper relays", async () => {
    const relays = await load("wss://armada.example.com/, relay.ditto.pub");
    const own = ["wss://armada.example.com", "wss://relay.ditto.pub"];
    expect(relays.APP_RELAYS).toEqual(own);
    expect(relays.SEARCH_RELAYS).toEqual(own);
    expect(relays.COMMUNITY_RELAYS).toEqual(own);
    expect(relays.RESCUE_RELAYS).toEqual(own);
    expect(relays.RELEASE_RELAYS).toEqual(own);
    expect(relays.BROADCAST_RELAYS).toEqual([]);
    expect(relays.RELAY_LIST_DISCOVERY_RELAYS).toEqual([]);
    expect(relays.GIT_ANNOUNCEMENT_DISCOVERY_RELAY).toBe("");
  });

  it("leaves the stock set itself alone, for the invite codec", async () => {
    const { STOCK_RELAYS } = await load("wss://armada.example.com");
    expect(STOCK_RELAYS).toContain("wss://jskitty.com/nostr");
  });
});
