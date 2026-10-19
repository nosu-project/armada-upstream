import { useNavigate } from "react-router-dom";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutes } from "@/hooks/useMutes";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { t } from "@/i18n";
import { relayToRouteParam } from "@/lib/platform";
import { writeClipboardText } from "@/lib/clipboard";
import { isPublishQueuedError } from "@/lib/publishOutbox";
import { shareOrigin } from "@/lib/shareOrigin";

export interface UseServerActionsReturn {
  serverMuted: boolean;
  /** Removal edits the user's kind 10009 list, so it needs a logged-in user. */
  isRemovable: boolean;
  toggleMute: () => void;
  copyLink: () => void;
  removeServer: () => void;
}

/** Shared by the rail menu, `ServerPage` and the sidebar header menu so they can't drift. */
export function useServerActions(relayUrl: string): UseServerActionsReturn {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { isCommunityMuted, toggleCommunityMute } = useMutes();

  const serverMuted = isCommunityMuted(relayUrl);
  // Removal only edits the user's list, so offline relays are removable too.
  const isRemovable = Boolean(user);

  const toggleMute = () => toggleCommunityMute(relayUrl);

  const copyLink = () => {
    const link = `${shareOrigin()}/s/${relayToRouteParam(relayUrl)}`;
    writeClipboardText(link).then(
      () => toast({ title: t({ id: "useServerActions.copiedLink", defaultMessage: "Copied link" }) }),
      () => toast({ title: t({ id: "useServerActions.copyFailed", defaultMessage: "Copy failed" }), variant: "destructive" }),
    );
  };

  const removeServer = () => {
    if (!user) return;

    // The kind 10009 list is the ONLY store of added servers, so this write IS the removal (drops
    // the `r` tag, its `group`s and the rail key). Failures must be surfaced, not toasted as success.
    const pending = updateList({ type: "remove-server", url: relayUrl });
    navigate("/");
    pending.then(
      () => toast({ title: t({ id: "useServerActions.removed", defaultMessage: "Server removed" }), description: relayUrl }),
      (err) => {
        // Queued publishes are signed and durable; a delay, not a failure.
        if (isPublishQueuedError(err)) {
          toast({
            title: t({ id: "useServerActions.removed", defaultMessage: "Server removed" }),
            description: t(
              { id: "useServerActions.removedQueued", defaultMessage: "{relayUrl} will sync when the network is back." },
              { relayUrl },
            ),
          });
          return;
        }
        console.warn("Failed to sync server removal to group list:", err);
        toast({
          title: t({ id: "useServerActions.removeFailed", defaultMessage: "Couldn't remove server everywhere" }),
          description: t(
            {
              id: "useServerActions.removeFailedDescription",
              defaultMessage: "Hidden on this device, but your synced community list still has {relayUrl}, so it will come back on other devices. {reason}",
            },
            { relayUrl, reason: err instanceof Error ? err.message : "" },
          ).trimEnd(),
          variant: "destructive",
        });
      },
    );
  };

  return { serverMuted, isRemovable, toggleMute, copyLink, removeServer };
}
