import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { buildReportRumor, sealReport, wrapReport } from "@/concord/lib/report";
import { publishToAnyRelay } from "@/concord/lib/relayPublish";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import {
  buildReportTags,
  KIND_REPORT,
  type ReportDestination,
  type ReportReason,
  type ReportTarget,
} from "@/lib/report";

export interface SendReportArgs {
  destination: ReportDestination;
  target: ReportTarget;
  reason: ReportReason;
  /** The reporter's own words. May be empty — the reason alone is a report. */
  comment: string;
}

/**
 * Send a NIP-56 report to wherever its surface says it belongs.
 *
 * Each branch is the ordinary send path for that surface, not a new one: a
 * Concord report is a NIP-59 giftwrap to the Control Plane address published to
 * the community's relays; a NIP-29 report is an `h`-tagged event pinned to the
 * group's host relay, like every other kind-9000-series moderation event; and
 * everywhere else it is a plain signed event to the user's own write relays.
 *
 * The public branch is the reason the dialog says so out loud: outside a room
 * there are no moderators, so a report is a note to the network, and the
 * reporter's words are readable by anyone — including the person reported.
 */
export function useSendReport(): UseMutationResult<void, Error, SendReportArgs> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const publish = useNostrPublish();
  const queryClient = useQueryClient();

  return useMutation<void, Error, SendReportArgs>({
    mutationFn: async ({ destination, target, reason, comment }) => {
      if (!user) throw new Error("Sign in to report.");

      switch (destination.kind) {
        case "concord": {
          const rumor = buildReportRumor(target, reason, comment, user.pubkey);
          const seal = await sealReport(rumor, destination.controlPk, user.signer);
          await publishToAnyRelay(
            nostr,
            destination.relays,
            wrapReport(seal, destination.controlPk),
            "Couldn't reach this community's relays.",
          );
          return;
        }
        case "nip29": {
          // The `h` tag is what files this with the group; without it the relay
          // has no idea which moderators it concerns.
          await publish.mutateAsync({
            kind: KIND_REPORT,
            content: comment,
            tags: [["h", destination.groupId], ...buildReportTags(target, reason)],
            relay: destination.relayUrl,
          });
          return;
        }
        case "network": {
          await publish.mutateAsync({
            kind: KIND_REPORT,
            content: comment,
            tags: buildReportTags(target, reason),
          });
          return;
        }
      }
    },
    onSuccess: (_void, { destination }) => {
      // A moderator with the queue open should see their own community's new
      // report without waiting out the poll.
      if (destination.kind === "concord") {
        queryClient.invalidateQueries({
          queryKey: ["concord", "reports", destination.communityIdHex],
        });
      }
    },
  });
}
