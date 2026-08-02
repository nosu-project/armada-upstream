import { useQuery } from "@tanstack/react-query";
import { nip05 } from "nostr-tools";

import { isNostrId } from "@/lib/nostrId";

import type { Nip05Address } from "@/lib/nip05Address";

/**
 * Resolve a NIP-05 address to a pubkey by fetching the domain's
 * `.well-known/nostr.json`.
 *
 * Goes through nostr-tools' resolver rather than trusting a `nip05` field on
 * some kind-0 event — the same call the git repository resolver makes. The
 * returned pubkey is validated as 32-byte hex before it leaves here, because
 * the domain is an untrusted party that can put any string in that JSON, and
 * downstream it reaches `nip19` encoders and relay filters.
 *
 * `data` is `null` for "the domain answered and this person isn't there".
 * A fetch failure surfaces as an error, not as `null`: an unreachable domain
 * is not evidence of absence.
 */
export function useNip05Resolve(address: Nip05Address | undefined) {
  return useQuery<string | null>({
    queryKey: ["nip05-resolve", address?.address],
    queryFn: async () => {
      if (!address) return null;
      const profile = await nip05.queryProfile(address.address);
      if (!profile) return null;
      return isNostrId(profile.pubkey) ? profile.pubkey : null;
    },
    enabled: !!address,
    // NIP-05 records change about as often as someone changes their handle.
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    retry: 1,
  });
}
