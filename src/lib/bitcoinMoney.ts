/**
 * Lightweight sats/BTC/USD helpers, kept free of the ~150 kB signing stack so
 * initial-load components can format money. Re-exported by `@/lib/bitcoin`.
 */
import { esploraFetch } from './esplora';

import type { CurrencyDisplay } from '@/contexts/AppContext';

/** Convert satoshis to a BTC string with up to 8 decimal places. */
export function satsToBTC(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

/**
 * Convert satoshis to a BTC string with trailing zeros stripped.
 * E.g. `formatBTC(100_000_000)` → `"1"`, `formatBTC(1_234_560)` → `"0.0123456"`.
 */
export function formatBTC(sats: number): string {
  return satsToBTC(sats).replace(/\.?0+$/, '');
}

/** Format a satoshi amount with locale-aware thousand separators. */
export function formatSats(sats: number): string {
  return sats.toLocaleString();
}

/**
 * Fetch the BTC/USD price from a mempool.space-compatible API with failover.
 * `/v1/prices` isn't standard Esplora, so a 404 soft-fails to the next URL.
 */
export async function fetchBtcPrice(baseUrls: string[], signal?: AbortSignal): Promise<number> {
  const response = await esploraFetch(baseUrls, `/v1/prices`, {
    // 404 = path unsupported, not a dead endpoint: skip without cool-down.
    skipStatuses: [404],
    signal,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch BTC price');
  }

  const data = await response.json();
  return data.USD;
}

/** Convert a BTC amount to satoshis (rounded to nearest integer). */
export function btcToSats(btc: number): number {
  return Math.round(btc * 100_000_000);
}

/** USD amount above which send/zap flows require a two-tap confirmation. */
export const LARGE_AMOUNT_USD_THRESHOLD = 100;

/** Whether `sats` crosses the large-amount threshold; false without a known price. */
export function isLargeAmount(sats: number, btcPrice: number | undefined): boolean {
  if (!btcPrice || !Number.isFinite(btcPrice) || btcPrice <= 0) return false;
  if (!Number.isFinite(sats) || sats <= 0) return false;
  const usd = (sats / 100_000_000) * btcPrice;
  return usd >= LARGE_AMOUNT_USD_THRESHOLD;
}

/** Satoshis as a formatted USD string (`$12.34`). */
export function satsToUSD(sats: number, btcPrice: number): string {
  const btc = sats / 100_000_000;
  return (btc * btcPrice).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function usdToSats(usd: number, btcPrice: number): number {
  return Math.round((usd / btcPrice) * 100_000_000);
}

/** Exact satoshi amount with its unit (`"5,000 sats"`); never abbreviated, for payment surfaces. */
export function formatSatsAmount(sats: number): string {
  return `${formatSats(sats)} ${sats === 1 ? 'sat' : 'sats'}`;
}

/** Exact amount in the preferred currency; falls back to sats when no price is known. */
export function formatMoneyAmount(
  sats: number,
  currency: CurrencyDisplay,
  btcPrice: number | undefined,
): string {
  if (currency === 'usd' && btcPrice && Number.isFinite(btcPrice) && btcPrice > 0) {
    return satsToUSD(sats, btcPrice);
  }
  return formatSatsAmount(sats);
}

/**
 * Convert an amount-input value (in the display currency) to sats. Returns 0
 * for blank, invalid, negative, or unpriced USD input.
 */
export function amountInputToSats(
  value: number | string,
  currency: CurrencyDisplay,
  btcPrice: number | undefined,
): number {
  const amount = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (currency === 'sats') return Math.round(amount);
  if (!btcPrice || !Number.isFinite(btcPrice) || btcPrice <= 0) return 0;
  return usdToSats(amount, btcPrice);
}

/**
 * Format an amount-input value in its own units without a price (for USD mode
 * before the price loads). `""` for blank/invalid.
 */
export function formatAmountInput(value: number | string, currency: CurrencyDisplay): string {
  const amount = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(amount) || amount <= 0) return '';
  if (currency === 'sats') return formatSatsAmount(Math.round(amount));
  return amount < 1 ? `$${amount.toFixed(2)}` : `$${amount}`;
}

/** Preset amount chips per display currency; sats presets are round numbers, not conversions. */
export interface AmountPresetSet {
  usd: number[];
  sats: number[];
}

/** The preset list for the active display currency. */
export function presetsFor(presets: AmountPresetSet, currency: CurrencyDisplay): number[] {
  return currency === 'sats' ? presets.sats : presets.usd;
}
