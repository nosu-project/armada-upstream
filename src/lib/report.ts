/**
 * NIP-56 reports (kind 1984) — the transport-agnostic half.
 *
 * A report names WHO (a `p` tag) and optionally WHICH message (an `e` tag),
 * carries one machine-readable reason as the tag's third element, and puts the
 * reporter's own words in `content`. That shape is identical everywhere; what
 * differs per surface is only where the event goes, which is
 * {@link ReportDestination}:
 *
 *  - a Concord room delivers it giftwrapped to the room's Control Plane
 *    address, readable by staff alone (see `@/concord/lib/report`);
 *  - a NIP-29 server publishes it to the group's host relay with the group's
 *    `h` tag, exactly like every other moderation event;
 *  - everywhere else (DMs, a profile with no room around it) there is no
 *    moderator to route to, so the report is a PUBLIC note to the network.
 *
 * The destination is not a user choice. Offering one would ask the reporter to
 * understand three trust models before they can flag a message; the surface
 * they reported from already determines the only answer that makes sense.
 */

import type { AppScope } from "@/contexts/AppsContext";

/** NIP-56 report. */
export const KIND_REPORT = 1984;

/** The NIP-56 report types, as they appear in a `p`/`e` tag's third element. */
export type ReportReason =
  | "spam"
  | "nudity"
  | "profanity"
  | "illegal"
  | "impersonation"
  | "malware"
  | "other";

/** The reasons offered, in menu order — plain words, not NIP jargon. */
export const REPORT_REASONS: ReadonlyArray<{ value: ReportReason; label: string }> = [
  { value: "spam", label: "Spam or scam" },
  { value: "nudity", label: "Nudity or sexual content" },
  { value: "profanity", label: "Harassment or hateful speech" },
  { value: "illegal", label: "Illegal content" },
  { value: "impersonation", label: "Impersonation" },
  { value: "malware", label: "Malware or a dangerous link" },
  { value: "other", label: "Something else" },
];

/** What is being reported: a person, or one of their messages. */
export interface ReportTarget {
  /** The reported person (x-only hex). Always present — a message has an author. */
  pubkey: string;
  /**
   * The reported message's id, when the report was raised from a message. Omit
   * to report the person alone.
   *
   * Not every message has one that a recipient could resolve: a NIP-17 DM is an
   * unsigned rumor with no public event, so a DM report carries the person only
   * (see {@link reportDestination} — a DM report is public, and an id nobody
   * can fetch would leak the fact of the conversation while proving nothing).
   */
  eventId?: string;
}

/**
 * The NIP-56 tags for a report.
 *
 * When a message is named, the reason rides the `e` tag and the `p` tag is the
 * bare author pointer; when only a person is, the reason rides the `p` tag.
 * That is NIP-56's own split and the one every reader expects.
 */
export function buildReportTags(target: ReportTarget, reason: ReportReason): string[][] {
  return target.eventId
    ? [["e", target.eventId, reason], ["p", target.pubkey]]
    : [["p", target.pubkey, reason]];
}

/** Where a report goes, derived from the surface it was raised on. */
export type ReportDestination =
  | { kind: "concord"; communityIdHex: string; controlPk: string; relays: string[] }
  | { kind: "nip29"; relayUrl: string; groupId: string }
  | { kind: "network" };

/**
 * The destination for a report raised inside `scope` (the ambient chat scope,
 * absent in DMs and on a bare profile).
 *
 * Returns `undefined` when the surface has moderators in principle but cannot
 * reach them: a Concord community on a LEGACY pre-split epoch has no Control
 * Plane address distinct from the key every member holds, so "encrypted to the
 * moderators" would in fact be readable by everyone in the room — including the
 * person being reported. There is no safe fallback (a public report would
 * publish a private room's contents), so those rooms offer no report action at
 * all until they rotate onto a split epoch.
 */
export function reportDestination(scope: AppScope | undefined): ReportDestination | undefined {
  if (!scope) return { kind: "network" };
  switch (scope.kind) {
    case "nip29":
      return { kind: "nip29", relayUrl: scope.relayUrl, groupId: scope.groupId };
    case "concord": {
      const { community } = scope;
      if (!community.controlPk) return undefined;
      return {
        kind: "concord",
        communityIdHex: community.idHex,
        controlPk: community.controlPk,
        relays: community.relays,
      };
    }
  }
}

/** One line telling the reporter who will see this. The whole explanation. */
export function reportAudience(destination: ReportDestination): string {
  switch (destination.kind) {
    case "concord":
      // Encrypted to the Control Plane address: a claim about who CAN read it.
      return "Only this community's moderators can read it.";
    case "nip29":
      // The relay decides who may read it back, so this claims routing only.
      return "Sent to this server's moderators.";
    case "network":
      // The reporter's own words go out in the clear, which is the part they
      // would not otherwise expect — so say that, not just "it's public".
      return "This report is public — anyone can read it, including your comment.";
  }
}
