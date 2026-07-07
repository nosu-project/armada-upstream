import { useCallback, useSyncExternalStore } from "react";

import { getUserVolume, rememberUserVolume, subscribeUserVolumes } from "@/lib/voiceDevices";

/**
 * A user's persisted playback volume (multiplier, 0 = muted … 2 = boosted;
 * default 1) as live React state. Backed by the shared `voiceDevices` store,
 * so every surface showing a control for the same pubkey — the call-stage
 * tile menus, the sidebar roster's context menu — reads and writes one value,
 * and the connected room applies changes live wherever they were made.
 */
export function useUserVolume(pubkey: string): [number, (next: number) => void] {
  const volume = useSyncExternalStore(subscribeUserVolumes, () => getUserVolume(pubkey));
  const setVolume = useCallback((next: number) => rememberUserVolume(pubkey, next), [pubkey]);
  return [volume, setVolume];
}
