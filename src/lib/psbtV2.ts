/**
 * PSBT v2 (BIP-370) encoder/parser with BIP-375 silent-payment fields, over
 * `@scure/btc-signer`'s internal `_RawPSBTV2` coder — which, unlike `RawPSBTV2`,
 * leaves `PSBT_OUT_SCRIPT` optional on outputs carrying only
 * `PSBT_OUT_SP_V0_INFO` (BIP-375: the signer derives the script). Unknown rows
 * are surfaced by keytype.
 *
 * Refs: BIP-174, BIP-370, BIP-375 (SP_V0_INFO = `version(1) || scan(33) || spend(33)`).
 */
import { _RawPSBTV2 } from '@scure/btc-signer/psbt.js';

// BIP-370/375 keytypes; callers inspect unknown rows by `keyType`.

const G_TX_MODIFIABLE = 0x06;
// BIP-375 globals, written/read via the library's `unknown` passthrough.
const G_SP_ECDH_SHARE = 0x07;
const G_SP_DLEQ = 0x08;

// BIP-375 per-input fields kept as "unknown": PSBT_IN_SP_ECDH_SHARE = 0x1d, PSBT_IN_SP_DLEQ = 0x1e.

const O_SP_V0_INFO = 0x09;
const O_SP_V0_LABEL = 0x0a;

/** Bitcoin compact-size integer (1/3/5/9 bytes). Exported for `bitcoin-signers.ts` witness encoding. */
export function encodeCompactSize(n: number): Uint8Array {
  if (!Number.isFinite(n) || n < 0) throw new Error(`compactSize: out of range (${n}).`);
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    b[1] = n & 0xff;
    b[2] = (n >>> 8) & 0xff;
    return b;
  }
  if (n <= 0xffffffff) {
    const b = new Uint8Array(5);
    b[0] = 0xfe;
    b[1] = n & 0xff;
    b[2] = (n >>> 8) & 0xff;
    b[3] = (n >>> 16) & 0xff;
    b[4] = (n >>> 24) & 0xff;
    return b;
  }
  // We don't construct PSBTs larger than 4 GB.
  throw new Error('compactSize: value too large for safe-integer encoding.');
}

function decodeCompactSize(bytes: Uint8Array, offset: number): { value: number; size: number } {
  if (offset >= bytes.length) throw new Error('compactSize: unexpected end of input.');
  const first = bytes[offset];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) {
    if (offset + 3 > bytes.length) throw new Error('compactSize: truncated 16-bit value.');
    return { value: bytes[offset + 1] | (bytes[offset + 2] << 8), size: 3 };
  }
  if (first === 0xfe) {
    if (offset + 5 > bytes.length) throw new Error('compactSize: truncated 32-bit value.');
    const v = (bytes[offset + 1]
      | (bytes[offset + 2] << 8)
      | (bytes[offset + 3] << 16)
      | (bytes[offset + 4] << 24)) >>> 0;
    return { value: v, size: 5 };
  }
  throw new Error('compactSize: 64-bit values not supported.');
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}

function u64le(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('u64le: negative value.');
  const b = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function hexToBytes(s: string): Uint8Array {
  if (typeof s !== 'string' || s.length % 2 !== 0) {
    throw new Error('hexToBytes: invalid hex string.');
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error('hexToBytes: invalid character.');
    out[i] = b;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * Whether the globals carry `PSBT_GLOBAL_VERSION` (0xfb) = 2; absent means v0.
 * Sniffed ourselves because the library's v0 error ("missing unsignedTx") is
 * hard to route on.
 */
function hasPsbtV2Marker(bytes: Uint8Array): boolean {
  let offset = 5; // skip magic
  while (offset < bytes.length) {
    const klen = decodeCompactSize(bytes, offset);
    offset += klen.size;
    if (klen.value === 0) return false; // hit globals separator with no version row
    if (offset + klen.value > bytes.length) return false;
    const keyType = bytes[offset];
    const keyEnd = offset + klen.value;
    offset = keyEnd;
    const vlen = decodeCompactSize(bytes, offset);
    offset += vlen.size;
    if (offset + vlen.value > bytes.length) return false;
    if (keyType === 0xfb && vlen.value === 4) {
      const v = bytes[offset]
        | (bytes[offset + 1] << 8)
        | (bytes[offset + 2] << 16)
        | (bytes[offset + 3] << 24);
      if (v === 2) return true;
    }
    offset += vlen.value;
  }
  return false;
}

/** A previous-output reference for a PSBT v2 input. */
export interface PsbtV2Input {
  /** Display-order (big-endian) txid hex. */
  txid: string;
  vout: number;
  /** nSequence (defaults to 0xfffffffd, BIP-125 RBF-enabled). */
  sequence?: number;
  /** Witness UTXO (required; the wallet only builds P2TR key-path inputs). */
  witnessUtxo: {
    /** Amount in satoshis. */
    amount: bigint;
    /** Previous output's `scriptPubKey` (e.g. `OP_1 push32 <xonly>`). */
    script: Uint8Array;
  };
  /** Optional 32-byte x-only Taproot internal key. */
  tapInternalKey?: Uint8Array;
  /**
   * Pre-finalized witness (`PSBT_IN_FINAL_SCRIPTWITNESS`), used by the local
   * nsec signer to round-trip through {@link extractTxFromSignedPsbtV2}.
   */
  finalScriptWitness?: Uint8Array[];
}

/** A regular (non-SP) output: known script + amount. */
export interface PsbtV2OutputRegular {
  type: 'script';
  /** Amount in satoshis. */
  amount: bigint;
  /** scriptPubKey bytes (e.g. P2TR `OP_1 push32 <xonly>`). */
  script: Uint8Array;
}

/** A BIP-375 silent payment output: signer fills in the script. */
export interface PsbtV2OutputSilentPayment {
  type: 'sp';
  /** Amount in satoshis. */
  amount: bigint;
  /** 33-byte compressed scan key from the recipient's `sp1…` address. */
  scanPubKey: Uint8Array;
  /** 33-byte compressed spend key (`B_m`) from the recipient's address. */
  spendPubKey: Uint8Array;
  /** Change label as PSBT_OUT_SP_V0_LABEL (u32 LE); only for the sender's own change. */
  label?: number;
}

export type PsbtV2Output = PsbtV2OutputRegular | PsbtV2OutputSilentPayment;

export interface PsbtV2EncodeOptions {
  /** Transaction version (defaults to 2; BIP-68 / BIP-112-friendly). */
  txVersion?: number;
  /** Fallback `nLockTime` (defaults to 0). */
  fallbackLocktime?: number;
  /**
   * `PSBT_GLOBAL_TX_MODIFIABLE`; BIP-375 requires 0 once every output script is
   * filled. Omitted by default ("no constraints announced").
   */
  txModifiable?: number;
  /**
   * BIP-375 global ECDH shares + DLEQ proofs by scan key (single signer owning all
   * inputs). Each yields `PSBT_GLOBAL_SP_ECDH_SHARE` (0x07, 33-byte `C = a·B_scan`)
   * and `PSBT_GLOBAL_SP_DLEQ` (0x08, 64-byte BIP-374 proof), so verifiers can
   * re-derive output scripts.
   */
  silentPaymentGlobals?: {
    scanPubKey: Uint8Array;
    ecdhShare: Uint8Array;
    dleqProof: Uint8Array;
  }[];
  inputs: PsbtV2Input[];
  outputs: PsbtV2Output[];
}

/** The library's `unknown` rows: `[{type, key}, value]` tuples. */
type LibUnknown = [{ type: number; key: Uint8Array }, Uint8Array][];

/**
 * Serialize a PSBT v2 to hex. `type: 'sp'` outputs get `PSBT_OUT_SP_V0_INFO`
 * (and optional label) instead of a script, per BIP-375.
 */
export function encodePsbtV2(opts: PsbtV2EncodeOptions): string {
  const txVersion = opts.txVersion ?? 2;
  const fallbackLocktime = opts.fallbackLocktime ?? 0;
  const inputs = opts.inputs;
  const outputs = opts.outputs;

  // The library writes PSBT_GLOBAL_VERSION itself.
  const globalUnknown: LibUnknown = [];
  if (opts.txModifiable !== undefined) {
    globalUnknown.push([
      { type: G_TX_MODIFIABLE, key: new Uint8Array(0) },
      new Uint8Array([opts.txModifiable & 0xff]),
    ]);
  }
  if (opts.silentPaymentGlobals) {
    for (const sp of opts.silentPaymentGlobals) {
      if (sp.scanPubKey.length !== 33) {
        throw new Error('PSBT v2 global SP: scanPubKey must be 33 bytes.');
      }
      if (sp.ecdhShare.length !== 33) {
        throw new Error('PSBT v2 global SP: ecdhShare must be 33 bytes.');
      }
      if (sp.dleqProof.length !== 64) {
        throw new Error('PSBT v2 global SP: dleqProof must be 64 bytes.');
      }
      globalUnknown.push([
        { type: G_SP_ECDH_SHARE, key: new Uint8Array(sp.scanPubKey) },
        new Uint8Array(sp.ecdhShare),
      ]);
      globalUnknown.push([
        { type: G_SP_DLEQ, key: new Uint8Array(sp.scanPubKey) },
        new Uint8Array(sp.dleqProof),
      ]);
    }
  }

  const globalShape: Record<string, unknown> = {
    txVersion,
    fallbackLocktime,
    inputCount: inputs.length,
    outputCount: outputs.length,
    version: 2,
  };
  if (globalUnknown.length > 0) globalShape.unknown = globalUnknown;

  const inputShapes = inputs.map((inp) => {
    if (inp.tapInternalKey !== undefined && inp.tapInternalKey.length !== 32) {
      throw new Error('PSBT v2 input: tapInternalKey must be 32 bytes.');
    }
    const txidBytes = hexToBytes(inp.txid);
    if (txidBytes.length !== 32) {
      throw new Error('PSBT v2 input: txid must be 32 bytes.');
    }
    const obj: Record<string, unknown> = {
      // Library takes display-order txid bytes and reverses internally.
      txid: txidBytes,
      index: inp.vout,
      sequence: inp.sequence ?? 0xfffffffd,
      witnessUtxo: { amount: inp.witnessUtxo.amount, script: inp.witnessUtxo.script },
    };
    if (inp.tapInternalKey) obj.tapInternalKey = inp.tapInternalKey;
    if (inp.finalScriptWitness && inp.finalScriptWitness.length > 0) {
      obj.finalScriptWitness = inp.finalScriptWitness;
    }
    return obj;
  });

  const outputShapes = outputs.map((out) => {
    if (out.type === 'script') {
      return { amount: out.amount, script: out.script };
    }
    if (out.scanPubKey.length !== 33) {
      throw new Error('PSBT v2 output: scanPubKey must be 33 bytes.');
    }
    if (out.spendPubKey.length !== 33) {
      throw new Error('PSBT v2 output: spendPubKey must be 33 bytes.');
    }
    // SP_V0_INFO = version(0) || scan(33) || spend(33), per BIP-375 "Unique Identification".
    const spInfo = concat(new Uint8Array([0x00]), out.scanPubKey, out.spendPubKey);
    const unknown: LibUnknown = [[{ type: O_SP_V0_INFO, key: new Uint8Array(0) }, spInfo]];
    if (out.label !== undefined) {
      unknown.push([
        { type: O_SP_V0_LABEL, key: new Uint8Array(0) },
        u32le(out.label),
      ]);
    }
    return {
      amount: out.amount,
      // No `script`: optional when SP_V0_INFO is set (BIP-375).
      unknown,
    };
  });

  // Deep library typing isn't worth threading through statically.
  type LibInput = Parameters<typeof _RawPSBTV2.encode>[0];
  const libPsbt = {
    magic: undefined,
    global: globalShape,
    inputs: inputShapes,
    outputs: outputShapes,
  } as unknown as LibInput;

  let bytes: Uint8Array;
  try {
    bytes = _RawPSBTV2.encode(libPsbt);
  } catch (err) {
    throw new Error(
      `PSBT v2 encode failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return bytesToHex(bytes);
}

/** An unknown PSBT key/value row, with the keytype byte separated out. */
export interface PsbtKV {
  /** First key byte (the BIP-174 keytype). */
  keyType: number;
  keyData: Uint8Array;
  value: Uint8Array;
}

/** Decoded PSBT v2 input scope. */
export interface ParsedPsbtV2Input {
  /** Display-order txid hex. */
  txid: string;
  vout: number;
  sequence: number;
  finalScriptSig?: Uint8Array;
  finalScriptWitness?: Uint8Array[];
  /**
   * BIP-371 Taproot key-path signature. Signed-but-not-finalized PSBTs carry it
   * here; {@link extractTxFromSignedPsbtV2} wraps it into the witness.
   */
  tapKeySig?: Uint8Array;
  witnessUtxo?: { amount: bigint; script: Uint8Array };
  /** Unrecognised key/value pairs preserved for completeness. */
  unknown: PsbtKV[];
}

/** Decoded PSBT v2 output scope. */
export interface ParsedPsbtV2Output {
  amount: bigint;
  /** scriptPubKey; absent if the signer left `PSBT_OUT_SP_V0_INFO` unfilled. */
  script?: Uint8Array;
  /** Unrecognised key/value pairs preserved for completeness. */
  unknown: PsbtKV[];
}

/** Result of {@link parsePsbtV2}. */
export interface ParsedPsbtV2 {
  txVersion: number;
  fallbackLocktime: number;
  inputs: ParsedPsbtV2Input[];
  outputs: ParsedPsbtV2Output[];
}

function unknownToKVs(unknown: unknown): PsbtKV[] {
  if (!unknown || !Array.isArray(unknown)) return [];
  return (unknown as LibUnknown).map(([k, v]) => ({
    keyType: k.type,
    keyData: new Uint8Array(k.key),
    value: new Uint8Array(v),
  }));
}

/**
 * Decode a PSBT v2 (BIP-375 fields allowed) from hex. Unknown keytypes are
 * tolerated; required BIP-370 structural fields are validated; v0/v1 rejected.
 */
export function parsePsbtV2(psbtHex: string): ParsedPsbtV2 {
  const bytes = hexToBytes(psbtHex);
  // Early shape checks to throw the project's familiar error wording.
  if (bytes.length < 5) {
    throw new Error('PSBT parse: truncated header (magic).');
  }
  if (
    bytes[0] !== 0x70 || bytes[1] !== 0x73 || bytes[2] !== 0x62 || bytes[3] !== 0x74 || bytes[4] !== 0xff
  ) {
    throw new Error('PSBT parse: bad magic.');
  }

  // The library would take v0 and fail with a confusing error; sniff the version ourselves.
  if (!hasPsbtV2Marker(bytes)) {
    throw new Error('PSBT parse: only PSBT v2 is supported in this code path.');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  try {
    raw = _RawPSBTV2.decode(bytes);
  } catch (err) {
    throw new Error(
      `PSBT parse: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const global = raw.global as Record<string, unknown> | undefined;
  const version = (global?.version as number | undefined) ?? 0;
  if (version !== 2) {
    throw new Error('PSBT parse: only PSBT v2 is supported in this code path.');
  }
  // BIP-370: PSBT_GLOBAL_UNSIGNED_TX must NOT appear in PSBTv2.
  if (global?.unsignedTx !== undefined) {
    throw new Error('PSBT parse: PSBT_GLOBAL_UNSIGNED_TX must not appear in PSBT v2.');
  }
  const txVersion = global?.txVersion as number | undefined;
  if (txVersion === undefined) {
    throw new Error('PSBT parse: missing PSBT_GLOBAL_TX_VERSION.');
  }
  const fallbackLocktime = (global?.fallbackLocktime as number | undefined) ?? 0;
  const inputCount = global?.inputCount as number | undefined;
  const outputCount = global?.outputCount as number | undefined;
  if (inputCount === undefined) {
    throw new Error('PSBT parse: missing PSBT_GLOBAL_INPUT_COUNT.');
  }
  if (outputCount === undefined) {
    throw new Error('PSBT parse: missing PSBT_GLOBAL_OUTPUT_COUNT.');
  }

  const rawInputs = (raw.inputs ?? []) as Record<string, unknown>[];
  const rawOutputs = (raw.outputs ?? []) as Record<string, unknown>[];
  if (rawInputs.length !== inputCount) {
    throw new Error(
      `PSBT parse: input count mismatch (header says ${inputCount}, got ${rawInputs.length}).`,
    );
  }
  if (rawOutputs.length !== outputCount) {
    throw new Error(
      `PSBT parse: output count mismatch (header says ${outputCount}, got ${rawOutputs.length}).`,
    );
  }

  const inputs: ParsedPsbtV2Input[] = rawInputs.map((inp, i) => {
    const txidBytes = inp.txid as Uint8Array | undefined;
    const vout = inp.index as number | undefined;
    if (!txidBytes || txidBytes.length !== 32) {
      throw new Error(`PSBT parse: input ${i} missing PSBT_IN_PREVIOUS_TXID.`);
    }
    if (vout === undefined) {
      throw new Error(`PSBT parse: input ${i} missing PSBT_IN_OUTPUT_INDEX.`);
    }
    const sequence = (inp.sequence as number | undefined) ?? 0xfffffffd;
    const witnessUtxoLib = inp.witnessUtxo as { amount: bigint; script: Uint8Array } | undefined;
    const witnessUtxo = witnessUtxoLib
      ? { amount: witnessUtxoLib.amount, script: new Uint8Array(witnessUtxoLib.script) }
      : undefined;
    const finalScriptSig = inp.finalScriptSig as Uint8Array | undefined;
    const finalScriptWitness = inp.finalScriptWitness as Uint8Array[] | undefined;
    const tapKeySig = inp.tapKeySig as Uint8Array | undefined;
    return {
      // Library returns display-order bytes.
      txid: bytesToHex(txidBytes),
      vout,
      sequence,
      finalScriptSig: finalScriptSig ? new Uint8Array(finalScriptSig) : undefined,
      finalScriptWitness: finalScriptWitness
        ? finalScriptWitness.map((w) => new Uint8Array(w))
        : undefined,
      tapKeySig: tapKeySig ? new Uint8Array(tapKeySig) : undefined,
      witnessUtxo,
      unknown: unknownToKVs(inp.unknown),
    };
  });

  const outputs: ParsedPsbtV2Output[] = rawOutputs.map((out, i) => {
    const amount = out.amount as bigint | undefined;
    if (amount === undefined) {
      throw new Error(`PSBT parse: output ${i} missing PSBT_OUT_AMOUNT.`);
    }
    const script = out.script as Uint8Array | undefined;
    return {
      amount,
      script: script ? new Uint8Array(script) : undefined,
      unknown: unknownToKVs(out.unknown),
    };
  });

  return { txVersion, fallbackLocktime, inputs, outputs };
}

/**
 * Raw tx hex from a fully-signed PSBT v2. Every input needs a final script/
 * witness or a `tapKeySig` (auto-finalized per BIP-341); every output needs a
 * script (SP outputs must have been derived by the signer).
 */
export function extractTxFromSignedPsbtV2(psbtHex: string): string {
  const psbt = parsePsbtV2(psbtHex);

  // BIP-174 Finalizer role: wrap a lone `tapKeySig` into a single-item witness.
  for (let i = 0; i < psbt.inputs.length; i++) {
    const inp = psbt.inputs[i];
    if (
      !inp.finalScriptSig &&
      !inp.finalScriptWitness &&
      inp.tapKeySig
    ) {
      inp.finalScriptWitness = [inp.tapKeySig];
    }
  }

  for (let i = 0; i < psbt.inputs.length; i++) {
    const inp = psbt.inputs[i];
    if (!inp.finalScriptSig && !inp.finalScriptWitness) {
      throw new Error(`PSBT v2 extract: input ${i} is not finalized (no scriptSig or witness).`);
    }
  }
  for (let i = 0; i < psbt.outputs.length; i++) {
    if (!psbt.outputs[i].script) {
      throw new Error(
        `PSBT v2 extract: output ${i} has no scriptPubKey — the signer must derive silent payment outputs before extraction.`,
      );
    }
  }

  const hasAnyWitness = psbt.inputs.some(
    (i) => i.finalScriptWitness && i.finalScriptWitness.length > 0,
  );

  const parts: Uint8Array[] = [];
  parts.push(u32le(psbt.txVersion));

  if (hasAnyWitness) {
    parts.push(new Uint8Array([0x00, 0x01]));
  }

  parts.push(encodeCompactSize(psbt.inputs.length));
  for (const inp of psbt.inputs) {
    const txidDisplay = hexToBytes(inp.txid);
    const txidWire = new Uint8Array(txidDisplay).reverse();
    parts.push(txidWire);
    parts.push(u32le(inp.vout));
    const ss = inp.finalScriptSig ?? new Uint8Array(0);
    parts.push(encodeCompactSize(ss.length));
    parts.push(ss);
    parts.push(u32le(inp.sequence));
  }

  parts.push(encodeCompactSize(psbt.outputs.length));
  for (const out of psbt.outputs) {
    parts.push(u64le(out.amount));
    const script = out.script!;
    parts.push(encodeCompactSize(script.length));
    parts.push(script);
  }

  if (hasAnyWitness) {
    for (const inp of psbt.inputs) {
      const w = inp.finalScriptWitness ?? [];
      parts.push(encodeCompactSize(w.length));
      for (const item of w) {
        parts.push(encodeCompactSize(item.length));
        parts.push(item);
      }
    }
  }

  parts.push(u32le(psbt.fallbackLocktime));

  return bytesToHex(concat(...parts));
}

export const _internal = { decodeCompactSize, u32le, u64le };
