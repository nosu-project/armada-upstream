import { useNavigate } from "react-router-dom";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutes } from "@/hooks/useMutes";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { normalizeRelayUrl, PINNED_RAIL_RELAYS, relayToRouteParam } from "@/lib/platform";
import { writeClipboardText } from "@/lib/clipboard";
import { addServerTombstone } from "@/lib/serverTombstone";
import { shareOrigin } from "@/lib/shareOrigin";

export interface UseServerActionsReturn {
  /** Whether this server is currently muted. */
  serverMuted: boolean;
  /**
   * Whether the server can be removed. A server is removable unless it's an
   * opt-in build-time pinned relay (`VITE_PIN_PLATFORM_RELAYS`, off by default).
   */
  isRemovable: boolean;
  /** Toggle the server's muted state. */
  toggleMute: () => void;
  /** Copy a shareable link to this server to the clipboard. */
  copyLink: () => void;
  /** Remove the server locally (and from the synced group list), then go home. */
  removeServer: () => void;
}

/**
 * Server-level actions (mute, copy link, remove) shared by the desktop welcome
 * pane (`ServerPage`) and the mobile-accessible channel-sidebar header menu.
 * Keeping the removal logic — including the tombstone that stops a stale relay
 * from re-adding the rail icon — in one place avoids the two surfaces drifting.
 */
export function useServerActions(relayUrl: string): UseServerActionsReturn {
  const navigate = useNavigate();
  const { updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { isCommunityMuted, toggleCommunityMute } = useMutes();

  const serverMuted = isCommunityMuted(relayUrl);
  // Compare by NORMALIZED url, not raw string equality: any non-pinned server
  // the user can navigate to should be removable — including one whose relay is
  // now offline (removal is purely local).
  const isRemovable = !PINNED_RAIL_RELAYS.includes(relayUrl);

  const toggleMute = () => toggleCommunityMute(relayUrl);

  const copyLink = () => {
    const link = `${shareOrigin()}/s/${relayToRouteParam(relayUrl)}`;
    writeClipboardText(link).then(
      () => toast({ title: "Copied link" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const removeServer = () => {
    updateConfig((current) => ({
      ...current,
      // Drop every stored entry that normalizes to this server, so a
      // trailing-slash/casing variant can't linger and re-add the rail icon.
      addedRelays: current.addedRelays.filter(
        (url) => normalizeRelayUrl(url) !== relayUrl,
      ),
    }));
    if (user) {
      // Tombstone the removal so a stale relay echoing the pre-removal 10009
      // list can't re-add this server via NostrSync's hydration before the
      // update propagates. Cleared once a read confirms it's gone.
      addServerTombstone(user.pubkey, relayUrl);
      updateList({ type: "remove-server", url: relayUrl }).catch((err) =>
        console.warn("Failed to sync server removal to group list:", err));
    }
    toast({ title: "Server removed", description: relayUrl });
    navigate("/");
  };

  return { serverMuted, isRemovable, toggleMute, copyLink, removeServer };
}
