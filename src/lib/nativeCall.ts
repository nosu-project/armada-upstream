import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Native bridge to the Android ongoing-call foreground service
 * (ArmadaCallPlugin.java → CallForegroundService.java): the persistent "in a
 * voice call" notification, and — the reason it exists at all — the foreground
 * state that stops Android from freezing the backgrounded process out of its
 * own call and from silencing its microphone.
 *
 * Android-only. iOS would need CallKit, which is a different shape entirely
 * (a system call UI, not a notification), and the web has neither problem.
 */
export interface ArmadaCallPlugin {
  /**
   * Post or refresh the ongoing call notification, entering the foreground.
   * Idempotent: calling it again updates the labels and re-evaluates the
   * service type (the microphone type can only be claimed once RECORD_AUDIO
   * is granted, and calls are joined muted).
   */
  start(options: { title: string; text?: string }): Promise<void>;
  /** Tear the notification and the foreground state down. */
  stop(): Promise<void>;
  /** The notification's "Leave" button was tapped. */
  addListener(eventName: "hangup", listener: () => void): Promise<PluginListenerHandle>;
}

export const ArmadaCall = registerPlugin<ArmadaCallPlugin>("ArmadaCall");

/**
 * Whether the ongoing-call service is available.
 *
 * Gated on the platform being Android specifically — never
 * `isNativePlatform()`, which would route iOS into a `registerPlugin` proxy
 * with nothing behind it — plus `isPluginAvailable`, so an older APK that
 * predates the plugin degrades to today's behaviour instead of rejecting on
 * every call.
 */
export function hasNativeCallService(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("ArmadaCall");
}
