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
  /** May be empty — the reason alone is a report. */
  comment: string;
}

/**
 * Send a NIP-56 report via the surface's normal path: Concord → giftwrap to the Control Plane;
 * NIP-29 → `h`-tagged event to the host relay; elsewhere → public event to the user's write relays
 * (readable by anyone, including the reported person).
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
          // The `h` tag files it with the group's moderators.
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
      // So a moderator with the queue open sees it without waiting for the poll.
      if (destination.kind === "concord") {
        queryClient.invalidateQueries({
          queryKey: ["concord", "reports", destination.communityIdHex],
        });
      }
    },
  });
}
