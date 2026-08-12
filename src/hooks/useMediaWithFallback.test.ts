import { describe, expect, it } from "vitest";

import { mediaCandidates } from "./useMediaWithFallback";

const HASH = "a".repeat(64);
const PRIMARY = `https://one.example/${HASH}`;

/**
 * The order a media reference is walked, and — more to the point — what is
 * allowed into that walk at all. Sender-declared `fallback` entries come
 * straight off an untrusted event, and every candidate here ends up in a
 * `fetch` or an `<img src>`.
 */
describe("mediaCandidates", () => {
  it("starts with the primary URL", () => {
    expect(mediaCandidates(PRIMARY, undefined, [])[0]).toBe(PRIMARY);
  });

  it("puts declared fallbacks ahead of derived Blossom mirrors", () => {
    // The sender knows where they put the blob; a mirror is a guess that a
    // content-addressed copy exists there.
    const candidates = mediaCandidates(PRIMARY, ["https://declared.example/blob"], [
      "https://mirror.example",
    ]);
    expect(candidates).toEqual([
      PRIMARY,
      "https://declared.example/blob",
      `https://mirror.example/${HASH}`,
    ]);
  });

  it("drops a `javascript:` fallback", () => {
    expect(mediaCandidates(PRIMARY, ["javascript:alert(1)"], [])).toEqual([PRIMARY]);
  });

  it("drops local-network fallbacks", () => {
    // A pinned or forwarded http://192.168.x.x would otherwise have every
    // viewer probing their own LAN on every render.
    const candidates = mediaCandidates(
      PRIMARY,
      ["http://192.168.1.5/blob", "http://localhost:8080/blob", "http://[::1]/blob"],
      [],
    );
    expect(candidates).toEqual([PRIMARY]);
  });

  it("keeps a well-formed https fallback", () => {
    expect(mediaCandidates(PRIMARY, ["https://other.example/blob"], [])).toEqual([
      PRIMARY,
      "https://other.example/blob",
    ]);
  });

  it("does not repeat a source", () => {
    const candidates = mediaCandidates(
      PRIMARY,
      [PRIMARY, "https://other.example/blob", "https://other.example/blob"],
      [],
    );
    expect(candidates).toEqual([PRIMARY, "https://other.example/blob"]);
  });

  it("leaves a non-content-addressed URL with no derived mirrors", () => {
    const url = "https://one.example/photo.jpg";
    expect(mediaCandidates(url, undefined, ["https://mirror.example"])).toEqual([url]);
  });
});
