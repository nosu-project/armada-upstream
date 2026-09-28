import { useCallback } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { dmScopeKey } from "@/hooks/useNotifLevels";

/**
 * Per-conversation DM encryption preference:
 * - `auto`: prefer NIP-17; NIP-04 only on explicit opt-in.
 * - `nip17`: always NIP-17, best-effort to shared relays without a peer kind-10050.
 * - `nip04`: always legacy kind-4 (a privacy downgrade).
 */
export type DmProtocolPref = "auto" | "nip17" | "nip04";

export interface UseDmProtocolPrefReturn {
  pref: DmProtocolPref;
  setPref: (next: DmProtocolPref) => void;
}

/** Persisted to app config under `dm:${pubkey}` and synced; `auto` entries are pruned. */
export function useDmProtocolPref(peer: string): UseDmProtocolPrefReturn {
  const { config, updateConfig } = useAppContext();
  const key = dmScopeKey(peer);
  const pref = config.dmProtocol[key] ?? "auto";

  const setPref = useCallback(
    (next: DmProtocolPref) => {
      updateConfig((cur) => {
        const map = { ...cur.dmProtocol };
        if (next === "auto") delete map[key];
        else map[key] = next;
        return { ...cur, dmProtocol: map };
      });
    },
    [updateConfig, key],
  );

  return { pref, setPref };
}
