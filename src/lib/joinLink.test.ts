import { describe, expect, it } from "vitest";

import { parseJoinLink } from "@/lib/joinLink";

describe("parseJoinLink", () => {
  it("parses a single relay and an optional name", () => {
    expect(parseJoinLink("?relay=wss://op.example&name=Acme")).toEqual({
      relays: ["wss://op.example"],
      name: "Acme",
    });
  });

  it("accepts repeated and comma-joined relays, normalized and deduped", () => {
    expect(
      parseJoinLink("?relay=wss://a.example,wss://b.example&relay=WSS://A.EXAMPLE/"),
    ).toEqual({ relays: ["wss://a.example", "wss://b.example"] });
  });

  it("caps the relay set", () => {
    const search = Array.from({ length: 12 }, (_, i) => `relay=wss://r${i}.example`).join("&");
    expect(parseJoinLink(`?${search}`)?.relays).toHaveLength(8);
  });

  it("drops non-relay URLs and returns null when none remain", () => {
    expect(parseJoinLink("?relay=https://not-a-relay.example")).toBeNull();
    expect(parseJoinLink("?name=Acme")).toBeNull();
    expect(parseJoinLink("")).toBeNull();
  });

  it("sanitizes the display name (control chars stripped, length capped)", () => {
    const parsed = parseJoinLink(`?relay=wss://op.example&name=${encodeURIComponent("A\u0000B\u001f")}`);
    expect(parsed?.name).toBe("AB");
    const long = parseJoinLink(`?relay=wss://op.example&name=${"x".repeat(80)}`);
    expect(long?.name).toHaveLength(48);
  });

  it("omits an empty name", () => {
    expect(parseJoinLink("?relay=wss://op.example&name=")).toEqual({
      relays: ["wss://op.example"],
    });
  });
});
