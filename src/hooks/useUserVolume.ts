import { useCallback, useSyncExternalStore } from "react";

import {
  getScreenShareVolume,
  getUserVolume,
  rememberScreenShareVolume,
  rememberUserVolume,
  subscribeUserVolumes,
} from "@/lib/voiceDevices";

/**
 * A user's persisted microphone playback volume (multiplier in [0, 2]:
 * 0 = muted, 1 = unchanged, 2 = 200%) as live React state. Backed by the shared
 * `voiceDevices` store, so every surface showing a control for the same pubkey
 * — the call-stage tile menus, the sidebar roster's context menu — reads and
 * writes one value, and the connected room applies changes live wherever they
 * were made.
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
