/**
 * NIP-56 report shape and routing.
 *
 * The routing half matters more than it looks: `reportDestination` is the ONE
 * place that decides whether a report is confidential or public, and every
 * surface — message menu, member list, profile card — asks it rather than
 * deciding for itself.
 */

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { mintCommunity } from "@/concord/lib/community";
import type { Channel, Community } from "@/concord/lib/types";
import {
  buildReportTags,
  KIND_REPORT,
  reportAudience,
  reportDestination,
  REPORT_REASONS,
} from "@/lib/report";

const ALICE = "aa".repeat(32);
const MSG = "11".repeat(32);

/** A stand-in channel: `reportDestination` reads only the community. */
const CHANNEL = { idHex: "cc".repeat(32) } as unknown as Channel;

describe("NIP-56 report tags", () => {
  it("kind 1984", () => {
    expect(KIND_REPORT).toBe(1984);
  });

  it("a person report puts the reason on the p tag", () => {
    expect(buildReportTags({ pubkey: ALICE }, "spam")).toEqual([["p", ALICE, "spam"]]);
  });

  it("a message report puts the reason on the e tag, with a bare p pointer", () => {
    expect(buildReportTags({ pubkey: ALICE, eventId: MSG }, "illegal")).toEqual([
      ["e", MSG, "illegal"],
      ["p", ALICE],
    ]);
  });

  it("every offered reason is a NIP-56 report type", () => {
    const nip56 = ["nudity", "malware", "profanity", "illegal", "spam", "impersonation", "other"];
    for (const { value } of REPORT_REASONS) expect(nip56).toContain(value);
  });
});

describe("report routing", () => {
  it("no room means no moderator: the report is public", () => {
    const destination = reportDestination(undefined);
    expect(destination).toEqual({ kind: "network" });
    expect(reportAudience(destination!)).toMatch(/public/i);
  });

  it("a NIP-29 group routes to its host relay", () => {
    expect(
      reportDestination({ kind: "nip29", relayUrl: "wss://relay.example", groupId: "abc" }),
    ).toEqual({ kind: "nip29", relayUrl: "wss://relay.example", groupId: "abc" });
  });

  it("a split Concord community routes to its Control Plane address", () => {
    const owner = getPublicKey(generateSecretKey());
    const { community } = mintCommunity("Fleet", owner, ["wss://relay.example"]);
    const destination = reportDestination({ kind: "concord", community, channel: CHANNEL });
    expect(destination).toEqual({
      kind: "concord",
      communityIdHex: community.idHex,
      controlPk: community.controlPk,
      relays: community.relays,
    });
  });

  it("a LEGACY Concord community offers no report at all", () => {
    // No control_pk means the Control Plane is one key every member holds, so
    // "encrypted to the moderators" would in fact be readable by the person
    // being reported. There is no safe fallback — a public report would publish
    // a private room's contents — so the surface offers nothing.
    const owner = getPublicKey(generateSecretKey());
    const { community } = mintCommunity("Fleet", owner, []);
    const legacy: Community = { ...community, controlPk: undefined, controlRoot: undefined };
    expect(reportDestination({ kind: "concord", community: legacy, channel: CHANNEL })).toBeUndefined();
  });
});
