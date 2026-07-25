/**
 * Tests for the quick-reaction frequency table.
 *
 * This backs the one-click row on a message's action toolbar, so the ordering
 * rules matter: the row should converge on what the user actually reacts with,
 * stay full-width for a brand-new account, and never grow without bound.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  recordReaction,
  resetFrequentReactionsCache,
  useFrequentReactions,
} from "@/hooks/useFrequentReactions";

const SELF = "a".repeat(64);
const KEY = `armada:frequent-reactions:${SELF}`;

function keys(limit = 3): string[] {
  const { result } = renderHook(() => useFrequentReactions(SELF, limit));
  return result.current.map((e) => e.key);
}

beforeEach(() => {
  localStorage.clear();
  resetFrequentReactionsCache();
});

describe("useFrequentReactions", () => {
  it("fills the row with defaults for an account that has never reacted", () => {
    expect(keys()).toEqual(["👍", "❤️", "😂"]);
  });

  it("ranks by use count, most-used first", () => {
    act(() => {
      recordReaction(SELF, "🎉");
      recordReaction(SELF, "🚀");
      recordReaction(SELF, "🚀");
    });
    expect(keys().slice(0, 2)).toEqual(["🚀", "🎉"]);
  });

  it("pads with defaults it hasn't already listed, without duplicating them", () => {
    act(() => recordReaction(SELF, "❤️"));
    // ❤️ is both earned and a default: it must appear once, at the top.
    expect(keys()).toEqual(["❤️", "👍", "😂"]);
  });

  it("keeps custom emoji with their image URL", () => {
    act(() => recordReaction(SELF, ":cat:", "https://e/cat.png"));
    const { result } = renderHook(() => useFrequentReactions(SELF, 3));
    expect(result.current[0]).toMatchObject({ key: ":cat:", url: "https://e/cat.png" });
  });

  it("re-renders subscribers when a reaction is recorded", () => {
    const { result } = renderHook(() => useFrequentReactions(SELF, 3));
    expect(result.current[0].key).toBe("👍");
    act(() => {
      recordReaction(SELF, "🔥");
      recordReaction(SELF, "🔥");
    });
    expect(result.current[0].key).toBe("🔥");
  });

  it("persists across a reload", () => {
    act(() => recordReaction(SELF, "🔥"));
    resetFrequentReactionsCache(); // simulate a fresh page load
    expect(keys()[0]).toBe("🔥");
  });

  it("caps what it stores so the table can't grow without bound", () => {
    act(() => {
      for (let i = 0; i < 40; i++) recordReaction(SELF, `e${i}`);
    });
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    expect(stored.length).toBeLessThanOrEqual(32);
  });

  it("ignores a signed-out user rather than writing a stray table", () => {
    act(() => recordReaction(undefined, "🔥"));
    expect(localStorage.length).toBe(0);
  });
});
