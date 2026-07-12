import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

import {
  PAYMENT_TARGETS_KIND,
  parsePaymentTargets,
  type PaymentTarget,
} from '@/lib/paymentTargets';

/**
 * Read a pubkey's NIP-A3 payment targets (kind 10133, replaceable).
 *
 * Payment targets are public, self-authored donation endpoints — there is no
 * trust boundary to defend with an `authors` filter beyond the implicit one
 * (we query the pubkey's own kind 10133), so this mirrors the standard
 * replaceable-event read pattern.
 *
 * Returns validated, deduplicated targets (one per type) in registry order.
 */
export function usePaymentTargets(pubkey: string | undefined) {
  const { nostr } = useNostr();

  const query = useQuery({
    queryKey: ['payment-targets', pubkey],
    queryFn: async (c) => {
      if (!pubkey) return [] as PaymentTarget[];
      const events = await nostr.query(
        [{ kinds: [PAYMENT_TARGETS_KIND], authors: [pubkey], limit: 1 }],
        { signal: c.signal },
      );
      return parsePaymentTargets(events[0]);
    },
    enabled: !!pubkey,
    staleTime: 5 * 60 * 1000,
  });

  return {
    targets: query.data ?? [],
    isLoading: query.isLoading,
  };
}
