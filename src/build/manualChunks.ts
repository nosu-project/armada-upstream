/**
 * Rollup `manualChunks` router — build-time only (imported by vite.config.ts,
 * ships in no bundle). Extracted so the chunk assignment is unit-testable.
 * Returns a chunk name, or undefined to let Rollup co-locate with the importer.
 */
export function manualChunks(id: string): string | undefined {
  if (id.includes("node_modules/lucide-react")) {
    return "lucide-icons";
  }
  if (id.includes("node_modules")) {
    if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
      return "vendor-react";
    }
    // Code-block grammars: only ever reached through the dynamic import
    // in src/lib/codeHighlight.ts, so this chunk loads on demand.
    if (id.includes("node_modules/highlight.js") || id.includes("node_modules/lowlight")) {
      return "vendor-highlight";
    }
    // Lazy (WalletDialog → @/lib/bitcoin), so keep it and its nested @noble
    // copies out of vendor-nostr. Left unnamed on purpose: rolldown pulls a
    // named chunk's dependencies in with it, which moved the shared
    // @scure/base out of vendor-nostr.
    if (id.includes("node_modules/@scure/btc-signer")) {
      return undefined;
    }
    if (id.includes("node_modules/@nostrify") || id.includes("node_modules/nostr-tools") || id.includes("node_modules/@noble") || id.includes("node_modules/@scure")) {
      return "vendor-nostr";
    }
    if (id.includes("node_modules/@radix-ui")) {
      return "vendor-radix";
    }
    if (id.includes("node_modules/@tanstack")) {
      return "vendor-tanstack";
    }
    if (id.includes("livekit")) {
      return "vendor-livekit";
    }
  }
  return undefined;
}

/** Named chunks the entry reaches statically (and so preloads). Hand-maintained. */
export const EAGERLY_PRELOADED_CHUNKS: ReadonlySet<string> = new Set([
  "vendor-react",
  "vendor-nostr",
  "vendor-radix",
  "vendor-tanstack",
  "lucide-icons",
]);
