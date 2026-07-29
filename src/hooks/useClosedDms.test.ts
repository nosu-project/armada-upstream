import { describe, expect, it } from "vitest";

import { SYNCED_CONFIG_KEYS } from "@/contexts/AppContext";
import { dmRemainsClosed } from "@/hooks/useClosedDms";
import { EncryptedSettingsSchema } from "@/lib/schemas";

const marker = { eventId: "old", createdAt: 100 };

describe("dmRemainsClosed", () => {
  it("keeps the conversation closed while its newest message is unchanged", () => {
    expect(dmRemainsClosed(marker, { id: "old", created_at: 100 })).toBe(true);
    expect(dmRemainsClosed(marker, { id: "older", created_at: 99 })).toBe(true);
  });

  it("reopens for a newer message", () => {
    expect(dmRemainsClosed(marker, { id: "new", created_at: 101 })).toBe(false);
  });

  it("reopens for a different message in the same timestamp second", () => {
    expect(dmRemainsClosed(marker, { id: "new", created_at: 100 })).toBe(false);
  });

  it("keeps an empty thread closed until it is explicitly reopened", () => {
    expect(dmRemainsClosed(marker, undefined)).toBe(true);
    expect(dmRemainsClosed(undefined, undefined)).toBe(false);
  });

  it("stores close markers in the encrypted cross-device settings payload", () => {
    expect(SYNCED_CONFIG_KEYS).toContain("closedDms");
    expect(
      EncryptedSettingsSchema.parse({ closedDms: { peer: marker } }).closedDms,
    ).toEqual({ peer: marker });
  });
});
