// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { getHiddenMessageIds, hideMessageId, unhideMessageId } from "./hiddenMessages";

// Each test uses its own pubkey: the module caches per storage key, so a
// fresh key is a fresh, empty set without reaching into module internals.
let n = 0;
const freshPubkey = () => `pk-${++n}`;

describe("hiddenMessages", () => {
  it("hides and unhides for one account", () => {
    const pk = freshPubkey();
    expect(getHiddenMessageIds(pk).size).toBe(0);

    hideMessageId(pk, "a");
    hideMessageId(pk, "b");
    expect(getHiddenMessageIds(pk)).toEqual(new Set(["a", "b"]));

    unhideMessageId(pk, "a");
    expect(getHiddenMessageIds(pk)).toEqual(new Set(["b"]));
  });

  it("persists to localStorage under the account's key", () => {
    const pk = freshPubkey();
    hideMessageId(pk, "x");
    expect(JSON.parse(localStorage.getItem(`armada:hidden-messages:${pk}`)!)).toEqual(["x"]);
  });

  it("keeps accounts separate", () => {
    const one = freshPubkey();
    const two = freshPubkey();
    hideMessageId(one, "only-one");
    expect(getHiddenMessageIds(two).has("only-one")).toBe(false);
    expect(getHiddenMessageIds(one).has("only-one")).toBe(true);
  });

  it("is inert with no account", () => {
    expect(getHiddenMessageIds(undefined).size).toBe(0);
    hideMessageId(undefined, "a");
    unhideMessageId(undefined, "a");
    expect(getHiddenMessageIds(undefined).size).toBe(0);
  });

  it("returns a stable reference between writes", () => {
    const pk = freshPubkey();
    hideMessageId(pk, "a");
    const first = getHiddenMessageIds(pk);
    expect(getHiddenMessageIds(pk)).toBe(first);
    hideMessageId(pk, "b");
    expect(getHiddenMessageIds(pk)).not.toBe(first);
  });

  it("caps the set, dropping the oldest hide first", () => {
    const pk = freshPubkey();
    for (let i = 0; i < 1001; i++) hideMessageId(pk, `id-${i}`);
    const ids = getHiddenMessageIds(pk);
    expect(ids.size).toBe(1000);
    expect(ids.has("id-0")).toBe(false);
    expect(ids.has("id-1000")).toBe(true);
  });
});
