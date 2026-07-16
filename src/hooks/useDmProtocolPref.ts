import { useCallback } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { dmScopeKey } from "@/hooks/useNotifLevels";

/**
 * A per-conversation DM encryption preference:
 *   - `auto`  — the default. Prefer private NIP-17 (gift-wrapped kind 14),
 *               falling back to legacy NIP-04 only on explicit opt-in.
 *   - `nip17` — always send private (NIP-17), best-effort to shared relays
 *               when the peer hasn't published a kind-10050 inbox.
 *   - `nip04` — always send legacy kind-4 (a privacy downgrade).
 */
export type DmProtocolPref = "auto" | "nip17" | "nip04";

export interface UseDmProtocolPrefReturn {
  /** The chosen protocol for this peer (`auto` when nothing is set). */
  pref: DmProtocolPref;
  /** Set (or reset to `auto`) the protocol for this peer, persisted + synced. */
  setPref: (next: DmProtocolPref) => void;
}

/**
 * Read/write the user's per-conversation DM encryption preference for `peer`,
 * persisted to app config (keyed by `dm:${pubkey}`) and synced across devices.
 * `auto` entries are pruned so the map stays sparse.
 */
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
