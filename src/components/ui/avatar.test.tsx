import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppContext, type AppContextType } from "@/contexts/AppContext";

import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

/**
 * Two servers, so the walk has exactly one mirror to try before giving up.
 * No proxy, so the walk cases see the URLs as written; the policy has its own
 * case below.
 */
const contextWith = (config: Record<string, unknown>) =>
  ({
    config: {
      appBlossomServers: ["https://blossom.ditto.pub/", "https://blossom.dreamith.to/"],
      blossomServerMetadata: { servers: [], updatedAt: 0 },
      useAppBlossomServers: true,
      mediaProxy: "",
      ...config,
    },
    updateConfig: vi.fn(),
  }) as unknown as AppContextType;
const context = contextWith({});

const HASH = "d".repeat(64);

/**
 * A kind-0 picture is, for anyone who uploaded it through the app, a
 * content-addressed URL on whichever Blossom server won the upload race. When
 * that server goes down the same bytes are on the others, so the avatar walks
 * them before it degrades to the initial — and the backoff retry that already
 * existed now restarts the WALK, not the one dead URL.
 */
describe("AvatarImage cross-server fallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tree = (src: string) => (
    <AppContext.Provider value={context}>
      <Avatar>
        <AvatarImage src={src} data-testid="img" />
        <AvatarFallback data-testid="fallback">A</AvatarFallback>
      </Avatar>
    </AppContext.Provider>
  );
  const renderAvatar = (src: string) => render(tree(src));

  it("moves to the next server on error, then to the initial, then retries from the top", () => {
    renderAvatar(`https://blossom.ditto.pub/${HASH}.png`);
    const img = () => screen.getByTestId<HTMLImageElement>("img");
    expect(img().src).toBe(`https://blossom.ditto.pub/${HASH}.png`);

    fireEvent.error(img());
    expect(img().src).toBe(`https://blossom.dreamith.to/${HASH}.png`);

    // Every server failed: the <img> unmounts (the initial shows on the
    // parent's next render, as before).
    fireEvent.error(img());
    expect(screen.queryByTestId("img")).toBeNull();

    // First timed retry: 3s, from the primary again.
    act(() => vi.advanceTimersByTime(3_000));
    expect(img().src).toBe(`https://blossom.ditto.pub/${HASH}.png`);
  });

  it("gives a non-Blossom picture one attempt before the initial", () => {
    renderAvatar("https://pics.example/me.jpg");
    fireEvent.error(screen.getByTestId("img"));
    expect(screen.queryByTestId("img")).toBeNull();
  });

  it("starts the walk over when the picture changes", () => {
    const { rerender } = renderAvatar(`https://blossom.ditto.pub/${HASH}.png`);
    fireEvent.error(screen.getByTestId("img"));
    fireEvent.error(screen.getByTestId("img"));
    expect(screen.queryByTestId("img")).toBeNull();

    const other = "e".repeat(64);
    rerender(tree(`https://blossom.ditto.pub/${other}.png`));
    expect(screen.getByTestId<HTMLImageElement>("img").src).toBe(`https://blossom.ditto.pub/${other}.png`);
  });
});

/**
 * A kind-0 picture is set by whoever it names, so every avatar on screen is a
 * request to a host of THEIR choosing. With a proxy set the picture loads
 * through it; with none it loads directly.
 */
describe("AvatarImage under the media policy", () => {
  const tree = (src: string, config: Record<string, unknown>) => (
    <AppContext.Provider value={contextWith(config)}>
      <Avatar>
        <AvatarImage src={src} data-testid="img" />
        <AvatarFallback data-testid="fallback">A</AvatarFallback>
      </Avatar>
    </AppContext.Provider>
  );

  it("proxies a picture when a proxy is set", () => {
    const proxy = "https://proxy.example/?url={href}";
    render(tree("https://pics.example/me.jpg", { mediaProxy: proxy }));
    expect(screen.getByTestId<HTMLImageElement>("img").src).toBe(
      `https://proxy.example/?url=${encodeURIComponent("https://pics.example/me.jpg")}`,
    );
  });

  it("loads a picture directly when no proxy is set", () => {
    render(tree("https://pics.example/me.jpg", { mediaProxy: "" }));
    expect(screen.getByTestId<HTMLImageElement>("img").src).toBe("https://pics.example/me.jpg");
  });
});
