import { useQuery } from "@tanstack/react-query";
import { nip05 } from "nostr-tools";

import { isNostrId } from "@/lib/nostrId";

import type { Nip05Address } from "@/lib/nip05Address";

/**
 * Resolve NIP-05 via `.well-known/nostr.json` (nostr-tools). The pubkey is validated as hex:
 * the domain is untrusted. `null` = not listed; a fetch failure is an error, not absence.
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
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    retry: 1,
  });
}
