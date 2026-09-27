// @vitest-environment node
/**
 * The hand-written relay-message parser against the schema it replaces: every
 * case must reach the same verdict as nostrify's own `NSchema`, and an accepted
 * message must come out identical — including the fields zod strips.
 */
import { NSchema } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { relayMsgSchema } from "./relayMsgParse";

const zod = NSchema.json().pipe(NSchema.relayMsg());

const id = "a".repeat(64);
const event = { id, kind: 1, pubkey: "b".repeat(64), tags: [["p", "x"], []], content: "hi", created_at: 1700000000, sig: "c".repeat(128) };

const cases: unknown[] = [
  ["EVENT", "sub", event],
  ["EVENT", "sub", { ...event, seenOn: ["wss://x"], extra: 1 }],
  ["EVENT", "sub", { ...event, id: "A".repeat(64) }],
  ["EVENT", "sub", { ...event, id: "a".repeat(63) }],
  ["EVENT", "sub", { ...event, kind: 65536 }],
  ["EVENT", "sub", { ...event, kind: -1 }],
  ["EVENT", "sub", { ...event, kind: 1.5 }],
  ["EVENT", "sub", { ...event, created_at: 2 ** 60 }],
  ["EVENT", "sub", { ...event, created_at: -5 }],
  ["EVENT", "sub", { ...event, tags: [["p", 1]] }],
  ["EVENT", "sub", { ...event, tags: ["p"] }],
  ["EVENT", "sub", { ...event, tags: {} }],
  ["EVENT", "sub", { ...event, content: 5 }],
  ["EVENT", "sub", { ...event, sig: 5 }],
  ["EVENT", "sub", { ...event, sig: "" }],
  ["EVENT", "sub", (({ sig: _s, ...rest }) => rest)(event)],
  ["EVENT", "sub", null],
  ["EVENT", "sub", [event]],
  ["EVENT", 5, event],
  ["EVENT", "sub", event, "extra"],
  ["EVENT", "sub"],
  ["OK", id, true, ""],
  ["OK", id, false, "blocked: no"],
  ["OK", "nothex", true, ""],
  ["OK", id, "true", ""],
  ["OK", id, true],
  ["OK", id, true, "", 1],
  ["EOSE", "sub"],
  ["EOSE", 1],
  ["EOSE", "sub", "x"],
  ["NOTICE", "hello"],
  ["NOTICE"],
  ["CLOSED", "sub", "auth-required: x"],
  ["CLOSED", "sub"],
  ["AUTH", "challenge"],
  ["AUTH", { kind: 22242 }],
  ["COUNT", "sub", { count: 3 }],
  ["COUNT", "sub", { count: 3, approximate: true, extra: 1 }],
  ["COUNT", "sub", { count: -1 }],
  ["COUNT", "sub", { count: 3, approximate: "yes" }],
  ["COUNT", "sub", 3],
  ["REQ", "sub", {}],
  ["UNKNOWN"],
  [],
  {},
  "EVENT",
  5,
  null,
];

describe("relayMsgSchema", () => {
  it.each(cases.map((c) => [JSON.stringify(c)]))("agrees with NSchema on %s", (frame) => {
    const ours = relayMsgSchema.safeParse(frame);
    const theirs = zod.safeParse(frame);
    expect(ours.success).toBe(theirs.success);
    if (ours.success && theirs.success) expect(ours.data).toEqual(theirs.data);
  });

  it("rejects what isn't JSON, or isn't a string", () => {
    for (const frame of ["{", "", "not json", 5, null]) {
      expect(relayMsgSchema.safeParse(frame).success).toBe(false);
      expect(zod.safeParse(frame).success).toBe(false);
    }
  });
});
