/**
 * Buzz relay detection.
 *
 * A Buzz relay is recognized from its NIP-11 document: the reference
 * implementation advertises `software: "https://github.com/block/buzz"`, and
 * Buzz deployments also expose `supported_extensions` (custom Buzz NIPs like
 * "nip-er"/"nip-pl"). Either signal flips the shared NIP-29 surfaces into
 * Buzz mode (extra timeline kinds, kind-9 NIP-10 threads, 40003 edits, …).
 */

import { useRelayInfo, type RelayInfoDocument } from "@/hooks/useRelayInfo";

/** Whether a NIP-11 document identifies a Buzz relay. */
export function isBuzzRelayInfo(info: RelayInfoDocument | undefined): boolean {
  if (!info) return false;
  if (typeof info.software === "string" && /block\/buzz/i.test(info.software)) return true;
  return Array.isArray(info.supported_extensions) && info.supported_extensions.length > 0;
}

/**
 * Whether `relayUrl` is a Buzz relay. `isBuzz` stays false until the NIP-11
 * doc resolves (`ready` distinguishes "not Buzz" from "not known yet");
 * useRelayInfo seeds from a persisted last-known-good doc, so on any relay
 * visited before this answers synchronously.
 */
export function useIsBuzzRelay(relayUrl: string | undefined): { isBuzz: boolean; ready: boolean } {
  const { data, isFetched } = useRelayInfo(relayUrl);
  return { isBuzz: isBuzzRelayInfo(data), ready: Boolean(data) || isFetched };
}
