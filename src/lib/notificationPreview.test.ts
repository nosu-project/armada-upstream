import { describe, expect, it } from "vitest";

import {
  attributedLine,
  cleanContent,
  mediaLabel,
  mentionPubkeys,
  messageLine,
  NOTIFICATION_BADGE_ICON,
  NOTIFICATION_FALLBACK_ICON,
  presentNotification,
  reactionEmoji,
  truncate,
  type NotificationMessage,
} from "./notificationPreview";

// npub1... for a known hex pubkey, so the mention tests exercise the real
// bech32 decode rather than a stub.
const ALEX_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const ALEX_NPUB = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqshp52w2";
const ALEX_NPROFILE = "nprofile1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg7ncw7k";

function msg(over: Partial<NotificationMessage> = {}): NotificationMessage {
  return { plane: "c2", kind: 9, content: "hello", authorName: "alex", ...over };
}

describe("cleanContent", () => {
  it("strips inline media URLs, leaving no double space", () => {
    expect(cleanContent("a https://blossom.example/x.jpg b")).toBe("a b");
    expect(cleanContent("https://blossom.example/x.png")).toBe("");
  });

  it("keeps non-media links verbatim", () => {
    expect(cleanContent("read https://example.com/post")).toBe("read https://example.com/post");
  });

  it("strips a media URL carrying a query string", () => {
    expect(cleanContent("look https://cdn.example/a.webp?w=64 ok")).toBe("look ok");
  });

  it("resolves a mention to @name", () => {
    const names = new Map([[ALEX_HEX, "Alex"]]);
    expect(cleanContent(`hi nostr:${ALEX_NPUB} there`, names)).toBe("hi @Alex there");
  });

  it("resolves an nprofile mention too", () => {
    const names = new Map([[ALEX_HEX, "Alex"]]);
    expect(cleanContent(`hi nostr:${ALEX_NPROFILE}`, names)).toBe("hi @Alex");
  });

  it("leaves a mention it cannot name as the raw token", () => {
    // A wrong name is worse than a raw token — never guess.
    expect(cleanContent(`hi nostr:${ALEX_NPUB}`)).toBe(`hi nostr:${ALEX_NPUB}`);
  });

  it("ignores a malformed bech32 token", () => {
    expect(mentionPubkeys("nostr:npub1notrealatall")).toEqual([]);
    expect(cleanContent("nostr:npub1notrealatall")).toBe("nostr:npub1notrealatall");
  });

  it("collects each mentioned pubkey once", () => {
    expect(mentionPubkeys(`${ALEX_NPUB} and nostr:${ALEX_NPUB}`)).toEqual([ALEX_HEX]);
  });
});

describe("mediaLabel", () => {
  it("prefers the imeta MIME over the URL extension", () => {
    // A voice message recorded into a .webm container is only distinguishable
    // from video by its audio/* MIME.
    expect(mediaLabel("audio/webm", "https://x.example/a.webm")).toBe("a voice message");
    expect(mediaLabel(undefined, "https://x.example/a.webm")).toBe("a video");
  });

  it("labels by extension when no MIME is given", () => {
    expect(mediaLabel(undefined, "https://x.example/a.gif")).toBe("a GIF");
    expect(mediaLabel(undefined, "https://x.example/a.png")).toBe("an image");
    expect(mediaLabel(undefined, "https://x.example/a.mp3")).toBe("a voice message");
    expect(mediaLabel(undefined, "https://x.example/a.xdc")).toBe("a game");
  });

  it("labels an encrypted attachment, whose URL has no extension", () => {
    expect(mediaLabel("image/jpeg", "https://blossom.example/abcdef")).toBe("an image");
  });

  it("is undefined when nothing names a media kind", () => {
    expect(mediaLabel(undefined, "just text")).toBeUndefined();
  });
});

describe("reactionEmoji", () => {
  it("normalizes the NIP-25 shorthands", () => {
    expect(reactionEmoji("+")).toBe("👍");
    expect(reactionEmoji("")).toBe("👍");
    expect(reactionEmoji(undefined)).toBe("👍");
    expect(reactionEmoji("-")).toBe("👎");
  });

  it("unwraps a custom emoji shortcode", () => {
    expect(reactionEmoji(":partyparrot:")).toBe("partyparrot");
  });

  it("passes a real emoji through", () => {
    expect(reactionEmoji("🎉")).toBe("🎉");
  });
});

describe("truncate", () => {
  it("elides past the cap, counting the ellipsis", () => {
    const out = truncate("x".repeat(200));
    expect(out).toHaveLength(140);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short string alone", () => {
    expect(truncate("short")).toBe("short");
  });
});

describe("messageLine", () => {
  it("names the media when stripping URLs left nothing", () => {
    expect(messageLine(msg({ content: "https://x.example/a.png" }))).toBe("Sent an image");
  });

  it("prefixes a thread reply", () => {
    expect(messageLine(msg({ content: "yes", threadReply: true })))
      .toBe("Replied in thread: yes");
    expect(messageLine(msg({ content: "", threadReply: true }))).toBe("Replied in thread");
  });

  it("renders a reaction to your own message", () => {
    expect(messageLine(msg({ kind: 7, content: "+", reaction: true })))
      .toBe("Reacted 👍 to your message");
  });

  it("marks a mention in a room, but not in a DM", () => {
    expect(messageLine(msg({ content: "ping", mention: true }))).toBe("@you ping");
    expect(messageLine(msg({ plane: "dm", kind: 14, content: "ping", mention: true })))
      .toBe("ping");
  });

  it("falls back per plane when there is no content at all", () => {
    expect(messageLine(msg({ content: "" }))).toBe("Sent a message");
    expect(messageLine(msg({ plane: "dm", kind: 14, content: "" })))
      .toBe("Sent you a direct message");
    expect(messageLine(msg({ plane: "dm", kind: 15, content: "" }))).toBe("Sent a file");
  });
});

describe("presentNotification", () => {
  it("titles a room with the room and attributes the line to the sender", () => {
    const p = presentNotification(msg({
      roomTitle: "Armada / #general",
      roomImage: "https://img.example/community.png",
      authorAvatar: "https://img.example/alex.png",
    }));
    expect(p.title).toBe("Armada / #general");
    expect(p.body).toBe("alex: hello");
    // Android parity: a channel shows the COMMUNITY image, not the sender's.
    expect(p.icon).toBe("https://img.example/community.png");
    expect(p.badge).toBe(NOTIFICATION_BADGE_ICON);
  });

  it("titles a DM with the sender and leaves the body unattributed", () => {
    const p = presentNotification(msg({
      plane: "dm",
      kind: 14,
      authorAvatar: "https://img.example/alex.png",
    }));
    expect(p.title).toBe("alex");
    expect(p.body).toBe("hello");
    expect(p.icon).toBe("https://img.example/alex.png");
  });

  it("falls back to the sender's avatar when the room has no image", () => {
    const p = presentNotification(msg({
      roomTitle: "Armada / #general",
      authorAvatar: "https://img.example/alex.png",
    }));
    expect(p.icon).toBe("https://img.example/alex.png");
  });

  it("falls back to the app icon when nothing resolved", () => {
    expect(presentNotification(msg()).icon).toBe(NOTIFICATION_FALLBACK_ICON);
  });

  it("titles a room with no resolved name as Chat", () => {
    expect(presentNotification(msg()).title).toBe("Chat");
  });

  it("shows the room's recent lines when given, newest last", () => {
    const p = presentNotification(
      msg({ roomTitle: "Armada / #general" }),
      ["bob: first", "alex: hello"],
    );
    expect(p.body).toBe("bob: first\nalex: hello");
  });
});

describe("attributedLine", () => {
  it("matches what presentNotification would append", () => {
    const m = msg({ roomTitle: "Armada / #general" });
    expect(attributedLine(m)).toBe("alex: hello");
    expect(presentNotification(m).body).toBe(attributedLine(m));
  });
});
