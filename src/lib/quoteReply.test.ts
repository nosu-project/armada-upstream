import { describe, expect, it } from "vitest";
import { nip19 } from "nostr-tools";

import { inlineReplyQuoteId } from "@/lib/quoteReply";

const QUOTED = "dd50c4582599e6868ca5da887b74b97740f7d906b29eef8e021d8286f59a8c07";
const AUTHOR = "1739d937dc8c0c7370aa27585938c119e25c41f6c441a5d34c6d38503e3136ef";
const PARENT = "ab".repeat(32);
const NEVENT = nip19.neventEncode({ id: QUOTED, author: AUTHOR });

describe("inlineReplyQuoteId", () => {
  it("returns a q whose event the content does not reference", () => {
    expect(inlineReplyQuoteId({ content: "hi", tags: [["q", PARENT, "", AUTHOR]] })).toBe(PARENT);
  });

  it("ignores a q for an event embedded through a web link", () => {
    const content = `https://ditto.pub/${NEVENT}`;
    expect(inlineReplyQuoteId({ content, tags: [["q", QUOTED, "", AUTHOR]] })).toBeUndefined();
  });

  it("ignores q tags for nostr: and note1 references", () => {
    expect(inlineReplyQuoteId({ content: `look nostr:${NEVENT}`, tags: [["q", QUOTED]] })).toBeUndefined();
    expect(inlineReplyQuoteId({ content: nip19.noteEncode(QUOTED), tags: [["q", QUOTED]] })).toBeUndefined();
  });

  it("finds the reply parent beside an embed", () => {
    const tags = [["q", PARENT, "", AUTHOR], ["q", QUOTED, "", AUTHOR]];
    expect(inlineReplyQuoteId({ content: `nostr:${NEVENT}`, tags })).toBe(PARENT);
  });

  it("never treats an address coordinate as a parent", () => {
    expect(inlineReplyQuoteId({ content: "", tags: [["q", `30023:${AUTHOR}:post`]] })).toBeUndefined();
  });
});
