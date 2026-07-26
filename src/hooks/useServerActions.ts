import { useNavigate } from "react-router-dom";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutes } from "@/hooks/useMutes";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { PINNED_RAIL_RELAYS, relayToRouteParam } from "@/lib/platform";
import { writeClipboardText } from "@/lib/clipboard";
import { isPublishQueuedError } from "@/lib/publishOutbox";
import { shareOrigin } from "@/lib/shareOrigin";

export interface UseServerActionsReturn {
  /** Whether this server is currently muted. */
  serverMuted: boolean;
  /**
   * Whether the server can be removed. Removal means deleting it from the
   * user's kind 10009 list, so it needs a logged-in user; opt-in build-time
   * pinned relays (`VITE_PIN_PLATFORM_RELAYS`, off by default) are never
   * removable.
   */
  isRemovable: boolean;
  /** Toggle the server's muted state. */
  toggleMute: () => void;
  /** Copy a shareable link to this server to the clipboard. */
  copyLink: () => void;
  /** Remove the server from the user's group list and rail, then go home. */
  removeServer: () => void;
}

/**
 * Server-level actions (mute, copy link, remove) shared by the rail's context
 * menu, the desktop welcome pane (`ServerPage`) and the mobile-accessible
 * channel-sidebar header menu, so the three surfaces can't drift.
 */
export function useServerActions(relayUrl: string): UseServerActionsReturn {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { isCommunityMuted, toggleCommunityMute } = useMutes();

  const serverMuted = isCommunityMuted(relayUrl);
  // Any non-pinned server the user can navigate to is removable — including
  // one whose relay is now offline, since removal only edits the user's own
  // list. Logged out there is no list, so there is nothing to remove.
  const isRemovable = Boolean(user) && !PINNED_RAIL_RELAYS.includes(relayUrl);

  const toggleMute = () => toggleCommunityMute(relayUrl);

  const copyLink = () => {
    const link = `${shareOrigin()}/s/${relayToRouteParam(relayUrl)}`;
    writeClipboardText(link).then(
      () => toast({ title: "Copied link" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const removeServer = () => {
    if (!user) return;

    // The kind 10009 list is the ONLY store for added servers, so this write
    // is the removal — `remove-server` drops the `r` tag, every joined `group`
    // on that relay, and the rail-layout key for it. This used to `console.warn`
    // the rejection and show the success toast regardless, so a refused write
    // (empty/undecryptable read) or a dead relay looked identical to a removal
    // that worked, and the server came back at the next sync with no
    // indication why.
    const pending = updateList({ type: "remove-server", url: relayUrl });
    navigate("/");
    pending.then(
      () => toast({ title: "Server removed", description: relayUrl }),
      (err) => {
        // A queued publish is signed and durably stored; the retry worker
        // will land it. That's a delay, not a failure.
        if (isPublishQueuedError(err)) {
          toast({
            title: "Server removed",
            description: `${relayUrl} — syncing when the network is back.`,
          });
          return;
        }
        console.warn("Failed to sync server removal to group list:", err);
        toast({
          title: "Couldn't remove server everywhere",
          description:
            `Hidden on this device, but your synced community list still has ${relayUrl}` +
            ` — it will come back on other devices. ${err instanceof Error ? err.message : ""}`.trimEnd(),
          variant: "destructive",
        });
      },
    );
  };

  return { serverMuted, isRemovable, toggleMute, copyLink, removeServer };
}
