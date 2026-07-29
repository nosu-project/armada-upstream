import { describe, expect, it } from "vitest";

import {
  KIND_APP_SPECIFIC,
  queryKeysForSelfEvent,
  T_ARMADA_GIF_FAVORITES,
} from "@/lib/selfSyncKinds";

describe("queryKeysForSelfEvent", () => {
  it("routes encrypted GIF favorite shards to their sync query", () => {
    expect(
      queryKeysForSelfEvent(
        KIND_APP_SPECIFIC,
        "armada/gif-favorites/device-id",
        T_ARMADA_GIF_FAVORITES,
      ),
    ).toEqual([["favorite-gifs-sync"]]);
  });

  it("does not route unrelated NIP-78 documents by their d-tag prefix", () => {
    expect(queryKeysForSelfEvent(KIND_APP_SPECIFIC, "armada/gif-favorites/device-id"))
      .toEqual([]);
  });
});
