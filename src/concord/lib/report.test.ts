/**
 * Concord reports — the giftwrap to the Control Plane address.
 *
 * The property under test is the one the feature rests on: a plain member can
 * ADDRESS staff without holding anything staff-only, and nobody else in the
 * room — including the member being reported, who holds the same community_root
 * every other member does — can read what was sent.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { getConversationKey, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { describe, expect, it } from "vitest";

import { mintCommunity } from "@/concord/lib/community";
import { rehydrateCommunity, toJoinMaterial, type CommunityListEntry } from "@/concord/lib/communityList";
import { currentControlGroup } from "@/concord/lib/control";
import { random32 } from "@/concord/lib/derive";
import { KIND_WRAP } from "@/concord/lib/kinds";
import {
  buildReportRumor,
  reportInboxSecret,
  reportSubject,
  sealReport,
  unwrapReport,
  wrapReport,
} from "@/concord/lib/report";
import type { Community } from "@/concord/lib/types";
import { KIND_REPORT } from "@/lib/report";

/** A login: signs, and NIP-44s with its own key (what every Concord signer does). */
function member(sk = generateSecretKey()) {
  return {
    sk,
    pubkey: getPublicKey(sk),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    nip44: {
      encrypt: async (pubkey: string, plaintext: string) =>
        nip44Encrypt(plaintext, getConversationKey(sk, pubkey)),
      decrypt: async (pubkey: string, ciphertext: string) =>
        nip44Decrypt(ciphertext, getConversationKey(sk, pubkey)),
    },
  };
}

/** A member's view of `c`: the address and read key, never the write secret. */
function memberView(c: Community): Community {
  const entry: CommunityListEntry = {
    community_id: c.idHex,
    seed: toJoinMaterial(c),
    current: { ...toJoinMaterial(c) },
    added_at: 1,
  };
  delete entry.current.control_root;
  return rehydrateCommunity(entry)!;
}

const ACCUSED = "bb".repeat(32);
const MSG = "11".repeat(32);

describe("reportInboxSecret", () => {
  it("staff hold it; a plain member does not", () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    expect(reportInboxSecret(community)).toBeDefined();
    expect(reportInboxSecret(memberView(community))).toBeUndefined();
  });

  it("a legacy epoch has no queue", () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const legacy: Community = { ...community, controlPk: undefined, controlRoot: undefined };
    expect(reportInboxSecret(legacy)).toBeUndefined();
  });

  it("a secret that doesn't derive to the held address fails closed", () => {
    const owner = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    expect(reportInboxSecret({ ...community, controlRoot: random32() })).toBeUndefined();
  });
});

describe("a report giftwrapped to the Control Plane", () => {
  it("round-trips: any member sends, only staff can read", async () => {
    const owner = member();
    const reporter = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const alice = memberView(community);

    // Alice is a plain member: no control_root, only the address.
    expect(alice.controlRoot).toBeUndefined();
    const rumor = buildReportRumor(
      { pubkey: ACCUSED, eventId: MSG },
      "spam",
      "posting invite links on repeat",
      reporter.pubkey,
    );
    const wrap = wrapReport(await sealReport(rumor, alice.controlPk!, reporter), alice.controlPk!);

    expect(wrap.kind).toBe(KIND_WRAP);
    // Ephemeral author, recipient in the `p` tag — the mirror image of a
    // Control Plane wrap (authored BY the address, random ephemeral `p`), so
    // the two can never be confused for one another.
    expect(wrap.pubkey).not.toBe(alice.controlPk);
    expect(wrap.tags).toContainEqual(["p", alice.controlPk]);
    expect(wrap.tags).toContainEqual(["k", String(KIND_REPORT)]);

    const opened = unwrapReport(wrap, reportInboxSecret(community)!)!;
    expect(opened).toBeDefined();
    expect(opened.wrapId).toBe(wrap.id);
    // The seal's verified author is who reported it — the only thing stopping
    // a flood of reports under invented names.
    expect(opened.reporter).toBe(reporter.pubkey);
    expect(opened.rumor.content).toBe("posting invite links on repeat");
    expect(reportSubject(opened.rumor)).toEqual({ pubkey: ACCUSED, eventId: MSG, reason: "spam" });
  });

  it("another member of the same community cannot read it", async () => {
    const owner = member();
    const reporter = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const alice = memberView(community);

    const rumor = buildReportRumor({ pubkey: ACCUSED }, "profanity", "", reporter.pubkey);
    const wrap = wrapReport(await sealReport(rumor, alice.controlPk!, reporter), alice.controlPk!);

    // The best a member can do is the Control Plane READ key, which every
    // member holds — and which is not the signer secret the wrap is addressed
    // to. There is nothing else for them to try.
    expect(currentControlGroup(alice).sk).toBeUndefined();
    expect(unwrapReport(wrap, random32())).toBeUndefined();
  });

  it("a wrap that opens but isn't a kind-1984 rumor is not a report", async () => {
    const owner = member();
    const reporter = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const controlPk = community.controlPk!;

    // The outer `k` tag is a relay-visible hint anyone can spell; the rumor's
    // own kind is the authority.
    const notAReport = { ...buildReportRumor({ pubkey: ACCUSED }, "spam", "", reporter.pubkey), kind: 9 };
    const wrap = wrapReport(await sealReport(notAReport, controlPk, reporter), controlPk);
    expect(unwrapReport(wrap, reportInboxSecret(community)!)).toBeUndefined();
  });

  it("a rumor claiming an author the seal didn't sign is dropped", async () => {
    const owner = member();
    const reporter = member();
    const { community } = mintCommunity("Fleet", owner.pubkey, []);
    const controlPk = community.controlPk!;

    // Standard NIP-59 anti-spoofing: without it, "who reported this" would be
    // whatever the sender typed.
    const lying = buildReportRumor({ pubkey: ACCUSED }, "spam", "", owner.pubkey);
    const wrap = wrapReport(await sealReport(lying, controlPk, reporter), controlPk);
    expect(unwrapReport(wrap, reportInboxSecret(community)!)).toBeUndefined();
  });

  it("garbage never throws — a scan loop just skips it", () => {
    const junk = finalizeEvent(
      { kind: KIND_WRAP, content: "not-ciphertext", tags: [], created_at: 1 },
      generateSecretKey(),
    );
    expect(unwrapReport(junk, random32())).toBeUndefined();
  });
});
