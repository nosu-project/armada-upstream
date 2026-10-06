import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { proveNotificationSettingsAbsence } from "@/lib/notificationSettingsProof";
import { SETTINGS_KIND, settingsDTag } from "@/lib/settingsDocs";

import type { NostrEvent } from "@nostrify/nostrify";

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const RELAYS = ["wss://one.example", "wss://two.example"];

function doc(name: "notifications" | "metadata", content: string): NostrEvent {
  return finalizeEvent(
    { kind: SETTINGS_KIND, content, tags: [["d", settingsDTag(name)]], created_at: 1_000 },
    sk,
  );
}

/** `answers[url]`: the relay's events, or `"fail"` for a CLOSED/error read. */
function client(answers: Record<string, NostrEvent[] | "fail">) {
  return {
    relay: (url: string) => ({
      query: () => {
        const answer = answers[url];
        return answer === "fail" || answer === undefined
          ? Promise.reject(new Error("closed"))
          : Promise.resolve(answer);
      },
    }),
  };
}

const plain = async (ciphertext: string) => ciphertext;
const prove = (answers: Record<string, NostrEvent[] | "fail">, relays = RELAYS) =>
  proveNotificationSettingsAbsence(client(answers), relays, pubkey, plain, new AbortController().signal);

describe("proveNotificationSettingsAbsence", () => {
  it("is absent only when every account relay answered with no document", async () => {
    expect(await prove({ [RELAYS[0]]: [], [RELAYS[1]]: [] })).toBe("absent");
  });

  it("is unknown while any relay failed to answer", async () => {
    expect(await prove({ [RELAYS[0]]: [], [RELAYS[1]]: "fail" })).toBe("unknown");
  });

  it("is unknown with no relays to ask", async () => {
    expect(await prove({}, [])).toBe("unknown");
  });

  it("is present when one relay holds the notifications document", async () => {
    expect(await prove({ [RELAYS[0]]: [], [RELAYS[1]]: [doc("notifications", "x")] })).toBe("present");
  });

  it("counts legacy notification fields in the metadata document as present", async () => {
    const legacy = doc("metadata", JSON.stringify({ notifLevels: {} }));
    expect(await prove({ [RELAYS[0]]: [legacy], [RELAYS[1]]: [] })).toBe("present");
  });

  it("is absent beside a metadata document without notification fields", async () => {
    const metadata = doc("metadata", JSON.stringify({}));
    expect(await prove({ [RELAYS[0]]: [metadata], [RELAYS[1]]: [] })).toBe("absent");
  });

  it("is unknown when the metadata document can't be read", async () => {
    const metadata = doc("metadata", "not json");
    expect(await prove({ [RELAYS[0]]: [metadata], [RELAYS[1]]: [] })).toBe("unknown");
  });
});
