/**
 * The routing rule: which tenant an incoming relay event belongs in.
 *
 * These are the cases the Kotlin half (`RelayScope.kt`) must agree with, since
 * the notification service and the WebView are two writers into one database and
 * a rule only one of them applies is a disagreement about where a message lives.
 */
import { describe, expect, it } from "vitest";

import { isRelayScoped, nip29Tenant, tenantForEvent } from "./relayScope";

const RELAY = "wss://relay.example";
const MAIN = "main";

function ev(kind: number, tags: string[][] = []) {
  return { kind, tags };
}

describe("isRelayScoped", () => {
  it("scopes anything carrying an h tag — the NIP-29 group marker", () => {
    // Not a kind list: `h` is the protocol's own statement that the event means
    // something only inside one group on one relay, so a group-scoped kind added
    // later is handled without touching the rule.
    for (const kind of [9, 11, 1111, 7, 1068, 9450, 9000, 9021, 31923, 5]) {
      expect(isRelayScoped(ev(kind, [["h", "abc"]]))).toBe(true);
    }
  });

  it("scopes relay-signed relay/group state, which carries no h tag", () => {
    for (const kind of [39000, 39001, 39002, 39003, 39004, 39005, 13534]) {
      expect(isRelayScoped(ev(kind, [["d", "abc"]]))).toBe(true);
    }
  });

  it("leaves global data alone, even the kinds that double as group-scoped", () => {
    // A kind-5 delete, a reaction or a NIP-22 comment outside a group is an
    // ordinary global event. Relay-scoping these would fork one identity into a
    // copy per relay and hide a profile learned on one relay from every other.
    expect(isRelayScoped(ev(0))).toBe(false);
    expect(isRelayScoped(ev(5, [["e", "x"]]))).toBe(false);
    expect(isRelayScoped(ev(7, [["e", "x"]]))).toBe(false);
    expect(isRelayScoped(ev(1111, [["E", "x"]]))).toBe(false);
    expect(isRelayScoped(ev(10009))).toBe(false); // the user's own group list
    expect(isRelayScoped(ev(1985, [["r", RELAY]]))).toBe(false); // NIP-32 self-label
    expect(isRelayScoped(ev(1059))).toBe(false); // gift wrap
    expect(isRelayScoped(ev(3300))).toBe(false); // retired Concord V1 sealed outer (kind never reused)
  });

  it("ignores a malformed or empty h tag", () => {
    expect(isRelayScoped(ev(9, [["h"]]))).toBe(false);
    expect(isRelayScoped(ev(9, [["h", ""]]))).toBe(false);
  });
});

describe("nip29Tenant", () => {
  it("normalizes, so one relay is one tenant however its URL was spelled", () => {
    // The id is the ONLY thing keeping the scopes apart, so a trailing slash or a
    // mixed-case host must not fork a channel's history into two tenants.
    const expected = "nip29:wss://relay.example";
    expect(nip29Tenant("wss://relay.example")).toBe(expected);
    expect(nip29Tenant("wss://relay.example/")).toBe(expected);
    expect(nip29Tenant("wss://RELAY.example")).toBe(expected);
    expect(nip29Tenant(" wss://relay.example ")).toBe(expected);
  });

  it("is idempotent, so the native side can hand back a normalized URL", () => {
    const once = nip29Tenant("wss://relay.example/")!;
    expect(nip29Tenant(once.slice("nip29:".length))).toBe(once);
  });

  it("keeps a path, so two deployments on one host stay apart", () => {
    expect(nip29Tenant("wss://a.example/eu")).not.toBe(nip29Tenant("wss://a.example"));
  });

  it("refuses a URL nothing could be a relay at", () => {
    expect(nip29Tenant("")).toBeUndefined();
    expect(nip29Tenant("   ")).toBeUndefined();
  });

  it("accepts a bare hostname, as the app's own relay entry does", () => {
    // `normalizeRelayUrl` is deliberately permissive — it is what user-typed
    // relay addresses go through. A weird address yields a weird tenant, which is
    // harmless here: the only property this scoping needs is that the write and
    // the read derive the SAME id, and they run the same normalizer.
    expect(nip29Tenant("relay.example")).toBe("nip29:wss://relay.example");
  });
});

describe("tenantForEvent", () => {
  it("sends global data to main, relay or no relay", () => {
    expect(tenantForEvent(ev(0), undefined, MAIN)).toBe(MAIN);
    expect(tenantForEvent(ev(0), RELAY, MAIN)).toBe(MAIN);
  });

  it("sends relay-relative data to that relay's tenant", () => {
    expect(tenantForEvent(ev(9, [["h", "abc"]]), RELAY, MAIN)).toBe(nip29Tenant(RELAY));
    expect(tenantForEvent(ev(39000, [["d", "abc"]]), RELAY, MAIN)).toBe(nip29Tenant(RELAY));
  });

  it("stores NOTHING relay-relative when the relay is unknown", () => {
    // A pool-wide `.query()` fans out to every relay and a `group(urls)` read has
    // N candidates for one event, so provenance genuinely isn't always known.
    // Filing those under `main` — or under all N — is the collision the split
    // exists to remove, and the loss is a refetchable cache row.
    expect(tenantForEvent(ev(9, [["h", "abc"]]), undefined, MAIN)).toBeUndefined();
    expect(tenantForEvent(ev(39000, [["d", "abc"]]), undefined, MAIN)).toBeUndefined();
    expect(tenantForEvent(ev(9, [["h", "abc"]]), "", MAIN)).toBeUndefined();
  });
});
