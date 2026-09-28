import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useBitcoinSigner, isSignerCapabilityError, reportSignerUnsupported } from '@/hooks/useBitcoinSigner';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { useEsploraApis } from '@/hooks/useEsploraApis';
import { notify } from '@/lib/haptics';
import {
  nostrPubkeyToBitcoinAddress,
  fetchUTXOs,
  getFeeRates,
  buildUnsignedPsbt,
  buildUnsignedSilentPaymentPsbt,
  finalizePsbt,
  broadcastTransaction,
  estimateFee,
  validateBitcoinAddress,
} from '@/lib/bitcoin';
import type { FeeRates } from '@/lib/bitcoin';
import { extractTxFromSignedPsbtV2 } from '@/lib/psbtV2';
import type { NostrRumor } from "@/lib/nostrRumor";

export type OnchainFeeSpeed = 'fastest' | 'halfHour' | 'hour' | 'economy';

function feeRateForSpeed(rates: FeeRates, speed: OnchainFeeSpeed): number {
  switch (speed) {
    case 'fastest': return rates.fastestFee;
    case 'halfHour': return rates.halfHourFee;
    case 'hour': return rates.hourFee;
    case 'economy': return rates.economyFee;
  }
}

interface OnchainZapArgs {
  amountSats: number;
  comment?: string;
  /** Defaults to "halfHour". */
  feeSpeed?: OnchainFeeSpeed;
}

interface OnchainZapResult {
  txid: string;
  amountSats: number;
  fee: number;
  /** Omitted for silent-payment sends, which intentionally publish no Nostr event. */
  event?: NostrEvent;
}

/**
 * NIP-A3 recipient override. `onchain`: a bc1 address, still attributed with kind 8333.
 * `sp`: a BIP-352 silent-payment code; no kind 8333, preserving unlinkability.
 */
export interface BitcoinRecipientOverride {
  value: string;
  mode: 'onchain' | 'sp';
}

/**
 * On-chain zaps: pay the target's derived Taproot address, then publish a kind 8333 event
 * (txid + `e`/`a` + recipient). Works for any user — no LNURL.
 */
export function useOnchainZap(
  target: NostrRumor,
  onSuccess?: (result: OnchainZapResult) => void,
  recipientOverride?: BitcoinRecipientOverride,
  /** Concord: seal the 8333 attribution into the channel instead of leaking context publicly. */
  sendOnchainZap?: (target: NostrRumor, announcement: { txid: string; amountSats: number; comment: string }) => Promise<void>,
) {
  const { user } = useCurrentUser();
  const { canSignPsbt, signPsbt } = useBitcoinSigner();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const { toast } = useToast();
  const esploraApis = useEsploraApis();
  const queryClient = useQueryClient();

  const [isZapping, setIsZapping] = useState(false);
  const [progress, setProgress] = useState<'idle' | 'building' | 'signing' | 'broadcasting' | 'publishing'>('idle');

  const mutation = useMutation<OnchainZapResult, Error, OnchainZapArgs>({
    mutationFn: async ({ amountSats, comment = '', feeSpeed = 'halfHour' }) => {
      if (!user) throw new Error('You must be logged in to zap.');
      if (user.pubkey === target.pubkey) throw new Error("You can't zap yourself.");
      if (!canSignPsbt || !signPsbt) {
        throw new Error(
          "Your login doesn't support sending Bitcoin. Log in with your secret key to send Bitcoin zaps.",
        );
      }
      if (!Number.isFinite(amountSats) || amountSats <= 0) {
        throw new Error('Invalid amount.');
      }

      setIsZapping(true);
      setProgress('building');

      // An `sp1…` override uses the BIP-375 SP rail and suppresses kind 8333.
      const useSilentPayment = recipientOverride?.mode === 'sp';
      const recipientAddress =
        recipientOverride?.value ?? nostrPubkeyToBitcoinAddress(target.pubkey);

      const senderAddress = nostrPubkeyToBitcoinAddress(user.pubkey);
      if (!senderAddress || !recipientAddress) {
        throw new Error('Failed to derive Bitcoin address.');
      }
      // SP codes aren't checksummed here; the SP PSBT builder rejects malformed codes.
      if (!useSilentPayment && !validateBitcoinAddress(recipientAddress)) {
        throw new Error('Recipient Bitcoin address failed validation.');
      }

      const [utxos, rates] = await Promise.all([
        fetchUTXOs(senderAddress, esploraApis),
        getFeeRates(esploraApis),
      ]);

      if (utxos.length === 0) {
        throw new Error('Your Bitcoin wallet has no spendable funds.');
      }

      const feeRate = feeRateForSpeed(rates, feeSpeed);
      const totalBalance = utxos.reduce((s, u) => s + u.value, 0);
      const estFee = estimateFee(utxos.length, 2, feeRate);
      if (amountSats + estFee > totalBalance) {
        throw new Error(
          `Insufficient funds. Need ~${(amountSats + estFee).toLocaleString()} sats, have ${totalBalance.toLocaleString()}.`,
        );
      }

      let psbtHex: string;
      let fee: number;
      if (useSilentPayment) {
        ({ psbtHex, fee } = buildUnsignedSilentPaymentPsbt(
          user.pubkey,
          recipientAddress,
          amountSats,
          utxos,
          feeRate,
        ));
      } else {
        ({ psbtHex, fee } = buildUnsignedPsbt(
          user.pubkey,
          recipientAddress,
          amountSats,
          utxos,
          feeRate,
        ));
      }

      setProgress('signing');
      const signedHex = await signPsbt(psbtHex);
      const txHex = useSilentPayment
        ? extractTxFromSignedPsbtV2(signedHex)
        : finalizePsbt(signedHex);

      setProgress('broadcasting');
      const txid = await broadcastTransaction(txHex, esploraApis);

      // Publishing would defeat silent-payment unlinkability.
      if (useSilentPayment) {
        return { txid, amountSats, fee };
      }

      // With a private publisher (Concord), seal the attribution instead of publishing publicly.
      setProgress('publishing');

      if (sendOnchainZap) {
        await sendOnchainZap(target, { txid, amountSats, comment });
        return { txid, amountSats, fee };
      }

      const isAddressable = target.kind >= 30000 && target.kind < 40000;

      const tags: string[][] = [
        ['i', `bitcoin:tx:${txid}`],
        ['p', target.pubkey],
        ['amount', String(amountSats)],
      ];

      if (isAddressable) {
        const dTag = target.tags.find(([n]) => n === 'd')?.[1] ?? '';
        tags.push(['a', `${target.kind}:${target.pubkey}:${dTag}`]);
      }

      // Always include `e`, even for addressable events.
      tags.push(['e', target.id]);

      tags.push(['alt', `Bitcoin zap: ${amountSats.toLocaleString()} sats`]);

      const event = await publishEvent({
        kind: 8333,
        content: comment,
        tags,
      });

      return { txid, amountSats, fee, event };
    },
    onSuccess: (result) => {
      notify("success");
      queryClient.invalidateQueries({ queryKey: ['onchain-zaps'] });
      queryClient.invalidateQueries({ queryKey: ['event-interactions'] });
      queryClient.invalidateQueries({ queryKey: ['bitcoin-utxos'] });
      queryClient.invalidateQueries({ queryKey: ['bitcoin-balance'] });
      queryClient.invalidateQueries({ queryKey: ['bitcoin-txs'] });
      // The caller (e.g. ZapDialog's confirmation screen) owns the feedback.
      if (onSuccess) {
        onSuccess(result);
      } else {
        toast({
          title: 'Bitcoin zap sent!',
          description: `Broadcast txid ${result.txid.slice(0, 12)}… (fee ${result.fee.toLocaleString()} sats)`,
        });
      }
    },
    onError: (err) => {
      // NIP-46 bunkers can't be probed for PSBT support up front; mark unsupported for the session.
      if (isSignerCapabilityError(err) && user) {
        reportSignerUnsupported(user.pubkey);
        return;
      }
      toast({
        title: 'Bitcoin zap failed',
        description: err.message,
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsZapping(false);
      setProgress('idle');
    },
  });

  return {
    zap: mutation.mutate,
    zapAsync: mutation.mutateAsync,
    isZapping,
    progress,
    canZap: !!user && user.pubkey !== target.pubkey && canSignPsbt,
    canSignPsbt,
  };
}
