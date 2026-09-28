import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { pubSchnorr, taprootTweakPrivKey } from '@scure/btc-signer/utils.js';

import { signPsbtLocal } from '@/lib/bitcoin';
import {
  encodePsbtV2,
  parsePsbtV2,
  type PsbtV2Output,
  type PsbtV2Input,
} from '@/lib/psbtV2';
import {
  aggregateSenderPrivateKey,
  computeBip375EcdhShare,
  deriveSilentPaymentOutputs,
  p2trScriptPubKey,
  type SilentPaymentAddress,
  type SilentPaymentInput,
  type SilentPaymentRecipient,
} from '@/lib/silentPayments';
import { generateDLEQProof } from '@/lib/dleq';

/**
 * Heavy PSBT-signing implementation for {@link NSecSignerBtc}; only ever
 * dynamically imported, to keep the BTC/SP/DLEQ stack out of the entry chunk.
 */

/** Local nsec PSBT signing — fast path for v0, BIP-375 path for SP outputs. */
export function signNsecPsbt(psbtHex: string, secretKeyBytes: Uint8Array): string {
  const privateKeyHex = hex.encode(secretKeyBytes);

  if (!hasBip375SpOutputs(psbtHex)) {
    return signPsbtLocal(psbtHex, privateKeyHex);
  }

  // BIP-375: resolve SP outputs to P2TR, sign, and re-emit a finalized PSBT v2.
  return signBip375PsbtV2Locally(psbtHex, privateKeyHex, secretKeyBytes);
}

/** Cheap sniff for a `PSBT_OUT_SP_V0_INFO` row, avoiding a full parse for v0. */
function hasBip375SpOutputs(psbtHex: string): boolean {
  // PSBT v2 VERSION global (`01fb0402000000`) plus the SP_V0_INFO key prefix (`0109`).
  return /01fb0402000000/i.test(psbtHex) && /(?:^|[0-9a-f])0109/i.test(psbtHex);
}

/**
 * Resolve BIP-375 silent payment outputs in a PSBT v2 to P2TR, sign, and return
 * a finalized PSBT v2. Assumes every input is the sender's own P2TR.
 */
function signBip375PsbtV2Locally(
  psbtHex: string,
  _privateKeyHex: string,
  secretKeyBytes: Uint8Array,
): string {
  const psbt = parsePsbtV2(psbtHex);

  // Every input's `tapInternalKey` is expected to match.
  const internalPubkey = pubSchnorr(secretKeyBytes);
  const senderPayment = btc.p2tr(internalPubkey, undefined, btc.NETWORK);
  const senderScript = senderPayment.script;

  // BIP-341 tweaked key: the scalar each P2TR input signs with, and its BIP-352 contribution.
  const tweakedPrivKey = taprootTweakPrivKey(secretKeyBytes);

  // BIP-375 PSBT_OUT_SP_V0_INFO field number.
  const O_SP_V0_INFO = 0x09;

  // Every input must be the sender's P2TR before `tweakedPrivKey` stands for all of them.
  for (const inp of psbt.inputs) {
    if (!inp.witnessUtxo) {
      throw new Error('NSecSignerBtc: input is missing witnessUtxo.');
    }
    if (!bytesEqual(inp.witnessUtxo.script, senderScript)) {
      throw new Error('NSecSignerBtc: input is not from the sender (script mismatch).');
    }
  }

  // BIP-352 `input_hash` uses the lex-smallest outpoint across all inputs.
  const allOutpoints = psbt.inputs.map((i) => ({ txid: i.txid, vout: i.vout }));

  // BIP-352: aggregate every eligible input's key (`a = Σ aᵢ`); the recipient
  // scans with `A = Σ Pᵢ`, so deriving from one input pays an unscanned key.
  const spInputs: SilentPaymentInput[] = psbt.inputs.map((i) => ({
    txid: i.txid,
    vout: i.vout,
    privateKey: tweakedPrivKey,
    isTaproot: true,
  }));

  // Collect SP recipients up-front so derivation can assign `k` per scan-key
  // group; keep their PSBT output indexes to re-pair afterwards.
  const spRecipientIndex: number[] = [];
  const spRecipients: SilentPaymentRecipient[] = [];
  const resolvedOutputs: PsbtV2Output[] = psbt.outputs.map((out, idx) => {
    if (out.script) {
      return { type: 'script', amount: out.amount, script: out.script };
    }
    const spInfo = out.unknown.find((u) => u.keyType === O_SP_V0_INFO && u.keyData.length === 0);
    if (!spInfo) {
      throw new Error('NSecSignerBtc: output is missing both PSBT_OUT_SCRIPT and PSBT_OUT_SP_V0_INFO.');
    }
    // value = 1-byte version || 33-byte scan key || 33-byte spend key
    if (spInfo.value.length !== 67) {
      throw new Error('NSecSignerBtc: invalid PSBT_OUT_SP_V0_INFO length.');
    }
    const version = spInfo.value[0];
    if (version !== 0) {
      throw new Error(`NSecSignerBtc: silent payment version ${version} is not supported by the local signer.`);
    }
    const spAddress: SilentPaymentAddress = {
      hrp: 'sp',
      network: 'mainnet',
      version: 0,
      scanPubKey: spInfo.value.slice(1, 34),
      spendPubKey: spInfo.value.slice(34, 67),
    };
    spRecipientIndex.push(idx);
    spRecipients.push({ address: spAddress });
    return { type: 'script', amount: out.amount, script: new Uint8Array(0) };
  });

  if (spRecipients.length > 0) {
    const derived = deriveSilentPaymentOutputs(spInputs, spRecipients, {
      allOutpoints,
      network: 'mainnet',
    });
    // Derived outputs are grouped by scan key; match back by recipient identity.
    for (const out of derived) {
      const i = spRecipients.indexOf(out.recipient);
      if (i < 0) throw new Error('NSecSignerBtc: derived SP output has no matching recipient.');
      const psbtIdx = spRecipientIndex[i];
      const script = p2trScriptPubKey(out.xOnlyPubKey);
      resolvedOutputs[psbtIdx] = {
        type: 'script',
        amount: psbt.outputs[psbtIdx].amount,
        script,
      };
    }
  }

  // BIP-375 global ECDH share + DLEQ proof per scan key (single signer owning
  // all inputs), so external verifiers can re-derive the output scripts.
  const spGlobals: { scanPubKey: Uint8Array; ecdhShare: Uint8Array; dleqProof: Uint8Array }[] = [];
  if (spRecipients.length > 0) {
    const agg = aggregateSenderPrivateKey(spInputs, allOutpoints);
    // One share per unique scan key.
    const seen = new Map<string, Uint8Array>();
    for (const r of spRecipients) {
      const key = bytesToHexLocal(r.address.scanPubKey);
      if (!seen.has(key)) seen.set(key, r.address.scanPubKey);
    }
    for (const scanPubKey of seen.values()) {
      const ecdhShare = computeBip375EcdhShare(agg.aggregateScalar, scanPubKey);
      const auxRand = new Uint8Array(32);
      crypto.getRandomValues(auxRand);
      const { proof } = generateDLEQProof({ a: agg.aggregateScalar, B: scanPubKey, auxRand });
      spGlobals.push({ scanPubKey, ecdhShare, dleqProof: proof });
    }
  }

  // Sign via a plain @scure/btc-signer Transaction (we control every input/output).
  const tx = new btc.Transaction();
  for (const inp of psbt.inputs) {
    // Validated above; repeated only to narrow the type.
    if (!inp.witnessUtxo) {
      throw new Error('NSecSignerBtc: input is missing witnessUtxo.');
    }
    tx.addInput({
      txid: inp.txid,
      index: inp.vout,
      sequence: inp.sequence,
      witnessUtxo: {
        script: inp.witnessUtxo.script,
        amount: inp.witnessUtxo.amount,
      },
      tapInternalKey: internalPubkey,
    });
  }
  for (const out of resolvedOutputs) {
    if (out.type !== 'script') throw new Error('unreachable: SP output left unresolved');
    tx.addOutput({ amount: out.amount, script: out.script });
  }

  const signed = tx.sign(secretKeyBytes);
  if (signed === 0) {
    throw new Error('NSecSignerBtc: no inputs were signed.');
  }
  tx.finalize();

  // Back to a finalized PSBT v2 with witnesses and any BIP-375 globals.
  return finalizedTxToPsbtV2(tx, psbt.inputs, resolvedOutputs, spGlobals);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToHexLocal(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * Serialize a signed `Transaction` into PSBT v2 with `finalScriptWitness` per
 * input. `tx.toPSBT(2)` would strip unknown fields.
 */
function finalizedTxToPsbtV2(
  tx: btc.Transaction,
  inputs: { txid: string; vout: number; sequence: number; witnessUtxo?: { amount: bigint; script: Uint8Array } }[],
  outputs: PsbtV2Output[],
  silentPaymentGlobals?: { scanPubKey: Uint8Array; ecdhShare: Uint8Array; dleqProof: Uint8Array }[],
): string {
  const psbtInputs: PsbtV2Input[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const txInp = tx.getInput(i);
    const finalWitness = (txInp.finalScriptWitness ?? []) as Uint8Array[];
    const orig = inputs[i];
    if (!orig.witnessUtxo) {
      throw new Error('finalizedTxToPsbtV2: missing witness UTXO on input.');
    }
    psbtInputs.push({
      txid: orig.txid,
      vout: orig.vout,
      sequence: orig.sequence,
      witnessUtxo: orig.witnessUtxo,
      finalScriptWitness: finalWitness.length > 0 ? finalWitness : undefined,
    });
  }

  return encodePsbtV2({
    inputs: psbtInputs,
    outputs,
    silentPaymentGlobals: silentPaymentGlobals && silentPaymentGlobals.length > 0
      ? silentPaymentGlobals
      : undefined,
    // BIP-375: `PSBT_GLOBAL_TX_MODIFIABLE` must be 0 once SP outputs are resolved and signed.
    txModifiable: silentPaymentGlobals && silentPaymentGlobals.length > 0 ? 0 : undefined,
  });
}
