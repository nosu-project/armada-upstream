/** The Android call's output routes, as CallRouteSelector reports them. */

import { defineMessages, t } from "@/i18n";

export type CallRouteType = "bluetooth" | "usb" | "wired" | "speaker" | "earpiece";

export interface CallRoute {
  /** The system's AudioDeviceInfo id; stable for as long as the device is attached. */
  id: number;
  type: CallRouteType;
  /** The product name of an external device; empty for the phone's own. */
  name: string;
}

export interface CallRoutesSnapshot {
  /** False below Android 12 and off Android. */
  supported: boolean;
  routes: CallRoute[];
  /** The id the system is routing the call to, if it reports one. */
  active: number | null;
}

export const NO_CALL_ROUTES: CallRoutesSnapshot = { supported: false, routes: [], active: null };

const TYPE_LABELS = defineMessages({
  bluetooth: { id: "callRoutes.bluetooth", defaultMessage: "Bluetooth" },
  usb: { id: "callRoutes.usb", defaultMessage: "USB audio" },
  wired: { id: "callRoutes.wired", defaultMessage: "Wired headset" },
  speaker: { id: "callRoutes.speaker", defaultMessage: "Speaker" },
  earpiece: { id: "callRoutes.earpiece", defaultMessage: "Phone earpiece" },
}) satisfies Record<CallRouteType, unknown>;

/** An external device's own name where it has one, else its kind. */
export function routeLabel(route: CallRoute): string {
  const name = route.name.trim();
  if (name && (route.type === "bluetooth" || route.type === "usb")) return name;
  const label = TYPE_LABELS[route.type] as (typeof TYPE_LABELS)[CallRouteType] | undefined;
  if (label) return t(label);
  return name ?? t({ id: "callRoutes.audioDevice", defaultMessage: "Audio device" });
}
