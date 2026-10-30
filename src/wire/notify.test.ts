import { describe, expect, it, vi } from "vitest";

import {
  KIND_DM_CHAT,
  KIND_DM_FILE,
  KIND_DM_REACTION,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import {
  dm17NotifyCandidates,
  ingestPushedEvent,
  noteWrapsOpened,
  registerPushedEventIngest,
  wrapOpenedThisSession,
} from "@/wire/notify";

import type { NostrEvent } from "@nostrify/nostrify";

const SELF = "1".repeat(64);
const PEER = "2".repeat(64);

function opened(overrides: Partial<OpenedDm> = {}): OpenedDm {
  return {
    rumorId: "rumor",
    author: PEER,
    kind: KIND_DM_CHAT,
    content: "hello",
    tags: [["p", SELF]],
    createdAt: 123,
    peers: [PEER],
    wrapId: "wrap",
    ...overrides,
  };
}

describe("dm17NotifyCandidates", () => {
  it("emits incoming chat and file messages with the decrypted peer room key", () => {
    expect(dm17NotifyCandidates([
      opened(),
      opened({ rumorId: "file", kind: KIND_DM_FILE, content: "encrypted metadata" }),
    ], SELF)).toEqual([
      expect.objectContaining({
        plane: "dm",
        author: PEER,
        peer: PEER,
        roomKey: `dm:${PEER}`,
        body: "hello",
        eventId: "rumor",
        wrapId: "wrap",
      }),
      expect.objectContaining({ body: "Sent a file", eventId: "file" }),
    ]);
  });

  it("does not notify for self-copies or non-message rumors", () => {
    expect(dm17NotifyCandidates([
      opened({ author: SELF }),
      opened({ rumorId: "reaction", kind: KIND_DM_REACTION }),
    ], SELF)).toEqual([]);
  });
});

describe("pushed wraps", () => {
  const wrap = { id: "w1", kind: 1059 } as NostrEvent;

  it("remembers the wraps this page opened", () => {
    expect(wrapOpenedThisSession("opened-1")).toBe(false);
    noteWrapsOpened(["opened-1"]);
    expect(wrapOpenedThisSession("opened-1")).toBe(true);
  });

  it("runs a pushed event through the registered ingest, and reports when there is none", async () => {
    expect(await ingestPushedEvent(wrap)).toBe(false);
    const ingest = vi.fn(async () => undefined);
    const unregister = registerPushedEventIngest(ingest);
    expect(await ingestPushedEvent(wrap)).toBe(true);
    expect(ingest).toHaveBeenCalledWith(wrap);
    unregister();
    expect(await ingestPushedEvent(wrap)).toBe(false);
  });
});
