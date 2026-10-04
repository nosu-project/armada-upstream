/** The Android call's output routes, as CallRouteSelector reports them. */

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

const TYPE_LABELS: Record<CallRouteType, string> = {
  bluetooth: "Bluetooth",
  usb: "USB audio",
  wired: "Wired headset",
  speaker: "Speaker",
  earpiece: "Phone earpiece",
};

/** An external device's own name where it has one, else its kind. */
export function routeLabel(route: CallRoute): string {
  const name = route.name.trim();
  if (name && (route.type === "bluetooth" || route.type === "usb")) return name;
  return TYPE_LABELS[route.type] ?? name ?? "Audio device";
}
