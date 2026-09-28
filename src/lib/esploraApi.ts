/**
 * Esplora REST data plane and fee/BIP-21 helpers. Kept free of `@scure/btc-signer`
 * so initial-load callers don't pull the signing stack; `@/lib/bitcoin` re-exports this.
 */
import { esploraFetch } from './esplora';

/** Standard Bitcoin dust limit in satoshis. */
export const DUST_LIMIT = 546;

/** Estimated vBytes per P2TR input. */
export const VBYTES_PER_INPUT = 57.5;

/** Estimated vBytes per P2TR output. */
export const VBYTES_PER_OUTPUT = 43;

/** Estimated vBytes for transaction overhead (version, locktime, etc.). */
export const VBYTES_OVERHEAD = 10.5;

/** Balance data returned by the Esplora API. */
export interface AddressData {
  /** Confirmed on-chain balance in satoshis. */
  balance: number;
  /** Unconfirmed mempool balance in satoshis. */
  pendingBalance: number;
  /** Sum of confirmed + pending balance. */
  totalBalance: number;
  /** Total satoshis ever received (confirmed). */
  totalReceived: number;
  /** Total satoshis ever sent (confirmed). */
  totalSent: number;
  txCount: number;
  pendingTxCount: number;
}

export async function fetchAddressData(
  address: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<AddressData> {
  const response = await esploraFetch(baseUrls, `/address/${address}`, { signal, retryStatuses: [404] });

  if (!response.ok) {
    throw new Error('Failed to fetch balance');
  }

  const data = await response.json();

  const confirmedBalance = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
  const pendingBalance = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;

  return {
    balance: confirmedBalance,
    pendingBalance,
    totalBalance: confirmedBalance + pendingBalance,
    totalReceived: data.chain_stats.funded_txo_sum,
    totalSent: data.chain_stats.spent_txo_sum,
    txCount: data.chain_stats.tx_count,
    pendingTxCount: data.mempool_stats.tx_count,
  };
}

/** A simplified transaction relevant to a specific address. */
export interface Transaction {
  txid: string;
  /** Net satoshi change for the address (positive = received, negative = sent). */
  amount: number;
  type: 'receive' | 'send';
  confirmed: boolean;
  /** Unix timestamp of the block (undefined if unconfirmed). */
  timestamp?: number;
}

/** Transactions for an address, with net amount relative to that address. */
export async function fetchTransactions(
  address: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<Transaction[]> {
  const response = await esploraFetch(baseUrls, `/address/${address}/txs`, { signal, retryStatuses: [404] });

  if (!response.ok) {
    throw new Error('Failed to fetch transactions');
  }

  const txs = await response.json();

  return txs.map((tx: Record<string, unknown>) => {
    const vin = tx.vin as Array<{ prevout: { scriptpubkey_address?: string; value: number } | null }>;
    const vout = tx.vout as Array<{ scriptpubkey_address?: string; value: number }>;
    const status = tx.status as { confirmed: boolean; block_time?: number };

    const totalIn = vin.reduce((sum, input) => {
      if (input.prevout?.scriptpubkey_address === address) {
        return sum + input.prevout.value;
      }
      return sum;
    }, 0);

    const totalOut = vout.reduce((sum, output) => {
      if (output.scriptpubkey_address === address) {
        return sum + output.value;
      }
      return sum;
    }, 0);

    const net = totalOut - totalIn;

    return {
      txid: tx.txid as string,
      amount: Math.abs(net),
      type: net >= 0 ? 'receive' : 'send',
      confirmed: status.confirmed,
      timestamp: status.block_time,
    } satisfies Transaction;
  });
}

export interface TxInput {
  txid: string;
  vout: number;
  address?: string;
  value: number;
  isCoinbase: boolean;
}

export interface TxOutput {
  address?: string;
  value: number;
  scriptpubkeyType: string;
  spent: boolean;
}

export interface TxDetail {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  fee: number;
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
  blockTime?: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  /** Total value of all inputs (sats). */
  totalInput: number;
  /** Total value of all outputs (sats). */
  totalOutput: number;
}

export async function fetchTxDetail(
  txid: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<TxDetail> {
  const response = await esploraFetch(baseUrls, `/tx/${txid}`, { signal });
  if (!response.ok) throw new Error('Failed to fetch transaction');

  const tx = await response.json();

  const vin = tx.vin as Array<{
    txid: string;
    vout: number;
    prevout: { scriptpubkey_address?: string; value: number } | null;
    is_coinbase: boolean;
  }>;
  const vout = tx.vout as Array<{
    scriptpubkey_address?: string;
    value: number;
    scriptpubkey_type: string;
  }>;
  const status = tx.status as { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };

  const inputs: TxInput[] = vin.map((input) => ({
    txid: input.txid,
    vout: input.vout,
    address: input.prevout?.scriptpubkey_address,
    value: input.prevout?.value ?? 0,
    isCoinbase: input.is_coinbase,
  }));

  const outputs: TxOutput[] = vout.map((output) => ({
    address: output.scriptpubkey_address,
    value: output.value,
    scriptpubkeyType: output.scriptpubkey_type,
    spent: false, // Esplora /tx endpoint doesn't include spending info
  }));

  const totalInput = inputs.reduce((sum, i) => sum + i.value, 0);
  const totalOutput = outputs.reduce((sum, o) => sum + o.value, 0);

  return {
    txid: tx.txid as string,
    version: tx.version as number,
    locktime: tx.locktime as number,
    size: tx.size as number,
    weight: tx.weight as number,
    fee: tx.fee as number,
    confirmed: status.confirmed,
    blockHeight: status.block_height,
    blockHash: status.block_hash,
    blockTime: status.block_time,
    inputs,
    outputs,
    totalInput,
    totalOutput,
  };
}

export interface AddressDetail {
  address: string;
  balance: number;
  pendingBalance: number;
  totalBalance: number;
  totalReceived: number;
  totalSent: number;
  txCount: number;
  pendingTxCount: number;
  /** Most recent transactions (up to 25). */
  recentTxs: Transaction[];
}

export async function fetchAddressDetail(
  address: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<AddressDetail> {
  const [addrData, txs] = await Promise.all([
    fetchAddressData(address, baseUrls, signal),
    fetchTransactions(address, baseUrls, signal),
  ]);

  return {
    address,
    ...addrData,
    recentTxs: txs.slice(0, 25),
  };
}

export interface UTXO {
  txid: string;
  vout: number;
  /** Value in satoshis. */
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

export async function fetchUTXOs(
  address: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<UTXO[]> {
  const response = await esploraFetch(baseUrls, `/address/${address}/utxo`, { signal, retryStatuses: [404] });
  if (!response.ok) throw new Error('Failed to fetch UTXOs');
  return response.json();
}

/** Fee rates in sat/vB. */
export interface FeeRates {
  /** ~10 min / next block (target 1). */
  fastestFee: number;
  /** ~30 min (target 3). */
  halfHourFee: number;
  /** ~1 hour (target 6). */
  hourFee: number;
  /** ~1 day (target 144). */
  economyFee: number;
  /** Minimum relay fee (target 504). */
  minimumFee: number;
}

export async function getFeeRates(baseUrls: string[], signal?: AbortSignal): Promise<FeeRates> {
  // `/fee-estimates` always exists on a healthy backend, so a 404 means misbehaving
  // (mempool.space sends 404 instead of 429 to rate-limited mobile clients) — fail over.
  const response = await esploraFetch(baseUrls, `/fee-estimates`, { signal, retryStatuses: [404] });
  if (!response.ok) throw new Error('Failed to fetch fee estimates');

  const data = await response.json();

  return {
    fastestFee: sanitizeFeeRate(data?.['1']),
    halfHourFee: sanitizeFeeRate(data?.['3']),
    hourFee: sanitizeFeeRate(data?.['6']),
    economyFee: sanitizeFeeRate(data?.['144']),
    minimumFee: sanitizeFeeRate(data?.['504']),
  };
}

/** Highest accepted remote fee rate (sat/vB): above any real peak, below wallet-draining. */
const MAX_PLAUSIBLE_FEE_RATE = 5_000;

/**
 * Coerce an Esplora fee rate to a finite sat/vB number, falling back to 1.
 * A NaN rate slips past every `<`/`>=` guard downstream and yields a valid tx
 * that pays the whole remaining balance to miners.
 */
function sanitizeFeeRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  if (value < 1) return 1;
  if (value > MAX_PLAUSIBLE_FEE_RATE) return MAX_PLAUSIBLE_FEE_RATE;
  return Math.ceil(value);
}

/** Estimated fee in sats for a P2TR transaction; `feeRate` in sat/vB. */
export function estimateFee(numInputs: number, numOutputs: number, feeRate: number): number {
  // Assert: a NaN fee passes every downstream comparison guard and drains the wallet to miners.
  if (!Number.isFinite(feeRate) || feeRate < 1) {
    throw new Error(`Invalid fee rate: ${feeRate} sat/vB.`);
  }
  const vBytes = numInputs * VBYTES_PER_INPUT + numOutputs * VBYTES_PER_OUTPUT + VBYTES_OVERHEAD;
  return Math.ceil(vBytes * feeRate);
}

/** Parsed BIP-21 URI. Only address, BIP-352 `sp=`, and `amount=` are surfaced. */
export interface ParsedBitcoinUri {
  /** On-chain address from the URI path. May be empty for sp-only URIs. */
  address: string;
  /** BIP-352 silent payment address from the `sp=` parameter, if present. */
  sp?: string;
  /** From BTC `amount=`; floored to whole sats, undefined if malformed or non-positive. */
  amountSats?: number;
}

/** Split a `bitcoin:` URI (case-insensitive scheme) into parts; null otherwise. Values are not validated. */
export function parseBitcoinUri(input: string): ParsedBitcoinUri | null {
  const trimmed = input.trim();
  if (!/^bitcoin:/i.test(trimmed)) return null;

  const payload = trimmed.slice('bitcoin:'.length);
  const qIdx = payload.indexOf('?');
  const address = (qIdx === -1 ? payload : payload.slice(0, qIdx)).trim();

  let sp: string | undefined;
  let amountSats: number | undefined;
  if (qIdx !== -1) {
    const params = new URLSearchParams(payload.slice(qIdx + 1));
    sp = params.get('sp')?.trim() || undefined;

    const amountRaw = params.get('amount')?.trim();
    if (amountRaw) {
      const btc = Number(amountRaw);
      if (Number.isFinite(btc) && btc > 0) {
        // Round down — never overstate the requested amount.
        amountSats = Math.floor(btc * 100_000_000);
      }
    }
  }

  return { address, sp, amountSats };
}

/** Broadcast signed tx hex; returns the txid. Re-broadcast is harmless, so normal failover applies. */
export async function broadcastTransaction(
  txHex: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<string> {
  const response = await esploraFetch(baseUrls, `/tx`, {
    method: 'POST',
    body: txHex,
    signal,
    // A 404 on broadcast is never a legitimate "not found" — fail over.
    retryStatuses: [404],
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Broadcast failed: ${body}`);
  }

  return response.text();
}

/** Max sendable sats after fees (0 if the balance can't cover them). */
export function maxSendable(totalBalance: number, numInputs: number, feeRate: number): number {
  const fee = estimateFee(numInputs, 1, feeRate);
  return Math.max(0, totalBalance - fee);
}
