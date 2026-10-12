import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetRelayHealthForTests,
  isRelayUnreachable,
  noteRelayClosed,
  noteRelayOpened,
  onRelayHealthChange,
} from "@/lib/relayHealth";

const URL_ = "wss://relay.mostr.pub";

afterEach(() => {
  _resetRelayHealthForTests();
  vi.useRealTimers();
});

describe("relayHealth", () => {
  it("cools a relay down after three attempts that never opened", () => {
    const t = 1_000_000;
    noteRelayClosed(URL_, t);
    noteRelayClosed(URL_, t);
    expect(isRelayUnreachable(URL_, t)).toBe(false);
    noteRelayClosed(URL_, t);
    expect(isRelayUnreachable(URL_, t)).toBe(true);
    expect(isRelayUnreachable(URL_, t + 5 * 60_000)).toBe(false);
  });

  it("doubles the cooldown when the retry after it fails too, up to an hour", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) noteRelayClosed(URL_, t);
    const retry = t + 5 * 60_000;
    noteRelayClosed(URL_, retry);
    expect(isRelayUnreachable(URL_, retry + 9 * 60_000)).toBe(true);
    expect(isRelayUnreachable(URL_, retry + 10 * 60_000)).toBe(false);
    let at = retry + 10 * 60_000;
    for (let i = 0; i < 10; i++) {
      noteRelayClosed(URL_, at);
      at += 60 * 60_000;
    }
    // The last close's cooldown is capped at an hour.
    const last = at - 60 * 60_000;
    expect(isRelayUnreachable(URL_, last + 60 * 60_000 - 1)).toBe(true);
    expect(isRelayUnreachable(URL_, last + 60 * 60_000)).toBe(false);
  });

  it("forgets the failures once the relay opens; a close after an open is not a failure", () => {
    const t = 1_000_000;
    noteRelayClosed(URL_, t);
    noteRelayClosed(URL_, t);
    noteRelayOpened(URL_);
    noteRelayClosed(URL_, t);
    noteRelayClosed(URL_, t);
    noteRelayClosed(URL_, t);
    expect(isRelayUnreachable(URL_, t)).toBe(false);
  });

  it("tells consumers when a relay goes down and when its cooldown ends", () => {
    vi.useFakeTimers();
    const seen = vi.fn();
    onRelayHealthChange(seen);
    for (let i = 0; i < 3; i++) noteRelayClosed(URL_);
    expect(seen).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60_000);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("matches relay URLs as normalized", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) noteRelayClosed("wss://relay.mostr.pub/", t);
    expect(isRelayUnreachable(URL_, t)).toBe(true);
  });

  it("remembers a running cooldown across a relaunch", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      for (let i = 0; i < 3; i++) noteRelayClosed(URL_);
      expect(isRelayUnreachable(URL_)).toBe(true);
      _resetRelayHealthForTests(); // a new page
      expect(isRelayUnreachable(URL_)).toBe(true);
      noteRelayOpened(URL_);
      _resetRelayHealthForTests();
      expect(isRelayUnreachable(URL_), "an open clears the stored cooldown").toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
