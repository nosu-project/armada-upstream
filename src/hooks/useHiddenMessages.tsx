import { useCallback, useSyncExternalStore } from "react";

import { ToastAction } from "@/components/ui/toast";
import { toast } from "@/hooks/useToast";
import { getActivePubkey, subscribeActivePubkey } from "@/lib/activeAccount";
import {
  getHiddenMessageIds,
  hideMessageId,
  subscribeHiddenMessages,
  unhideMessageId,
} from "@/lib/hiddenMessages";

export interface HiddenMessages {
  /** Ids hidden by this account, for the timeline filters. Stable reference. */
  hiddenIds: ReadonlySet<string>;
  /** Whether hiding should be offered at all (there is an active account). */
  canHide: boolean;
  /** Hide one message immediately, with an Undo toast. */
  hide: (id: string) => void;
  unhide: (id: string) => void;
}

/**
 * Everything a menu or timeline needs for per-message hiding, mirroring
 * {@link useMuteToggle}'s shape: the action sites get a one-liner, and the
 * undo lives in the toast because a hidden message appears in no list it
 * could be restored from.
 *
 * Reads the active account through the synchronous marker rather than the
 * login context, like {@link AppProvider} — the timeline filter must answer on
 * first render, and needs no signer.
 */
export function useHiddenMessages(): HiddenMessages {
  const pubkey = useSyncExternalStore(subscribeActivePubkey, getActivePubkey) ?? undefined;
  const hiddenIds = useSyncExternalStore(
    subscribeHiddenMessages,
    useCallback(() => getHiddenMessageIds(pubkey), [pubkey]),
  );

  const unhide = useCallback((id: string) => unhideMessageId(pubkey, id), [pubkey]);

  const hide = useCallback(
    (id: string) => {
      if (!pubkey) return;
      hideMessageId(pubkey, id);
      toast({
        title: "Message hidden",
        description: "Removed from your view on this device.",
        action: (
          <ToastAction altText="Undo hiding this message" onClick={() => unhideMessageId(pubkey, id)}>
            Undo
          </ToastAction>
        ),
      });
    },
    [pubkey],
  );

  return { hiddenIds, canHide: !!pubkey, hide, unhide };
}
