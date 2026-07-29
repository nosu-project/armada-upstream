import { describe, expect, it } from "vitest";

import {
  KIND_DM_CHAT,
  KIND_DM_FILE,
  KIND_DM_REACTION,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import { dm17NotifyCandidates } from "@/wire/notify";

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
    peer: PEER,
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
