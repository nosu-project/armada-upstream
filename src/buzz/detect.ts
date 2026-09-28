/**
 * Buzz relay detection from NIP-11. The reference relay (block/buzz) advertises
 * `software: "https://github.com/block/buzz"` + `supported_extensions`; newlay
 * in `[buzz]` mode advertises `software: "newlay"` + `pairing_relay_url` (its
 * NIP-AB rendezvous). Plain newlay stays standard NIP-29.
 */

import { useEffect } from "react";

import { registerBuzzMediaHost } from "@/buzz/media";
import { useRelayInfo, type RelayInfoDocument } from "@/hooks/useRelayInfo";

export function isBuzzRelayInfo(info: RelayInfoDocument | undefined): boolean {
  if (!info) return false;
  const software = typeof info.software === "string" ? info.software : "";
  if (/block\/buzz/i.test(software)) return true;
  if (Array.isArray(info.supported_extensions) && info.supported_extensions.length > 0) return true;
  // Both required: plain newlay has the software string but no pairing URL.
  if (/newlay/i.test(software) && typeof info.pairing_relay_url === "string" && info.pairing_relay_url) {
    return true;
  }
  return false;
}

/**
 * `ready` distinguishes "not Buzz" from "not known yet"; a persisted NIP-11 doc
 * answers synchronously for previously visited relays.
 */
export function useIsBuzzRelay(relayUrl: string | undefined): { isBuzz: boolean; ready: boolean } {
  const { data, isFetched } = useRelayInfo(relayUrl);
  const isBuzz = isBuzzRelayInfo(data);

  // Buzz media needs BUD-11 GET auth; the media host is the relay host.
  useEffect(() => {
    if (isBuzz && relayUrl) registerBuzzMediaHost(relayUrl);
  }, [isBuzz, relayUrl]);

  return { isBuzz, ready: Boolean(data) || isFetched };
}
