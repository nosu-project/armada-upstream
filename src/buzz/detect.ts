/**
 * Buzz relay detection.
 *
 * A Buzz relay is recognized from its NIP-11 document. Two implementations
 * both speak the Buzz protocol (kind-9 NIP-10 threads, 40003 edits, the extra
 * timeline kinds) and advertise themselves differently:
 *
 *  - The reference relay (block/buzz) advertises
 *    `software: "https://github.com/block/buzz"` and a non-empty
 *    `supported_extensions` (custom Buzz NIPs like "nip-er"/"nip-pl").
 *  - newlay run in its `[buzz]` compatibility mode is a drop-in for that relay
 *    but advertises `software: "newlay"` and NO `supported_extensions` (it
 *    lists NIP-65535 in `supported_nips` instead). What it DOES expose only
 *    under `[buzz]` is `pairing_relay_url` (the NIP-AB rendezvous that stands
 *    in for Buzz's `buzz-pair-relay`), so on a newlay relay that field marks
 *    Buzz mode. A plain newlay relay advertises neither and stays standard
 *    NIP-29 (where a kind-9 NIP-10 reply is an inline quote, not a thread).
 *
 * Any signal flips the shared NIP-29 surfaces into Buzz mode.
 */

import { useEffect } from "react";

import { registerBuzzMediaHost } from "@/buzz/media";
import { useRelayInfo, type RelayInfoDocument } from "@/hooks/useRelayInfo";

/** Whether a NIP-11 document identifies a Buzz relay. */
export function isBuzzRelayInfo(info: RelayInfoDocument | undefined): boolean {
  if (!info) return false;
  const software = typeof info.software === "string" ? info.software : "";
  if (/block\/buzz/i.test(software)) return true;
  if (Array.isArray(info.supported_extensions) && info.supported_extensions.length > 0) return true;
  // newlay in Buzz-compat mode: `software: "newlay"` plus the `[buzz]`-gated
  // NIP-AB pairing URL. Both are required — a plain newlay relay exposes the
  // software string but not the pairing URL, and must stay standard NIP-29.
  if (/newlay/i.test(software) && typeof info.pairing_relay_url === "string" && info.pairing_relay_url) {
    return true;
  }
  return false;
}

/**
 * Whether `relayUrl` is a Buzz relay. `isBuzz` stays false until the NIP-11
 * doc resolves (`ready` distinguishes "not Buzz" from "not known yet");
 * useRelayInfo seeds from a persisted last-known-good doc, so on any relay
 * visited before this answers synchronously.
 */
export function useIsBuzzRelay(relayUrl: string | undefined): { isBuzz: boolean; ready: boolean } {
  const { data, isFetched } = useRelayInfo(relayUrl);
  const isBuzz = isBuzzRelayInfo(data);

  // Once a relay is known to be Buzz, register its host so Buzz-hosted media
  // (avatars, inline images) on it is fetched with BUD-11 GET auth instead of
  // 401-ing through a plain `<img src>`. The media host is the relay host.
  useEffect(() => {
    if (isBuzz && relayUrl) registerBuzzMediaHost(relayUrl);
  }, [isBuzz, relayUrl]);

  return { isBuzz, ready: Boolean(data) || isFetched };
}
