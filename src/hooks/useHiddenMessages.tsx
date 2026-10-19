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
import { t } from "@/i18n";

export interface HiddenMessages {
  hiddenIds: ReadonlySet<string>;
  canHide: boolean;
  hide: (id: string) => void;
  unhide: (id: string) => void;
}

/**
 * Undo lives in the toast: a hidden message appears in no list to restore it from. Reads the
 * synchronous account marker (like {@link AppProvider}) so the filter answers on first render.
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
        title: t({ id: "useHiddenMessages.hidden.title", defaultMessage: "Message hidden" }),
        description: t({ id: "useHiddenMessages.hidden.description", defaultMessage: "Removed from your view on this device." }),
        action: (
          <ToastAction
            altText={t({ id: "useHiddenMessages.undoAlt", defaultMessage: "Undo hiding this message" })}
            onClick={() => unhideMessageId(pubkey, id)}
          >
            {t({ id: "useHiddenMessages.undo", defaultMessage: "Undo" })}
          </ToastAction>
        ),
      });
    },
    [pubkey],
  );

  return { hiddenIds, canHide: !!pubkey, hide, unhide };
}
