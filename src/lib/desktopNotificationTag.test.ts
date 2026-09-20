import { describe, expect, it } from "vitest";

import {
  chromiumNotificationId,
  desktopNotificationTag,
  WINDOWS_TOAST_TAG_MAX,
} from "./desktopNotificationTag";

const CHANNEL = "c2:" + "ab".repeat(32);
const DM = "dm:" + "cd".repeat(32);
const NIP29 = "nip29:wss://groups.some-long-relay-hostname.example.com/:general-chat";

describe("Windows toast tag", () => {
  it("proves the raw room keys the page used to tag with exceed Windows' limit", () => {
    // The breakage: before the digest, `tag: roomKey` reached Windows as
    // Chromium's id and every one of these failed put_Tag. Keep this so the
    // limit's arithmetic is written down where the tag is chosen.
    for (const roomKey of [CHANNEL, DM, NIP29]) {
      expect(chromiumNotificationId(roomKey).length).toBeGreaterThan(WINDOWS_TOAST_TAG_MAX);
    }
  });

  it("keeps the id Windows sees under the limit for every room key shape", () => {
    for (const roomKey of [CHANNEL, DM, NIP29, "", "armada"]) {
      expect(chromiumNotificationId(desktopNotificationTag(roomKey)).length).toBeLessThanOrEqual(
        WINDOWS_TOAST_TAG_MAX,
      );
    }
  });

  it("is stable per room, so repeated messages collapse into one entry", () => {
    expect(desktopNotificationTag(CHANNEL)).toBe(desktopNotificationTag(CHANNEL));
  });

  it("is distinct across rooms", () => {
    const tags = new Set([CHANNEL, DM, NIP29, "c2:" + "ab".repeat(31) + "ac"].map(desktopNotificationTag));
    expect(tags.size).toBe(4);
  });

  it("is alphanumeric, as the toast tag must be", () => {
    expect(desktopNotificationTag(NIP29)).toMatch(/^[0-9a-f]+$/);
  });
});
