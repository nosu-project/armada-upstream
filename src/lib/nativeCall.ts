import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

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
  start(options: { title: string; text?: string }): Promise<void>;
  stop(): Promise<void>;
  /** The notification's "Leave" button was tapped. */
  addListener(eventName: "hangup", listener: () => void): Promise<PluginListenerHandle>;
}

export const ArmadaCall = registerPlugin<ArmadaCallPlugin>("ArmadaCall");

/**
 * Android only (not `isNativePlatform()`, which would hit an empty iOS proxy),
 * and `isPluginAvailable` so older APKs degrade gracefully.
 */
export function hasNativeCallService(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("ArmadaCall");
}
