import { useNostr } from '@nostrify/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { fetchFreshEvent } from '@/lib/fetchFreshEvent';
import {
  PAYMENT_TARGETS_KIND,
  parsePaymentTargets,
  paymentTargetsToTags,
  type PaymentTarget,
} from '@/lib/paymentTargets';

/** A pubkey's NIP-A3 payment targets (kind 10133): validated, one per type, registry order. */
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

/**
 * Full overwrite of kind 10133, still read-modify-write ({@link fetchFreshEvent}) to keep
 * `content`. Only published on explicit save, so an empty set is a deliberate clear (AGENTS.md).
 */
export function useUpdatePaymentTargets() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent } = useNostrPublish();

  return useMutation({
    mutationFn: async (targets: PaymentTarget[]) => {
      if (!user) throw new Error('You must be logged in.');

      const prev = await fetchFreshEvent(nostr, {
        kinds: [PAYMENT_TARGETS_KIND],
        authors: [user.pubkey],
      });

      const tags: string[][] = [
        ...paymentTargetsToTags(targets),
        ['alt', 'Payment targets'],
      ];

      await publishEvent({
        kind: PAYMENT_TARGETS_KIND,
        content: prev?.content ?? '',
        tags,
        prev: prev ?? undefined,
      });
    },
    // Optimistic, with a snapshot for rollback.
    onMutate: (targets: PaymentTarget[]) => {
      const key = ['payment-targets', user?.pubkey];
      const snapshot = queryClient.getQueryData<PaymentTarget[]>(key);
      queryClient.setQueryData<PaymentTarget[]>(key, targets);
      return { snapshot, key };
    },
    onError: (_err, _targets, ctx) => {
      if (ctx) queryClient.setQueryData(ctx.key, ctx.snapshot);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-targets', user?.pubkey] });
    },
  });
}
