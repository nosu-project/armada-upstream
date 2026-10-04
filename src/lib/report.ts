/**
 * NIP-56 reports (kind 1984). The event shape is shared; the destination
 * ({@link ReportDestination}) follows from where it was raised: Concord →
 * giftwrapped to the Control Plane (staff only); NIP-29 → the host relay with
 * `h`; elsewhere → a PUBLIC note. Not a user choice.
 */

import type { AppScope } from "@/contexts/AppsContext";

/** NIP-56 report. */
export const KIND_REPORT = 1984;

/** NIP-56 report types, as in a `p`/`e` tag's third element. */
export type ReportReason =
  | "spam"
  | "nudity"
  | "profanity"
  | "illegal"
  | "impersonation"
  | "malware"
  | "other";

/** Menu order, plain words. */
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
  /** Reported person (x-only hex). */
  pubkey: string;
  /**
   * Reported message id; omit to report the person. NIP-17 DMs have no public
   * event, so DM reports (public) carry the person only.
   */
  eventId?: string;
}

/** NIP-56 tags: the reason rides `e` when a message is named, otherwise `p`. */
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
 * Destination for a report raised in `scope`. `undefined` for Concord
 * communities on a legacy pre-split epoch: no distinct Control Plane key, so an
 * "encrypted to moderators" report would be readable by everyone (including the
 * reported person). No report action there until they rotate.
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

/** One line telling the reporter who will see this. */
export function reportAudience(destination: ReportDestination): string {
  switch (destination.kind) {
    case "concord":
      // Encrypted to the Control Plane address: a claim about who CAN read it.
      return "Only this community's moderators can read it.";
    case "nip29":
      // The relay decides who may read it back, so this claims routing only.
      return "Sent to this server's moderators.";
    case "network":
      // Their own words go out in the clear; say so.
      return "This report is public. Anyone can read it, including your comment.";
  }
}
