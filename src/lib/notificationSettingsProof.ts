import { queryExplicitRelaysWithStatus, uniqueRelayUrls } from "@/lib/nip65";
import { hasMigratedKeys, parseSettingsDoc, SETTINGS_KIND, settingsDTag } from "@/lib/settingsDocs";
import { settingsRootDTag } from "@/lib/settingsRoot";

import type { NostrEvent } from "@nostrify/nostrify";

type RelayClient = Parameters<typeof queryExplicitRelaysWithStatus>[0];

/** Whether the account's notification policy is a published document, provably none, or unknown. */
export type NotificationSettingsVerdict = "absent" | "present" | "unknown";

function newestWithDTag(events: NostrEvent[], dTag: string): NostrEvent | undefined {
  let newest: NostrEvent | undefined;
  for (const event of events) {
    if (!event.tags.some(([name, value]) => name === "d" && value === dTag)) continue;
    if (!newest || event.created_at > newest.created_at) newest = event;
  }
  return newest;
}

/**
 * The same proof `useInitialSync` attempts at login, without its grace cut-off:
 * every account relay must answer (EOSE) before "no notifications document" is
 * believed, since an unanswered relay may hold one. A legacy `metadata` document
 * still carrying notification fields counts as present. With a settings root on
 * the relays, the derived notifications document must be asked for too, so a
 * caller that does not hold the root (`derived` absent) can prove nothing.
 */
export async function proveNotificationSettingsAbsence(
  nostr: RelayClient,
  relays: string[],
  pubkey: string,
  decryptSelf: (ciphertext: string) => Promise<string>,
  signal: AbortSignal,
  derived?: { pubkey: string; d: string },
): Promise<NotificationSettingsVerdict> {
  const expected = uniqueRelayUrls(relays);
  if (expected.length === 0) return "unknown";
  const read = await queryExplicitRelaysWithStatus(
    nostr,
    expected,
    [{
      kinds: [SETTINGS_KIND],
      authors: [pubkey],
      "#d": [settingsDTag("notifications"), settingsDTag("metadata"), settingsRootDTag()],
    }, ...(derived ? [{ kinds: [SETTINGS_KIND], authors: [derived.pubkey], "#d": [derived.d] }] : [])],
    signal,
  );
  if (read.failed.length > 0 || read.answered.length !== expected.length) return "unknown";
  const own = read.events.filter((event) => event.pubkey === pubkey);
  if (newestWithDTag(own, settingsDTag("notifications"))) return "present";
  if (derived && newestWithDTag(read.events.filter((event) => event.pubkey === derived.pubkey), derived.d)) {
    return "present";
  }
  if (!derived && newestWithDTag(own, settingsRootDTag())) return "unknown";
  const metadata = newestWithDTag(own, settingsDTag("metadata"));

  if (!metadata?.content) return "absent";
  try {
    const parsed = parseSettingsDoc("metadata", JSON.parse(await decryptSelf(metadata.content)));
    if (!parsed) return "unknown";
    return hasMigratedKeys(parsed.doc, "notifications") ? "present" : "absent";
  } catch {
    return "unknown";
  }
}
