/**
 * The mobile member overlay (⋮ → Members) must not outlive the chat it covers.
 *
 * ConcordPage and GroupPage are far too heavy to mount, so this mounts the
 * REAL pieces that decide what happens — `useMobileMembersOverlay`,
 * `SwipeReveal` and the `useAndroidBack` stack, with the Capacitor back event
 * captured — wired the way both pages wire them.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The back listener is installed once per module (it dispatches to the
// handler stack), so this is never cleared between tests.
const backListeners: Array<() => void> = [];
const minimizeApp = vi.fn(() => Promise.resolve());

vi.mock("@capacitor/core", async (orig) => {
  const actual = await orig<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => true, getPlatform: () => "android" },
  };
});
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: (event: string, fn: () => void) => {
      if (event === "backButton") backListeners.push(fn);
      return Promise.resolve({ remove: () => undefined });
    },
    minimizeApp: () => minimizeApp(),
  },
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsTouch: () => true, useIsMobile: () => true }));

import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { AppContext, defaultConfig } from "@/contexts/AppContext";
import { useMobileMembersOverlay } from "@/hooks/useMobileMembersOverlay";

/** Android system back (gesture or button), as Capacitor delivers it. */
async function pressBack() {
  await act(async () => {
    for (const fn of backListeners) fn();
    // SwipeReveal defers the commit behind rAF×2 / an 80ms timeout.
    await new Promise((r) => setTimeout(r, 120));
  });
}

function Page({ communityId }: { communityId: string }) {
  const [channelId, setChannelId] = useState("general");
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useMobileMembersOverlay(`${communityId}|${channelId}`, channelsOpen);

  const select = (id: string) => {
    setChannelId(id);
    setChannelsOpen(false);
  };

  return (
    <SwipeReveal
      open={channelsOpen}
      onReveal={() => setChannelsOpen(true)}
      onClose={() => setChannelsOpen(false)}
      underlay={
        <nav aria-label="channels">
          <button onClick={() => select("general")}>#general</button>
          <button onClick={() => select("random")}>#random</button>
        </nav>
      }
    >
      <main data-testid="chat" data-channel={channelId} data-list-open={String(channelsOpen)}>
        <button onClick={() => setChannelsOpen(true)}>Back to channels</button>
        <button onClick={() => setMembersOpen(true)}>Members</button>
        {membersOpen && (
          <aside data-testid="members-overlay">
            <button aria-label="Close members" onClick={() => setMembersOpen(false)}>x</button>
          </aside>
        )}
      </main>
    </SwipeReveal>
  );
}

function stubViewport(narrow: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("min-width: 900px") ? !narrow : query.includes("max-width: 899px") ? narrow : true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  // Narrow (mobile) viewport so SwipeReveal enables its drill-down + back handler.
  stubViewport(true);
  minimizeApp.mockClear();
});

const overlay = () => screen.queryByTestId("members-overlay");
const chat = () => screen.getByTestId("chat");
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe("useMobileMembersOverlay", () => {
  it("Android back closes the member overlay instead of revealing the channel list", async () => {
    render(<Page communityId="c1" />);
    fireEvent.click(screen.getByText("Members"));
    expect(overlay()).not.toBeNull();

    await pressBack();
    expect(overlay()).toBeNull();
    expect(chat().dataset.listOpen).toBe("false");

    // With the overlay gone, the next back is the drill-down's again.
    await pressBack();
    expect(chat().dataset.listOpen).toBe("true");
  });

  it("revealing the channel list closes the overlay", async () => {
    render(<Page communityId="c1" />);
    fireEvent.click(screen.getByText("Members"));
    fireEvent.click(screen.getByText("Back to channels"));
    expect(chat().dataset.listOpen).toBe("true");
    expect(overlay()).toBeNull();
  });

  it("tapping the SAME channel from the list shows its messages, not the overlay", async () => {
    render(<Page communityId="c1" />);
    fireEvent.click(screen.getByText("Members"));
    fireEvent.click(screen.getByText("Back to channels"));
    fireEvent.click(screen.getByText("#general")); // the channel already open
    await settle();

    expect(chat().dataset.listOpen).toBe("false");
    expect(overlay()).toBeNull();
  });

  it("tapping a DIFFERENT channel closes the overlay", async () => {
    render(<Page communityId="c1" />);
    fireEvent.click(screen.getByText("Members"));
    fireEvent.click(screen.getByText("Back to channels"));
    fireEvent.click(screen.getByText("#random"));
    await settle();

    expect(chat().dataset.channel).toBe("random");
    expect(overlay()).toBeNull();
  });

  it("switching community closes the overlay in the same render", () => {
    const { rerender } = render(<Page communityId="c1" />);
    fireEvent.click(screen.getByText("Members"));
    rerender(<Page communityId="c2" />);
    expect(overlay()).toBeNull();
  });

  it("back goes chat → list → out of the app, never through earlier chats", async () => {
    // Earlier communities and chats on the history stack.
    window.history.pushState({}, "", "/c/earlier");
    window.history.pushState({}, "", "/c/c1");
    const back = vi.spyOn(window.history, "back");
    render(<Page communityId="c1" />);

    await pressBack();
    expect(chat().dataset.listOpen).toBe("true");
    expect(minimizeApp).not.toHaveBeenCalled();

    await pressBack();
    expect(minimizeApp).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    back.mockRestore();
  });

  it("back from the list walks history when androidBackLeavesApp is off", async () => {
    window.history.pushState({}, "", "/c/earlier");
    window.history.pushState({}, "", "/c/c1");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const config = { ...defaultConfig, androidBackLeavesApp: false };
    render(
      <AppContext.Provider value={{ config, updateConfig: () => undefined }}>
        <Page communityId="c1" />
      </AppContext.Provider>,
    );

    await pressBack();
    expect(chat().dataset.listOpen).toBe("true");

    await pressBack();
    expect(back).toHaveBeenCalledTimes(1);
    expect(minimizeApp).not.toHaveBeenCalled();
    back.mockRestore();
  });

  it("leaves back alone on the desktop layout", async () => {
    stubViewport(false);
    render(<Page communityId="c1" />);
    fireEvent.click(screen.getByText("Members"));
    // Neither SwipeReveal (inert when wide) nor the overlay holds the back.
    await pressBack();
    expect(overlay()).not.toBeNull();
  });
});
