import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { QRCodeCanvas } from '@/components/ui/qrcode';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useBitcoinSigner } from '@/hooks/useBitcoinSigner';
import { useOnchainZap, type OnchainFeeSpeed } from '@/hooks/useOnchainZap';
import { useEsploraApis } from '@/hooks/useEsploraApis';
import {
  nostrPubkeyToBitcoinAddress,
  fetchUTXOs,
  getFeeRates,
  estimateFee,
  formatSats,
} from '@/lib/bitcoin';
import { ZAP_PRESETS } from '@/lib/zaps';
import type { NostrEvent } from '@nostrify/nostrify';
import type { BitcoinRecipientOverride } from '@/hooks/useOnchainZap';

const PRESETS = ZAP_PRESETS.slice(0, 5);

const FEE_SPEED_LABELS: Record<OnchainFeeSpeed, string> = {
  fastest: '~10 min',
  halfHour: '~30 min',
  hour: '~1 hour',
  economy: '~1 day',
};

const FEE_SPEED_ORDER: OnchainFeeSpeed[] = ['fastest', 'halfHour', 'hour', 'economy'];

function getRateForSpeed(rates: { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number }, speed: OnchainFeeSpeed): number {
  switch (speed) {
    case 'fastest': return rates.fastestFee;
    case 'halfHour': return rates.halfHourFee;
    case 'hour': return rates.hourFee;
    case 'economy': return rates.economyFee;
  }
}

function getUniqueFeeSpeeds(
  rates: { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number } | undefined,
): OnchainFeeSpeed[] {
  if (!rates) return FEE_SPEED_ORDER;
  const seen = new Set<number>();
  const result: OnchainFeeSpeed[] = [];
  for (const speed of FEE_SPEED_ORDER) {
    const rate = getRateForSpeed(rates, speed);
    if (!seen.has(rate)) {
      seen.add(rate);
      result.push(speed);
    }
  }
  return result;
}

interface OnchainZapContentProps {
  target: NostrEvent;
  bitcoinTarget?: BitcoinRecipientOverride;
  sendOnchainZap?: (target: NostrEvent, announcement: { txid: string; amountSats: number; comment: string }) => Promise<void>;
  onSuccess?: (result: { txid: string; amountSats: number }) => void;
  onClose?: () => void;
}

export function OnchainZapContent({ target, bitcoinTarget, sendOnchainZap, onSuccess, onClose }: OnchainZapContentProps) {
  const { user } = useCurrentUser();
  const { capability } = useBitcoinSigner();
  const esploraApis = useEsploraApis();

  const [amount, setAmount] = useState<number>(PRESETS[1]);
  const [feeSpeed, setFeeSpeed] = useState<OnchainFeeSpeed>('halfHour');
  const [error, setError] = useState('');
  const [feePopoverOpen, setFeePopoverOpen] = useState(false);
  const [editingAmount, setEditingAmount] = useState(false);
  const amountInputRef = useRef<HTMLInputElement>(null);

  const feeSpeedUserChanged = useRef(false);

  const senderAddress = user ? nostrPubkeyToBitcoinAddress(user.pubkey) : '';
  const recipientAddress = useMemo(() => {
    if (bitcoinTarget) return bitcoinTarget.value;
    return nostrPubkeyToBitcoinAddress(target.pubkey);
  }, [bitcoinTarget, target.pubkey]);

  const { data: utxos } = useQuery({
    queryKey: ['bitcoin-utxos', esploraApis, senderAddress],
    queryFn: ({ signal }) => fetchUTXOs(senderAddress, esploraApis, signal),
    enabled: !!senderAddress && capability !== 'unsupported',
    staleTime: 30_000,
  });

  const { data: feeRates } = useQuery({
    queryKey: ['bitcoin-fee-rates', esploraApis],
    queryFn: ({ signal }) => getFeeRates(esploraApis, signal),
    enabled: capability !== 'unsupported',
    staleTime: 30_000,
  });

  const totalBalance = useMemo(() => utxos?.reduce((s, u) => s + u.value, 0) ?? 0, [utxos]);

  const currentFeeRate = useMemo(() => {
    if (!feeRates) return 0;
    return getRateForSpeed(feeRates, feeSpeed);
  }, [feeRates, feeSpeed]);

  const estimatedFeeSats = useMemo(() => {
    if (!utxos?.length || !currentFeeRate || !amount) return 0;
    const fee2 = estimateFee(utxos.length, 2, currentFeeRate);
    const change = totalBalance - amount - fee2;
    const numOutputs = change > 546 ? 2 : 1;
    return estimateFee(utxos.length, numOutputs, currentFeeRate);
  }, [utxos, currentFeeRate, amount, totalBalance]);

  const insufficient = totalBalance > 0 && amount + estimatedFeeSats > totalBalance;

  useEffect(() => {
    if (feeSpeedUserChanged.current) return;
    if (!utxos?.length || !feeRates || amount <= 0) return;

    const uniqueSpeeds = getUniqueFeeSpeeds(feeRates);
    const threshold = amount * 0.4;

    let targetSpeed: OnchainFeeSpeed = uniqueSpeeds[uniqueSpeeds.length - 1];
    for (const speed of uniqueSpeeds) {
      const rate = getRateForSpeed(feeRates, speed);
      const fee2 = estimateFee(utxos.length, 2, rate);
      const change = totalBalance - amount - fee2;
      const outputs = change > 546 ? 2 : 1;
      const fee = estimateFee(utxos.length, outputs, rate);
      if (fee <= threshold) {
        targetSpeed = speed;
        break;
      }
    }

    setFeeSpeed((prev) => (prev === targetSpeed ? prev : targetSpeed));
  }, [amount, feeRates, utxos, totalBalance]);

  const handleFeeSpeedChange = useCallback((speed: OnchainFeeSpeed) => {
    feeSpeedUserChanged.current = true;
    setFeeSpeed(speed);
    setFeePopoverOpen(false);
  }, []);

  const uniqueFeeSpeeds = useMemo(() => getUniqueFeeSpeeds(feeRates), [feeRates]);

  const { zapAsync, isZapping, progress } = useOnchainZap(target, (result) => {
    onSuccess?.({ txid: result.txid, amountSats: result.amountSats });
  }, bitcoinTarget, sendOnchainZap);

  useEffect(() => {
    if (editingAmount) {
      amountInputRef.current?.focus();
      amountInputRef.current?.select();
    }
  }, [editingAmount]);

  const commitAmountEdit = useCallback(() => {
    setEditingAmount(false);
  }, []);

  const handleZap = useCallback(async () => {
    setError('');
    if (!user) { setError('You must be logged in.'); return; }
    if (user.pubkey === target.pubkey) { setError("You can't zap yourself."); return; }
    if (amount <= 0) { setError('Enter an amount.'); return; }
    if (!utxos?.length) { setError("You don't have any Bitcoin yet."); return; }
    if (insufficient) { setError('Not enough Bitcoin.'); return; }

    try {
      await zapAsync({ amountSats: amount, comment: '', feeSpeed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Zap failed';
      const isCapability = /does not support|doesn't support|signpsbt|sign_psbt/i.test(msg);
      if (!isCapability) setError(msg);
    }
  }, [user, target.pubkey, amount, utxos, insufficient, zapAsync, feeSpeed]);

  if (user && capability === 'unsupported') {
    return (
      <UnsupportedSignerQR
        recipientAddress={recipientAddress}
        amount={amount}
        setAmount={setAmount}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
      <div className="flex flex-col items-center pt-2">
        {editingAmount ? (
          <div className="flex items-baseline justify-center">
            <input
              ref={amountInputRef}
              type="number"
              inputMode="numeric"
              min={1}
              value={amount || ""}
              onChange={(e) => { setAmount(Number(e.target.value)); setError(""); }}
              onBlur={commitAmountEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitAmountEdit(); }
              }}
              aria-label="Amount in sats"
              className="bg-transparent border-0 outline-none text-4xl font-semibold text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              style={{ width: `${Math.max(2, String(amount).length + 1)}ch` }}
            />
            <span className="text-4xl font-semibold text-muted-foreground"> sats</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditingAmount(true)}
            aria-label="Edit amount"
            className="flex items-baseline justify-center rounded-md px-2 -mx-2 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
          >
            <span className={`text-4xl font-semibold tabular-nums ${insufficient ? 'text-destructive' : ''}`}>
              {formatSats(amount)}
            </span>
            <span className="text-4xl font-semibold text-muted-foreground"> sats</span>
          </button>
        )}
      </div>

      <ToggleGroup
        type="single"
        value={PRESETS.includes(amount) ? String(amount) : ""}
        onValueChange={(v) => { if (v) { setAmount(Number(v)); setError(""); setEditingAmount(false); } }}
        className="grid grid-cols-5 gap-1 w-full"
      >
        {PRESETS.map((preset) => (
          <ToggleGroupItem
            key={preset}
            value={String(preset)}
            className="h-8 min-w-0 text-xs font-semibold px-1"
          >
            {formatSats(preset)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <Button
        type="button"
        onClick={handleZap}
        disabled={isZapping || amount <= 0 || insufficient}
        variant={insufficient && !isZapping ? 'destructive' : 'default'}
        className="w-full"
      >
        {isZapping ? (
          <>
            <Loader2 className="size-4 mr-1.5 animate-spin" />
            {progressLabel(progress)}
          </>
        ) : insufficient ? (
          <>Not enough Bitcoin</>
        ) : (
          `Send ${formatSats(amount)} sats`
        )}
      </Button>

      {amount > 0 && (
        <div className="flex items-center justify-center -mt-1 text-xs">
          <Popover open={feePopoverOpen} onOpenChange={setFeePopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                <span>
                  Fee ≈ {estimatedFeeSats > 0 ? `${formatSats(estimatedFeeSats)} sats` : '…'}
                  <span className="opacity-60"> · {FEE_SPEED_LABELS[feeSpeed]}</span>
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="center" sideOffset={6} className="w-56 p-1">
              <div className="flex flex-col">
                {uniqueFeeSpeeds.map((speed) => {
                  const rate = feeRates ? getRateForSpeed(feeRates, speed) : 0;
                  const selected = speed === feeSpeed;
                  return (
                    <button
                      key={speed}
                      type="button"
                      onClick={() => handleFeeSpeedChange(speed)}
                      className={`flex items-center justify-between px-2 py-1.5 rounded-sm text-xs text-left hover:bg-muted transition-colors ${selected ? 'bg-muted font-medium' : ''}`}
                    >
                      <span>{FEE_SPEED_LABELS[speed]}</span>
                      <span className="text-muted-foreground">{rate} sat/vB</span>
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}

function progressLabel(progress: 'idle' | 'building' | 'signing' | 'broadcasting' | 'publishing'): string {
  switch (progress) {
    case 'building': return 'Building…';
    case 'signing': return 'Signing…';
    case 'broadcasting': return 'Broadcasting…';
    case 'publishing': return 'Publishing…';
    default: return 'Processing…';
  }
}

// ── Unsupported-signer QR fallback ──────────────────────────────────────────

interface UnsupportedSignerQRProps {
  recipientAddress: string;
  amount: number;
  setAmount: (v: number) => void;
  onClose?: () => void;
}

function UnsupportedSignerQR({
  recipientAddress,
  amount,
  setAmount,
  onClose,
}: UnsupportedSignerQRProps) {
  const bip21 = useMemo(() => {
    if (!recipientAddress) return '';
    const params = new URLSearchParams();
    if (amount > 0) {
      params.set('amount', (amount / 100_000_000).toFixed(8));
    }
    const qs = params.toString();
    return qs ? `bitcoin:${recipientAddress}?${qs}` : `bitcoin:${recipientAddress}`;
  }, [recipientAddress, amount]);

  return (
    <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
      <div className="flex justify-center">
        {amount > 0 && bip21 ? (
          <div className="bg-white p-3 rounded-xl" aria-label="Bitcoin payment QR code">
            <QRCodeCanvas value={bip21} size={220} level="M" className="block" />
          </div>
        ) : (
          <div className="size-[220px] rounded-xl border border-dashed flex items-center justify-center text-xs text-muted-foreground text-center px-4">
            Choose an amount to generate a payment QR.
          </div>
        )}
      </div>

      <ToggleGroup
        type="single"
        value={PRESETS.includes(amount) ? String(amount) : ""}
        onValueChange={(v) => { if (v) setAmount(Number(v)); }}
        className="grid grid-cols-5 gap-1 w-full"
      >
        {PRESETS.map((preset) => (
          <ToggleGroupItem
            key={preset}
            value={String(preset)}
            className="h-8 min-w-0 text-xs font-semibold px-1"
          >
            {formatSats(preset)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {onClose && (
        <Button type="button" variant="secondary" onClick={onClose} className="w-full">
          Done
        </Button>
      )}
    </div>
  );
}
