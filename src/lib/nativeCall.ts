import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import type { CallRoutesSnapshot } from "@/lib/callRoutes";

/**
 * Bridge to the Android ongoing-call foreground service (ArmadaCallPlugin.java):
 * the call notification, plus foreground state so Android doesn't freeze the
 * process or silence its mic in the background. Android only.
 */
export interface ArmadaCallPlugin {
  /**
   * Post or refresh the call notification. Idempotent; re-evaluates the service
   * type since the microphone type needs RECORD_AUDIO (calls are joined muted).
   */
  start(options: { title: string; text?: string; icon?: string }): Promise<void>;
  stop(): Promise<void>;
  /** `published`: a mic track exists, so the button can toggle without bringing the app forward. */
  setMic(options: { muted: boolean; published: boolean }): Promise<void>;
  /** The notification's hang-up button was tapped. */
  addListener(eventName: "hangup", listener: () => void): Promise<PluginListenerHandle>;
  /** The notification's mute button was tapped. */
  addListener(eventName: "toggleMute", listener: () => void): Promise<PluginListenerHandle>;
  /** The call's output routes (Android 12+); `supported: false` elsewhere. */
  listRoutes(): Promise<CallRoutesSnapshot>;
  /** Route the call to `id` for the rest of the call; `ok: false` if gone or refused. */
  selectRoute(options: { id: number }): Promise<{ ok: boolean }>;
  /** A route appeared or left, or the active one switched. */
  addListener(
    eventName: "routesChanged",
    listener: (snapshot: CallRoutesSnapshot) => void,
  ): Promise<PluginListenerHandle>;
}

export const ArmadaCall = registerPlugin<ArmadaCallPlugin>("ArmadaCall");

/**
 * Android only (not `isNativePlatform()`, which would hit an empty iOS proxy),
 * and `isPluginAvailable` so older APKs degrade gracefully.
 */
export function hasNativeCallService(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("ArmadaCall");
}
