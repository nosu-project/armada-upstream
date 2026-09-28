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
 * DM peers let out of the request tier (app config, synced). No accept button:
 * recorded when the viewer replies or composes, so the row moves immediately.
 * Decoupled from following; blocking is the NIP-51 mute list.
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
