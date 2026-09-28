/**
 * Bitcoin helpers — address derivation, PSBT construction & signing. Esplora
 * fetchers (in ./esploraApi) take ordered `baseUrls` with failover via `esploraFetch`.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import {
  decodeSilentPaymentAddress,
  validateSilentPaymentAddress,
} from './silentPayments';
import { encodePsbtV2, type PsbtV2Input, type PsbtV2Output } from './psbtV2';

import { DUST_LIMIT, estimateFee, type UTXO } from './esploraApi';

/** Strict 32-byte hex validator (either case). */
function isValidPubkeyHex(s: string): boolean {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}

/** Decode 64-char hex; `@scure/base` only accepts lowercase. */
function hexToBytes(s: string): Uint8Array {
  return hex.decode(s.toLowerCase());
}

/**
 * Convert a Nostr pubkey to a Taproot (P2TR) address; both are BIP-340 x-only
 * keys, so it's used directly as the internal key. '' if invalid.
 */
export function nostrPubkeyToBitcoinAddress(pubkeyHex: string): string {
  if (!isValidPubkeyHex(pubkeyHex)) return '';

  try {
    const internalPubkey = hexToBytes(pubkeyHex);
    const payment = btc.p2tr(internalPubkey, undefined, btc.NETWORK);
    return payment.address || '';
  } catch (error) {
    console.error('Error generating Bitcoin address:', error);
    return '';
  }
}

export {
  DUST_LIMIT,
  fetchAddressData,
  fetchTransactions,
  fetchTxDetail,
  fetchAddressDetail,
  fetchUTXOs,
  getFeeRates,
  estimateFee,
  parseBitcoinUri,
  broadcastTransaction,
  maxSendable,
} from './esploraApi';
export type {
  AddressData,
  Transaction,
  TxInput,
  TxOutput,
  TxDetail,
  AddressDetail,
  UTXO,
  FeeRates,
  ParsedBitcoinUri,
} from './esploraApi';

// Money helpers live in `./bitcoinMoney`, free of the heavy signing stack.
export {
  satsToBTC,
  formatBTC,
  formatSats,
  fetchBtcPrice,
  btcToSats,
  LARGE_AMOUNT_USD_THRESHOLD,
  isLargeAmount,
  satsToUSD,
  usdToSats,
  formatSatsAmount,
  formatMoneyAmount,
  amountInputToSats,
  formatAmountInput,
  presetsFor,
} from './bitcoinMoney';
export type { AmountPresetSet } from './bitcoinMoney';

/** Lives in the dependency-light `./bitcoinAddress`; re-exported for wallet code. */
export { validateBitcoinAddress } from './bitcoinAddress';

/** Result of building an unsigned PSBT. */
export interface UnsignedPsbt {
  psbtHex: string;
  fee: number;
}

/**
 * Build an unsigned Taproot PSBT (all UTXOs consumed) for any signer.
 *
 * @param senderPubkeyHex 32-byte hex x-only public key of the sender.
 * @param feeRate         Fee rate in sat/vB.
 */
export function buildUnsignedPsbt(
  senderPubkeyHex: string,
  toAddress: string,
  amountSats: number,
  utxos: UTXO[],
  feeRate: number,
): UnsignedPsbt {
  return buildUnsignedPsbtMulti(
    senderPubkeyHex,
    [{ address: toAddress, amountSats }],
    utxos,
    feeRate,
  );
}

/** A single recipient output for a multi-output PSBT. */
export interface PsbtRecipient {
  address: string;
  amountSats: number;
}

/**
 * Build an unsigned Taproot PSBT paying many recipients in one tx ("zap all").
 * Each amount must be ≥ {@link DUST_LIMIT} or the tx won't broadcast; callers filter.
 *
 * @param feeRate Fee rate in sat/vB.
 */
export function buildUnsignedPsbtMulti(
  senderPubkeyHex: string,
  recipients: PsbtRecipient[],
  utxos: UTXO[],
  feeRate: number,
): UnsignedPsbt {
  if (recipients.length === 0) throw new Error('At least one recipient is required.');

  for (const r of recipients) {
    if (!Number.isFinite(r.amountSats) || r.amountSats < DUST_LIMIT) {
      throw new Error(
        `Each recipient must receive at least ${DUST_LIMIT} sats (dust limit). Got ${r.amountSats}.`,
      );
    }
  }

  const internalPubkey = hexToBytes(senderPubkeyHex);

  // Change goes back to the sender's own Taproot address.
  const senderPayment = btc.p2tr(internalPubkey, undefined, btc.NETWORK);
  const changeAddress = senderPayment.address;
  if (!changeAddress) throw new Error('Failed to derive change address');
  const senderScript = senderPayment.script;

  const tx = new btc.Transaction();
  let totalInput = 0;

  for (const utxo of utxos) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: senderScript,
        amount: BigInt(utxo.value),
      },
      tapInternalKey: internalPubkey,
    });
    totalInput += utxo.value;
  }

  const totalOut = recipients.reduce((s, r) => s + r.amountSats, 0);

  // Assume change first; change exactly at the dust limit is still standard.
  const numRecipients = recipients.length;
  const feeWithChange = estimateFee(utxos.length, numRecipients + 1, feeRate);
  const changeWithBoth = totalInput - totalOut - feeWithChange;
  const hasChange = changeWithBoth >= DUST_LIMIT;
  const numOutputs = hasChange ? numRecipients + 1 : numRecipients;
  const fee = estimateFee(utxos.length, numOutputs, feeRate);
  const change = totalInput - totalOut - fee;

  if (change < 0) {
    throw new Error(
      `Insufficient funds. Need ${(totalOut + fee).toLocaleString()} sats, have ${totalInput.toLocaleString()} sats.`,
    );
  }

  for (const r of recipients) {
    tx.addOutputAddress(r.address, BigInt(r.amountSats), btc.NETWORK);
  }

  if (hasChange) {
    tx.addOutputAddress(changeAddress, BigInt(change), btc.NETWORK);
  }

  return { psbtHex: hex.encode(tx.toPSBT()), fee };
}

/**
 * Sign a PSBT locally with a raw private key. `Transaction.sign` applies the
 * BIP-341 TapTweak for inputs whose `tapInternalKey` matches; others are untouched.
 * Returns the signed (not finalized) hex PSBT.
 */
export function signPsbtLocal(psbtHex: string, privateKeyHex: string): string {
  const tx = btc.Transaction.fromPSBT(hexToBytes(psbtHex));
  const privKey = hexToBytes(privateKeyHex);

  const signedCount = tx.sign(privKey);

  if (signedCount === 0) {
    throw new Error('No inputs in this PSBT are owned by the signer.');
  }

  return hex.encode(tx.toPSBT());
}

/** Finalize a signed PSBT and extract the raw transaction hex. */
export function finalizePsbt(psbtHex: string): string {
  const tx = btc.Transaction.fromPSBT(hexToBytes(psbtHex));
  tx.finalize();
  return hex.encode(tx.extract());
}

// BIP-352 / BIP-375 silent payments: the sp1… output depends on the sender's
// input set, so either the local nsec path derives it before signing, or a
// BIP-375 signer fills in the script from `PSBT_OUT_SP_V0_INFO`.
export { validateSilentPaymentAddress };

/**
 * Build an unsigned PSBT v2 + BIP-375 paying one silent payment recipient as
 * `PSBT_OUT_SP_V0_INFO` (no script) plus change. The signer derives the P2TR
 * output, signs (SIGHASH_ALL only), and returns a finalized PSBT v2 for
 * {@link extractTxFromSignedPsbtV2}. Mainnet only.
 *
 * @param senderPubkeyHex 32-byte hex x-only key (change output + tapInternalKey).
 * @param feeRate         Fee rate in sat/vB.
 */
export function buildUnsignedSilentPaymentPsbt(
  senderPubkeyHex: string,
  spAddress: string,
  amountSats: number,
  utxos: UTXO[],
  feeRate: number,
): UnsignedPsbt {
  if (!isValidPubkeyHex(senderPubkeyHex)) {
    throw new Error('Silent payment send: invalid sender pubkey.');
  }
  if (utxos.length === 0) {
    throw new Error('Silent payment send: no UTXOs available.');
  }
  if (!Number.isFinite(amountSats) || amountSats < 546) {
    throw new Error(`Silent payment send: amount must be at least 546 sats (got ${amountSats}).`);
  }

  const sp = decodeSilentPaymentAddress(spAddress);
  if (sp.network !== 'mainnet') {
    throw new Error('Silent payment send: testnet addresses are not supported.');
  }
  if (sp.version !== 0) {
    // v1+ are reserved; refuse rather than truncate the payload as the BIP allows.
    throw new Error(`Silent payment send: address version ${sp.version} is not yet supported.`);
  }

  const internalPubkey = hexToBytes(senderPubkeyHex);
  const senderPayment = btc.p2tr(internalPubkey, undefined, btc.NETWORK);
  const changeAddress = senderPayment.address;
  if (!changeAddress) throw new Error('Silent payment send: failed to derive change address.');
  const senderScript = senderPayment.script;

  const changeScript = senderScript;

  const totalInput = utxos.reduce((s, u) => s + u.value, 0);
  const feeWithChange = estimateFee(utxos.length, 2, feeRate);
  const changeWithBoth = totalInput - amountSats - feeWithChange;
  const hasChange = changeWithBoth >= DUST_LIMIT;
  const numOutputs = hasChange ? 2 : 1;
  const fee = estimateFee(utxos.length, numOutputs, feeRate);
  const change = totalInput - amountSats - fee;
  if (change < 0) {
    throw new Error(
      `Insufficient funds. Need ${(amountSats + fee).toLocaleString()} sats, have ${totalInput.toLocaleString()} sats.`,
    );
  }

  const psbtInputs: PsbtV2Input[] = utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    witnessUtxo: { amount: BigInt(u.value), script: senderScript },
    tapInternalKey: internalPubkey,
  }));

  const psbtOutputs: PsbtV2Output[] = [
    {
      type: 'sp',
      amount: BigInt(amountSats),
      scanPubKey: sp.scanPubKey,
      spendPubKey: sp.spendPubKey,
    },
  ];
  if (hasChange) {
    psbtOutputs.push({
      type: 'script',
      amount: BigInt(change),
      script: changeScript,
    });
  }

  const psbtHex = encodePsbtV2({
    inputs: psbtInputs,
    outputs: psbtOutputs,
  });

  return { psbtHex, fee };
}

