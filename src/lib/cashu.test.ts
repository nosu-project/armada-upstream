import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  CASHU_TOKEN_PATTERN,
  cashuMintLabel,
  formatCashuAmount,
  hashToCurve,
  parseCashuToken,
} from "./cashu";

// A real single-proof v4 token drawn on mint.cubabitcoin.org.
const V4_TOKEN =
  "cashuBo2FteBxodHRwczovL21pbnQuY3ViYWJpdGNvaW4ub3JnYXVjc2F0YXSBomFpSAC58En8vOXiYXCBpGFhAWFzeEBlM2U4ZTRiOWNhYzliMDU1Mzk2YTA4NWYyMGE0OTA1YjExYWFhNjFkYTg4OTMzNjVmZWFhOTllOWYzODc5ZjVmYWNYIQOQlZ-VuwxjGqYpE6oWVfHtGZ1V3YU9NHbkTlbsnH1Ak2Fko2FlWCCzp3Z9Q_SBJ-VR1mRtGKTw6sBgJVrpZRWhfBtQqnapaGFzWCBTDc9miPQghpSsAVN7SAcrugojQu90Wun5Z5EQmlZTE2FyWCDzLD2a2TxUwFzNQJxaxBRrlI-McNHhxEA2VRUisDHvog";

describe("parseCashuToken", () => {
  it("parses a v4 (cashuB / CBOR) token", () => {
    expect(parseCashuToken(V4_TOKEN)).toEqual({
      version: 4,
      amount: 1,
      unit: "sat",
      mint: "https://mint.cubabitcoin.org",
      memo: undefined,
      proofs: 1,
      secrets: ["e3e8e4b9cac9b055396a085f20a4905b11aaa61da8893365feaa99e9f3879f5f"],
    });
  });

  it("parses a v3 (cashuA / JSON) token", () => {
    const payload = {
      token: [{
        mint: "https://8333.space:3338",
        proofs: [
          { id: "009a1f293253e41e", amount: 2, secret: "s1", C: "02aaa" },
          { id: "009a1f293253e41e", amount: 8, secret: "s2", C: "02bbb" },
        ],
      }],
      unit: "sat",
      memo: "Thank you.",
    };
    const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(parseCashuToken(`cashuA${b64}`)).toEqual({
      version: 3,
      amount: 10,
      unit: "sat",
      mint: "https://8333.space:3338",
      memo: "Thank you.",
      proofs: 2,
      secrets: ["s1", "s2"],
    });
  });

  it("accepts a cashu: URI scheme", () => {
    expect(parseCashuToken(`cashu:${V4_TOKEN}`)?.amount).toBe(1);
  });

  it("rejects non-tokens and undecodable payloads", () => {
    expect(parseCashuToken("cashuC" + "a".repeat(40))).toBeNull();
    expect(parseCashuToken("cashuB")).toBeNull();
    expect(parseCashuToken("cashuBnotvalidcbor")).toBeNull();
    expect(parseCashuToken("cashuA" + btoa("[]"))).toBeNull();
    expect(parseCashuToken("hello")).toBeNull();
  });

  it("rejects a token with no proofs", () => {
    const b64 = btoa(JSON.stringify({ token: [{ mint: "https://m", proofs: [] }] }));
    expect(parseCashuToken(`cashuA${b64}`)).toBeNull();
  });
});

describe("CASHU_TOKEN_PATTERN", () => {
  const regex = new RegExp(CASHU_TOKEN_PATTERN, "g");

  it("matches a token embedded in a sentence", () => {
    const matches = `here you go ${V4_TOKEN} enjoy`.match(regex);
    expect(matches).toEqual([V4_TOKEN]);
  });

  it("does not match bare words", () => {
    expect("cashu is neat".match(regex)).toBeNull();
  });
});

describe("hashToCurve", () => {
  // Official NUT-00 test vectors.
  it("matches the NUT-00 vectors", () => {
    expect(hashToCurve(hexToBytes("00".repeat(32))))
      .toBe("024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725");
    expect(hashToCurve(hexToBytes("00".repeat(31) + "01")))
      .toBe("022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf");
    // This one only lands on the curve after the counter increments.
    expect(hashToCurve(hexToBytes("00".repeat(31) + "02")))
      .toBe("026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f");
  });
});

describe("display helpers", () => {
  it("labels a mint by host", () => {
    expect(cashuMintLabel("https://mint.cubabitcoin.org")).toBe("mint.cubabitcoin.org");
    expect(cashuMintLabel("")).toBe("unknown mint");
    expect(cashuMintLabel("not a url")).toBe("not a url");
  });

  it("formats amounts per unit", () => {
    expect(formatCashuAmount(21000, "sat")).toBe("21,000 sat");
    expect(formatCashuAmount(250, "usd")).toBe("$2.50");
    expect(formatCashuAmount(5, "custom")).toBe("5 custom");
  });
});
