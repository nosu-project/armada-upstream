import { beforeEach, describe, expect, it } from "vitest";

import {
  _chatDecodeMemoSizeForTests,
  _resetChatMemoForTests,
  openChatBatch,
} from "./chat";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { Channel } from "./types";

/**
 * The chat decode memo (`chat.ts`) caches one entry per `wrapId|channelIdHex`
 * seen this session — including the "no held stream key" skips and malformed
 * wraps, which are cached as `null`. Nothing evicts across the session, so a
 * heavy account that ingests many distinct wraps grows it without bound. This
 * pins that it stays bounded.
 *
 * A channel with NO stream keys makes every wrap take the no-key path
 * (`openChatToSeal` caches `null` and returns), so we exercise the memo insert
 * with plain rumors and no crypto.
 */
const channelWithoutKeys: Channel = {
  idHex: "channel0",
  streams: [],
} as unknown as Channel;

function wrap(id: string): NostrRumor {
  return {
    id,
    pubkey: "b".repeat(64), // matches no stream in the empty channel
    kind: 20013,
    content: "",
    tags: [],
    created_at: 1_700_000_000,
  } as NostrRumor;
}

describe("chat decodeMemo growth", () => {
  beforeEach(() => {
    _resetChatMemoForTests();
  });

  it("does not grow without bound as distinct wraps are opened", async () => {
    const N = 30_000;
    // One wrap per call keeps openChatBatch on its synchronous no-yield path.
    for (let i = 0; i < N; i++) {
      await openChatBatch([wrap(`wrap-${i}`)], channelWithoutKeys);
    }

    const size = _chatDecodeMemoSizeForTests();
    // Currently FAILS: with no eviction, size === N.
    expect(size).toBeLessThan(N);
    expect(size).toBeLessThanOrEqual(20_000);
  });
});
