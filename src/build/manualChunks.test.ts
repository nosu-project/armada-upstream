import { describe, expect, it } from "vitest";

import { EAGERLY_PRELOADED_CHUNKS, manualChunks } from "./manualChunks";

/**
 * Guards the first-load critical path against lazy libraries being grouped into
 * an eagerly-preloaded vendor chunk.
 *
 * A representative module id for each dependency, in the shape Rollup passes to
 * `manualChunks` (an absolute path containing the `node_modules/<pkg>` segment).
 */
const mod = (pkg: string, file = "index.js") => `/repo/node_modules/${pkg}/dist/${file}`;

describe("manualChunks router", () => {
  it("keeps the core eager libs in their expected vendor chunks", () => {
    expect(manualChunks(mod("react-dom"))).toBe("vendor-react");
    expect(manualChunks(mod("react"))).toBe("vendor-react");
    expect(manualChunks(mod("scheduler"))).toBe("vendor-react");
    expect(manualChunks(mod("nostr-tools"))).toBe("vendor-nostr");
    expect(manualChunks(mod("@nostrify/nostrify"))).toBe("vendor-nostr");
    expect(manualChunks(mod("@noble/hashes"))).toBe("vendor-nostr");
    expect(manualChunks(mod("@radix-ui/react-dialog"))).toBe("vendor-radix");
    expect(manualChunks(mod("@tanstack/react-query"))).toBe("vendor-tanstack");
    expect(manualChunks(mod("lucide-react"))).toBe("lucide-icons");
  });

  it("keeps the known-lazy libs OFF the eagerly-preloaded chunks", () => {
    // highlight.js / lowlight: reached only via the dynamic import in
    // src/lib/codeHighlight.ts.
    const highlight = manualChunks(mod("highlight.js", "lib/core.js"));
    expect(highlight).toBe("vendor-highlight");
    expect(EAGERLY_PRELOADED_CHUNKS.has(highlight!)).toBe(false);

    const livekit = manualChunks(mod("livekit-client"));
    expect(EAGERLY_PRELOADED_CHUNKS.has(livekit ?? "")).toBe(false);
  });

  it("does not hoist @scure/btc-signer onto the eager critical path", () => {
    // btc-signer is reached ONLY lazily (WalletDialog → @/lib/bitcoin). It must
    // not land in an eagerly-preloaded chunk. The `@scure` catch-all routes it
    // into `vendor-nostr` (eager) unless a more specific rule precedes it.
    const chunk = manualChunks(mod("@scure/btc-signer", "esm/transaction.js"));
    expect(EAGERLY_PRELOADED_CHUNKS.has(chunk ?? "")).toBe(false);
    expect(chunk).not.toBe("vendor-nostr");
  });

  it("still groups the other @scure/@noble crypto into vendor-nostr", () => {
    // The fix must be scoped to btc-signer, not a blanket @scure change: the
    // base58/bech32 helpers nostr-tools leans on stay on the core path.
    expect(manualChunks(mod("@scure/base"))).toBe("vendor-nostr");
    expect(manualChunks(mod("@noble/curves", "secp256k1.js"))).toBe("vendor-nostr");
  });
});
