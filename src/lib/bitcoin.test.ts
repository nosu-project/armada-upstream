/**
 * Wallet send-path regressions: the two places where a wrong number is not a
 * crash but a valid, broadcastable transaction that loses the user's money.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { NSecSignerBtc } from "@/lib/bitcoin-signers";
import { buildUnsignedSilentPaymentPsbt, estimateFee, getFeeRates, type UTXO } from "@/lib/bitcoin";
import { _resetEsploraStateForTests } from "@/lib/esplora";
import { parsePsbtV2 } from "@/lib/psbtV2";
import {
  decodeSilentPaymentAddress,
  deriveSilentPaymentOutputs,
  p2trScriptPubKey,
  tweakNsecForTaproot,
} from "@/lib/silentPayments";

/** BIP-352 reference silent payment address. */
const REFERENCE_SP_ADDRESS =
  "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv";

/** A valid 32-byte secp256k1 private key (BIP-340 test vector). */
const SENDER_NSEC_HEX = "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef";

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("silent payment sends (BIP-352 / BIP-375)", () => {
  /**
   * BIP-352 requires the sender to aggregate the private keys of EVERY
   * eligible input, because the recipient reconstructs the matching
   * `A = Σ Pᵢ` from the transaction's inputs when scanning. Deriving from
   * `inputs[0]` alone is invisible with one UTXO and silently misdirects the
   * payment with two — the steady state for any wallet that has received
   * anything, since the wallet spends every UTXO on each send. Nothing fails:
   * the transaction confirms and change comes back, but the recipient never
   * sees the money.
   */
  it("derives the SP output from every input, not just the first", async () => {
    const signer = new NSecSignerBtc(hexToBytes(SENDER_NSEC_HEX));
    const senderPubkey = await signer.getPublicKey();

    const utxos: UTXO[] = [
      {
        txid: "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16",
        vout: 0,
        value: 100_000,
        status: { confirmed: true },
      },
      {
        txid: "0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098",
        vout: 1,
        value: 60_000,
        status: { confirmed: true },
      },
    ];

    const signOne = async (spend: UTXO[]) => {
      const { psbtHex } = buildUnsignedSilentPaymentPsbt(
        senderPubkey,
        REFERENCE_SP_ADDRESS,
        40_000,
        spend,
        5,
      );
      return parsePsbtV2(await signer.signPsbt(psbtHex)).outputs[0].script!;
    };

    const oneInput = await signOne([utxos[0]]);
    const twoInputs = await signOne(utxos);

    // The signature of the defect: the derived output was identical no matter
    // how many inputs the transaction spent.
    expect(Array.from(twoInputs)).not.toEqual(Array.from(oneInput));

    // And it must equal what a spec-correct derivation over both inputs
    // produces — the script the recipient's scanner actually looks for.
    const tweaked = tweakNsecForTaproot(SENDER_NSEC_HEX);
    const [expected] = deriveSilentPaymentOutputs(
      utxos.map((u) => ({ txid: u.txid, vout: u.vout, privateKey: tweaked, isTaproot: true })),
      [{ address: decodeSilentPaymentAddress(REFERENCE_SP_ADDRESS) }],
      { allOutpoints: utxos.map((u) => ({ txid: u.txid, vout: u.vout })), network: "mainnet" },
    );
    expect(Array.from(twoInputs)).toEqual(Array.from(p2trScriptPubKey(expected.xOnlyPubKey)));
  });
});

describe("fee rates from the Esplora endpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetEsploraStateForTests();
  });

  function stubFeeEstimates(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  }

  it("keeps plausible rates", async () => {
    stubFeeEstimates({ "1": 12.4, "3": 8, "6": 5, "144": 2, "504": 1 });
    const rates = await getFeeRates(["https://esplora.test/api"]);
    expect(rates).toEqual({
      fastestFee: 13,
      halfHourFee: 8,
      hourFee: 5,
      economyFee: 2,
      minimumFee: 1,
    });
  });

  /**
   * `Math.ceil(data['1'] || 1)` only caught FALSY values, so a truthy
   * non-number — the shape an API-version mismatch produces — yielded NaN,
   * which passes every downstream guard (all `<` / `>=` comparisons are false
   * for NaN) and produces a valid transaction paying the wallet's whole
   * balance to miners.
   */
  it("falls back to 1 sat/vB for non-numeric, missing and sub-1 rates", async () => {
    stubFeeEstimates({ "1": "5", "3": { fee: 5 }, "6": null, "144": 0.4, "504": -3 });
    const rates = await getFeeRates(["https://esplora.test/api"]);
    expect(rates).toEqual({
      fastestFee: 1,
      halfHourFee: 1,
      hourFee: 1,
      economyFee: 1,
      minimumFee: 1,
    });
  });

  it("caps implausible rates", async () => {
    stubFeeEstimates({ "1": 1e9, "3": Infinity, "6": NaN, "144": 3, "504": 1 });
    const rates = await getFeeRates(["https://esplora.test/api"]);
    expect(rates.fastestFee).toBe(5_000);
    expect(rates.halfHourFee).toBe(1);
    expect(rates.hourFee).toBe(1);
  });

  it("refuses to estimate a fee from an unusable rate", () => {
    expect(() => estimateFee(2, 2, NaN)).toThrow(/Invalid fee rate/);
    expect(() => estimateFee(2, 2, 0)).toThrow(/Invalid fee rate/);
    expect(estimateFee(2, 2, 1)).toBeGreaterThan(0);
  });
});
