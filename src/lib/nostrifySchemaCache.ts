/**
 * Build Nostrify's argument-less zod schemas ONCE instead of once per use.
 *
 * `NRelay1`'s socket handler parses every inbound frame with
 * `NSchema.json().pipe(NSchema.relayMsg()).safeParse(data)` — and those are
 * FACTORIES: each call constructs a fresh union of seven fresh tuple schemas,
 * one of which contains the full event object schema. zod 4 JIT-compiles an
 * object validator with `new Function(...)` on a schema's first parse and
 * caches it *on that instance*, so a schema rebuilt per message is a validator
 * recompiled per message.
 *
 * A profile of the hosted client (69s, ~216 relay messages/second) put 1.48s of
 * self time in zod's `Doc.compile` and 2.25s across the whole `safeParse`
 * subtree — ~10% of the tab's script CPU, spent re-deriving a constant. The
 * schemas describe NIP-01's wire format; there is exactly one of each.
 *
 * Memoizing the factories rather than the parse is what makes this safe: zod
 * schemas are immutable and stateless across `parse`/`safeParse`, and every
 * combinator (`.optional()`, `.pipe()`, …) returns a NEW schema rather than
 * mutating the receiver, so a shared instance cannot be aliased into a
 * different shape by one caller. `NRelay1` still allocates its `.pipe()`
 * wrapper per message — cheap, and not a JIT target.
 *
 * Scoped to the zero-argument factories: `NSchema.bech32(prefix)` is
 * parameterized and must keep building per call. The arity check below keeps it
 * that way even if a future release parameterizes one of the listed names.
 *
 * The upstream fix is to hoist the schema out of the message handler; this
 * stays correct either way (it would simply stop having anything to save).
 */
import { NSchema } from "@nostrify/nostrify";

/**
 * The factories worth caching: the relay-message parse path, plus the
 * per-event/per-profile validators the app reaches for on hot paths
 * (`isNostrId`, author metadata parsing).
 */
const CACHED_FACTORIES = ["json", "relayMsg", "event", "id", "metadata"] as const;

let installed = false;

/**
 * Replace the listed `NSchema` statics with memoized equivalents. Idempotent,
 * and a no-op for any name that isn't a zero-argument function on the installed
 * Nostrify.
 */
export function installNostrifySchemaCache(): void {
  if (installed) return;
  installed = true;

  const statics = NSchema as unknown as Record<string, unknown>;

  for (const name of CACHED_FACTORIES) {
    const factory = statics[name];
    // Arity > 0 means the result depends on an argument — never cache those.
    if (typeof factory !== "function" || factory.length > 0) continue;

    let schema: unknown;
    let built = false;
    const cached = () => {
      if (!built) {
        schema = (factory as () => unknown).call(NSchema);
        built = true;
      }
      return schema;
    };
    // Build lazily, not here: these are only worth constructing if something
    // actually asks, and a throwing factory should throw at ITS call site.
    statics[name] = cached;
  }
}
