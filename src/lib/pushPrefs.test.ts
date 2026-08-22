import { afterEach, describe, expect, it } from "vitest";

import { _resetActiveAccountForTests, setActivePubkey } from "@/lib/activeAccount";
import {
  DEFAULT_PUSH_PREFS,
  loadPushPrefs,
  savePushPrefs,
} from "@/lib/pushPrefs";

const A = "a".repeat(64);
const B = "b".repeat(64);

afterEach(() => {
  localStorage.clear();
  _resetActiveAccountForTests();
});

describe("account-scoped push preferences", () => {
  it("never uses the outgoing account's mirror as a fresh account's defaults", () => {
    setActivePubkey(A);
    savePushPrefs({ ...DEFAULT_PUSH_PREFS, directMessages: false, dmRequests: "off" });

    setActivePubkey(B);
    expect(loadPushPrefs()).toEqual(DEFAULT_PUSH_PREFS);
    savePushPrefs({ ...DEFAULT_PUSH_PREFS, reactions: false });

    setActivePubkey(A);
    expect(loadPushPrefs()).toMatchObject({ directMessages: false, dmRequests: "off" });
    setActivePubkey(B);
    expect(loadPushPrefs()).toMatchObject({ reactions: false, directMessages: true });
  });

  it("lets a mounted controller name its owner across an active-marker transition", () => {
    setActivePubkey(B);
    savePushPrefs({ ...DEFAULT_PUSH_PREFS, directMessages: false }, A);

    expect(loadPushPrefs(A).directMessages).toBe(false);
    expect(loadPushPrefs(B)).toEqual(DEFAULT_PUSH_PREFS);
  });
});
