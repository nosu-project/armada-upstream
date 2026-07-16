import { describe, expect, it } from "vitest";

import { isChunkLoadError } from "@/lib/chunkReload";

describe("isChunkLoadError", () => {
  it("matches failed dynamic-import messages (pruned chunk hash)", () => {
    for (const m of [
      "TypeError: Failed to fetch dynamically imported module: https://x/assets/a.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Loading chunk 42 failed.",
      "Loading CSS chunk 7 failed.",
      "ChunkLoadError: Loading chunk foo failed",
      "Expected a JavaScript module but got text/html; not a valid JavaScript MIME type",
    ]) {
      expect(isChunkLoadError(new Error(m)), m).toBe(true);
    }
  });

  it("matches the mismatched-React render crash from a mixed old/new vendor boot", () => {
    // Real report (Firefox): an old cached vendor-radix wired to a fresh
    // vendor-react calls a hook on the "other" React's null dispatcher.
    for (const m of [
      "TypeError: c.useContext(...) is null",
      "c.useContext(...) is null",
      "Cannot read properties of null (reading 'useContext')",
      "Cannot read property 'useState' of null",
      "null is not an object (evaluating 'n.useRef')",
      "Invalid hook call. Hooks can only be called inside of the body of a function component.",
    ]) {
      expect(isChunkLoadError(new Error(m)), m).toBe(true);
    }
  });

  it("does NOT match ordinary application errors (avoids reload loops)", () => {
    for (const m of [
      "Cannot read properties of undefined (reading 'foo')",
      "user is null",
      "TypeError: something.useThing is defined",
      "Cannot read property 'name' of null",
      "Network request failed",
    ]) {
      expect(isChunkLoadError(new Error(m)), m).toBe(false);
    }
  });

  it("handles non-Error values without throwing", () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError("Loading chunk 3 failed")).toBe(true);
  });
});
