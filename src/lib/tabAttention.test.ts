// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderBadgedFavicon = vi.hoisted(() => vi.fn<(href: string) => Promise<string | null>>());
vi.mock("@/lib/faviconBadge", () => ({ renderBadgedFavicon }));

const BADGE = "data:image/png;base64,BADGED";

/** A fresh module, since the render cache lives for the life of the page. */
async function loadTabAttention() {
  vi.resetModules();
  return await import("./tabAttention");
}

function iconHrefs(): string[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
    .map((link) => link.href);
}

function absolute(path: string): string {
  return new URL(path, location.href).href;
}

/** Drain the microtask queue the deferred badge application runs on. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("browser tab attention", () => {
  let visibility: DocumentVisibilityState;
  let focused: boolean;

  beforeEach(() => {
    document.head.innerHTML = `
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      <link rel="icon" type="image/png" sizes="256x256" href="/favicon.png" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    `;
    document.title = "Armada"; // after the head reset, which drops <title>
    visibility = "hidden";
    focused = false;
    renderBadgedFavicon.mockReset();
    renderBadgedFavicon.mockResolvedValue(BADGE);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("badges the favicon of an inactive tab, and never the title", async () => {
    const { markTabAttention } = await loadTabAttention();

    expect(markTabAttention()).toBe(true);
    await vi.waitFor(() => expect(iconHrefs()).toEqual([BADGE]));

    expect(document.title).toBe("Armada");
    // The SVG icon is the one rasterized; the apple-touch-icon isn't an icon
    // link and is left in place.
    expect(renderBadgedFavicon).toHaveBeenCalledWith(absolute("/favicon.svg"));
    expect(document.querySelector('link[rel="apple-touch-icon"]')).not.toBeNull();
  });

  it("does not badge the tab the user is viewing", async () => {
    const { markTabAttention } = await loadTabAttention();
    visibility = "visible";
    focused = true;

    expect(markTabAttention()).toBe(false);
    await flush();

    expect(renderBadgedFavicon).not.toHaveBeenCalled();
    expect(iconHrefs()).toEqual([absolute("/favicon.svg"), absolute("/favicon.png")]);
  });

  it("rasterizes once for a burst of messages", async () => {
    const { markTabAttention } = await loadTabAttention();

    markTabAttention();
    markTabAttention();
    await vi.waitFor(() => expect(iconHrefs()).toEqual([BADGE]));
    markTabAttention();
    await flush();

    expect(renderBadgedFavicon).toHaveBeenCalledTimes(1);
    expect(iconHrefs()).toEqual([BADGE]);
  });

  it("restores the icons only when the tab is visible and focused", async () => {
    const { installTabAttentionClearHandlers, markTabAttention } = await loadTabAttention();
    const uninstall = installTabAttentionClearHandlers();

    markTabAttention();
    await vi.waitFor(() => expect(iconHrefs()).toEqual([BADGE]));

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(iconHrefs()).toEqual([BADGE]);

    focused = true;
    window.dispatchEvent(new Event("focus"));
    expect(iconHrefs()).toEqual([absolute("/favicon.svg"), absolute("/favicon.png")]);

    uninstall();
  });

  it("does not badge a tab the user returned to while it was rendering", async () => {
    let resolveRender: (href: string) => void = () => {};
    renderBadgedFavicon.mockReturnValue(new Promise((resolve) => { resolveRender = resolve; }));
    const { clearTabAttention, markTabAttention } = await loadTabAttention();

    markTabAttention();
    clearTabAttention();
    resolveRender(BADGE);
    await flush();

    expect(iconHrefs()).toEqual([absolute("/favicon.svg"), absolute("/favicon.png")]);
  });

  it("leaves the favicon alone, and stops retrying, when it can't be rendered", async () => {
    renderBadgedFavicon.mockResolvedValue(null);
    const { markTabAttention } = await loadTabAttention();

    markTabAttention();
    await flush();
    markTabAttention();
    await flush();

    expect(renderBadgedFavicon).toHaveBeenCalledTimes(1);
    expect(document.title).toBe("Armada");
    expect(iconHrefs()).toEqual([absolute("/favicon.svg"), absolute("/favicon.png")]);
  });
});
