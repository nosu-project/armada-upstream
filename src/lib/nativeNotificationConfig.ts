export type NativeNotificationEnablement = "unknown" | "enabled" | "disabled";

export type NativeNotificationConfigAction = "preserve" | "configure" | "disable";

/**
 * Decide whether a render may replace Android's durable notification config.
 *
 * Incomplete snapshots are safe to send because the native bridge replaces
 * ready planes and additively merges unready planes with same-account
 * last-good data. This action therefore gates the whole call only
 * when there is neither a known persisted config (whose local prefs may still
 * need updating) nor any useful partial watch. An authoritative empty view may
 * disable; a partial empty view never may.
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
  // A fresh account must not bootstrap from in-memory defaults before its
  // account-scoped NIP-78 settings synchronize or a proven local last-good is
  // found. A live persisted native config may continue with its own policy;
  // the native bridge verifies it is for this same pubkey before preserving.
  if (!policyReady && persistedConfigEnabled !== true) return "preserve";
  if (allReady) return nothingToWatch ? "disable" : "configure";
  if (nothingToWatch && persistedConfigEnabled !== true) return "preserve";
  return "configure";
}
