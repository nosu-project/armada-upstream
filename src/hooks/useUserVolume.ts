import { useCallback, useSyncExternalStore } from "react";

import {
  getScreenShareVolume,
  getUserVolume,
  rememberScreenShareVolume,
  rememberUserVolume,
  subscribeUserVolumes,
} from "@/lib/voiceDevices";

/**
 * A user's persisted mic playback volume (multiplier in [0, 2]) as live React
 * state, shared across every surface via the `voiceDevices` store.
 */
export function useUserVolume(pubkey: string): [number, (next: number) => void] {
  const volume = useSyncExternalStore(subscribeUserVolumes, () => getUserVolume(pubkey));
  const setVolume = useCallback((next: number) => rememberUserVolume(pubkey, next), [pubkey]);
  return [volume, setVolume];
}

/** A user's independently persisted screen-share playback volume. */
export function useScreenShareVolume(pubkey: string): [number, (next: number) => void] {
  const volume = useSyncExternalStore(subscribeUserVolumes, () => getScreenShareVolume(pubkey));
  const setVolume = useCallback(
    (next: number) => rememberScreenShareVolume(pubkey, next),
    [pubkey],
  );
  return [volume, setVolume];
}
