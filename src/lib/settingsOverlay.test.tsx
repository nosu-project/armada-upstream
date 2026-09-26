import { act, render } from "@testing-library/react";
import { useContext } from "react";
import { MemoryRouter, useLocation, useNavigate, type Location, type NavigateFunction } from "react-router-dom";
import { describe, expect, it } from "vitest";

import {
  SettingsOverlayContext,
  useSettingsOverlayController,
  type SettingsOverlay,
} from "@/lib/settingsOverlay";

import type { ProfileBackgroundState } from "@/lib/profileOverlay";

interface Seen {
  overlay: SettingsOverlay;
  location: Location;
  navigate: NavigateFunction;
}

function Probe({ seen }: { seen: Seen }) {
  seen.overlay = useContext(SettingsOverlayContext);
  return null;
}

function Harness({ seen }: { seen: Seen }) {
  const location = useLocation();
  const navigate = useNavigate();
  const settings = useSettingsOverlayController(location, navigate);
  seen.location = location;
  seen.navigate = navigate;
  return (
    <SettingsOverlayContext.Provider value={settings}>
      <Probe seen={seen} />
    </SettingsOverlayContext.Provider>
  );
}

function mount(path: string) {
  const seen = {} as Seen;
  render(
    <MemoryRouter initialEntries={[path]}>
      <Harness seen={seen} />
    </MemoryRouter>,
  );
  return seen;
}

const backgroundOf = (location: Location) =>
  (location.state as ProfileBackgroundState | null)?.backgroundLocation;

describe("settings overlay", () => {
  it("opens over the current page and closes back to it", () => {
    const seen = mount("/c/abc/general");
    act(() => seen.overlay.show());
    expect(seen.overlay.open).toBe(true);
    expect(seen.location.pathname).toBe("/settings");
    expect(backgroundOf(seen.location)?.pathname).toBe("/c/abc/general");

    act(() => seen.overlay.close());
    expect(seen.overlay.open).toBe(false);
    expect(seen.location.pathname).toBe("/c/abc/general");
  });

  it("carries the section from the click and from the URL", () => {
    const seen = mount("/dm");
    act(() => seen.overlay.show("profile"));
    expect(seen.location.hash).toBe("#profile");
    expect(seen.overlay.section).toBe("profile");
  });

  it("threads a profile's background through", () => {
    const seen = mount("/c/abc/general");
    const chat = seen.location;
    act(() => seen.overlay.show());
    // Re-showing from inside Settings replaces rather than stacks.
    act(() => seen.overlay.show("relays"));
    expect(backgroundOf(seen.location)?.pathname).toBe(chat.pathname);
    act(() => seen.overlay.close());
    expect(seen.location.pathname).toBe("/c/abc/general");
  });

  it("a close that beats its own open still ends closed", () => {
    const seen = mount("/c/abc/general");
    act(() => {
      seen.overlay.show();
      seen.overlay.close();
    });
    expect(seen.overlay.open).toBe(false);
    expect(seen.location.pathname).toBe("/c/abc/general");
  });

  it("show, close, show before the first open lands leaves one entry to step back from", () => {
    const seen = mount("/c/abc/general");
    act(() => {
      seen.overlay.show();
      seen.overlay.close();
      seen.overlay.show();
    });
    expect(seen.overlay.open).toBe(true);
    expect(seen.location.pathname).toBe("/settings");

    // One history step (the browser's back button) is enough to leave.
    act(() => seen.navigate(-1));
    expect(seen.overlay.open).toBe(false);
    expect(seen.location.pathname).toBe("/c/abc/general");
  });

  it("show, close, show before the first open lands closes in one press", () => {
    const seen = mount("/c/abc/general");
    act(() => {
      seen.overlay.show();
      seen.overlay.close();
      seen.overlay.show();
    });
    act(() => seen.overlay.close());
    expect(seen.overlay.open).toBe(false);
    expect(seen.location.pathname).toBe("/c/abc/general");
  });

  it("show, close, show, close before anything lands ends closed", () => {
    const seen = mount("/c/abc/general");
    act(() => {
      seen.overlay.show();
      seen.overlay.close();
      seen.overlay.show();
      seen.overlay.close();
    });
    expect(seen.overlay.open).toBe(false);
    expect(seen.location.pathname).toBe("/c/abc/general");

    // Nothing stacked: opening again and closing once still ends on the chat.
    act(() => seen.overlay.show());
    act(() => seen.overlay.close());
    expect(seen.overlay.open).toBe(false);
    expect(seen.location.pathname).toBe("/c/abc/general");
  });

  it("an open that beats its close's step back ends open", () => {
    const seen = mount("/c/abc/general");
    act(() => seen.overlay.show());
    act(() => {
      seen.overlay.close();
      seen.overlay.show("relays");
    });
    expect(seen.overlay.open).toBe(true);
    expect(seen.location.pathname).toBe("/settings");
    expect(seen.location.hash).toBe("#relays");

    act(() => seen.overlay.close());
    expect(seen.overlay.open).toBe(false);
    expect(seen.location.pathname).toBe("/c/abc/general");
  });

  it("on the routed Settings page it only moves to the section", () => {
    const seen = mount("/settings");
    expect(seen.overlay.open).toBe(false);
    act(() => seen.overlay.show("profile"));
    expect(seen.overlay.open).toBe(false);
    expect(seen.location.hash).toBe("#profile");
    expect(backgroundOf(seen.location)).toBeUndefined();
  });
});
