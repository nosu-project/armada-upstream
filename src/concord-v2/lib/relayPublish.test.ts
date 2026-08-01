import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { publishToAnyRelay } from "./relayPublish";

const event = finalizeEvent({ kind: 1, content: "", tags: [], created_at: 1 }, generateSecretKey());

describe("publishToAnyRelay", () => {
  it("returns after the first relay accepts without waiting for the others", async () => {
    let finishSlow!: () => void;
    const slow = vi.fn(() => new Promise<void>((resolve) => (finishSlow = resolve)));
    const fast = vi.fn(() => Promise.resolve());
    const nostr = {
      relay: (url: string) => ({ event: url === "wss://slow.test" ? slow : fast }),
    };

    await publishToAnyRelay(nostr, ["wss://slow.test", "wss://fast.test"], event, "No relay accepted.");

    // Both were attempted — the slow one is still in flight, not abandoned.
    expect(slow).toHaveBeenCalledOnce();
    expect(fast).toHaveBeenCalledOnce();
    finishSlow();
  });

  it("preserves the caller's error when every relay rejects", async () => {
    const nostr = {
      relay: () => ({ event: vi.fn(() => Promise.reject(new Error("offline"))) }),
    };

    await expect(
      publishToAnyRelay(nostr, ["wss://offline.test"], event, "No relay accepted."),
    ).rejects.toThrow("No relay accepted.");
  });
});
