import { useCallback, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";

export interface UseAcceptedDmsReturn {
  /** The accepted peers (hex pubkeys). Order is insertion order, not meaningful. */
  accepted: string[];
  /** Membership test, stable across renders for the same accepted set. */
  isAccepted: (peer: string) => boolean;
  /** Let a peer out of the request tier and into the main conversation list. */
  accept: (peer: string) => void;
}

/**
 * Read/write the DM peers that have been let out of the request tier,
 * persisted to app config and synced across devices.
 *
 * NOT a user-facing action. There is no accept button: writing to someone is
 * accepting them, so this is only ever recorded when the viewer replies to a
 * request or picks a recipient in the compose pane. The cross-plane `mine`
 * flag would eventually say the same thing on its own, but it lags the
 * conversation queries — this is what moves the row in the same frame.
 *
 * Deliberately decoupled from following — see `acceptedDms` in AppConfig.
 * There is no inverse: blocking is the NIP-51 mute list (`useMuteUser`), which
 * removes the peer from both DM planes outright.
 */
export function useAcceptedDms(): UseAcceptedDmsReturn {
  const { config, updateConfig } = useAppContext();
  const accepted = config.acceptedDms;
  const acceptedSet = useMemo(() => new Set(accepted), [accepted]);

  const isAccepted = useCallback((peer: string) => acceptedSet.has(peer), [acceptedSet]);

  const accept = useCallback(
    (peer: string) => {
      updateConfig((cur) =>
        cur.acceptedDms.includes(peer)
          ? cur
          : { ...cur, acceptedDms: [...cur.acceptedDms, peer] },
      );
    },
    [updateConfig],
  );

  return { accepted, isAccepted, accept };
}
