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
      "https://ditto.pub/api/link-preview/https%3A%2F%2Fexample.com%2Fa",
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

describe("COMMUNITY_RELAYS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load(value?: string) {
    if (value !== undefined) vi.stubGlobal("window", { ENV: { COMMUNITY_RELAYS: value } });
    vi.resetModules();
    const [{ COMMUNITY_RELAYS }, { STOCK_RELAYS }] = await Promise.all([
      import("./platform"),
      import("@/concord/lib/stockRelays"),
    ]);
    return { COMMUNITY_RELAYS, STOCK_RELAYS };
  }

  it("defaults to the CORD stock set, unchanged", async () => {
    const { COMMUNITY_RELAYS, STOCK_RELAYS } = await load();
    expect(COMMUNITY_RELAYS).toEqual(STOCK_RELAYS);
  });

  it("falls back to the stock set when set empty", async () => {
    const { COMMUNITY_RELAYS, STOCK_RELAYS } = await load("");
    expect(COMMUNITY_RELAYS).toEqual(STOCK_RELAYS);
  });

  it("takes a deployment's own relays", async () => {
    const { COMMUNITY_RELAYS } = await load("wss://armada.example.com/, relay.ditto.pub");
    expect(COMMUNITY_RELAYS).toEqual(["wss://armada.example.com", "wss://relay.ditto.pub"]);
  });
});
