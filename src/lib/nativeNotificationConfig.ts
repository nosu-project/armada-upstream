export type NativeNotificationEnablement = "unknown" | "enabled" | "disabled";

export type NativeNotificationConfigAction = "preserve" | "configure" | "disable";

/**
 * Whether a render may replace Android's durable notification config. Partial
 * snapshots are safe (native merges unready planes with last-good data); an
 * authoritative empty view may disable, a partial empty one never may.
 */
export function nativeNotificationConfigAction({
  loggedOut,
  enablement,
  allReady,
  nothingToWatch,
  persistedConfigEnabled,
  policyReady,
}: {
  loggedOut: boolean;
  enablement: NativeNotificationEnablement;
  allReady: boolean;
  nothingToWatch: boolean;
  persistedConfigEnabled: boolean | undefined;
  policyReady: boolean;
}): NativeNotificationConfigAction {
  if (enablement === "unknown") return "preserve";
  if (loggedOut || enablement === "disabled") return "disable";
  // A fresh account must not bootstrap from defaults before its NIP-78 settings
  // sync or a local last-good is found.
  if (!policyReady && persistedConfigEnabled !== true) return "preserve";
  if (allReady) return nothingToWatch ? "disable" : "configure";
  if (nothingToWatch && persistedConfigEnabled !== true) return "preserve";
  return "configure";
}
