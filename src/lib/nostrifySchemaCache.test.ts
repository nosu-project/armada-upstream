import { NSchema } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { installNostrifySchemaCache } from "./nostrifySchemaCache";

/**
 * The point of the cache is instance identity: zod caches a JIT-compiled
 * validator on the schema instance, so two calls returning two instances is
 * two compiles. These assert the memo holds AND that parsing is unchanged —
 * a shared schema that validates differently would be a wire-format bug.
 */
describe("installNostrifySchemaCache", () => {
  it("returns one instance per cached factory", () => {
    installNostrifySchemaCache();

    expect(NSchema.relayMsg()).toBe(NSchema.relayMsg());
    expect(NSchema.json()).toBe(NSchema.json());
    expect(NSchema.event()).toBe(NSchema.event());
    expect(NSchema.id()).toBe(NSchema.id());
    expect(NSchema.metadata()).toBe(NSchema.metadata());
  });

  it("is idempotent", () => {
    installNostrifySchemaCache();
    const first = NSchema.relayMsg();
    installNostrifySchemaCache();
    expect(NSchema.relayMsg()).toBe(first);
  });

  it("leaves parameterized factories building per call", () => {
    installNostrifySchemaCache();
    // bech32 takes a prefix — caching it would return the wrong prefix's schema.
    expect(NSchema.bech32("npub")).not.toBe(NSchema.bech32("nsec"));
  });

  it("still parses relay messages the same way", () => {
    installNostrifySchemaCache();
    const schema = NSchema.json().pipe(NSchema.relayMsg());

    const event = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1700000000,
      kind: 1,
      tags: [["p", "c".repeat(64)]],
      content: "hello",
      sig: "d".repeat(128),
    };

    const ok = schema.safeParse(JSON.stringify(["EVENT", "sub1", event]));
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data).toEqual(["EVENT", "sub1", event]);

    expect(schema.safeParse(JSON.stringify(["EOSE", "sub1"])).success).toBe(true);
    expect(schema.safeParse(JSON.stringify(["OK", "a".repeat(64), true, ""])).success).toBe(true);

    // Repeated parses through the SAME shared schema must not drift.
    expect(schema.safeParse(JSON.stringify(["EVENT", "sub1", event])).success).toBe(true);

    expect(schema.safeParse("not json").success).toBe(false);
    expect(schema.safeParse(JSON.stringify(["NOPE", "sub1"])).success).toBe(false);
    expect(schema.safeParse(JSON.stringify(["EVENT", "sub1", { ...event, id: "short" }])).success).toBe(false);
  });
});
