import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  EMOJI_PLACEHOLDER,
  applyDisplayEdit,
  buildDisplayModel,
  codeRanges,
  mentionLabel,
  mentionedPubkeys,
  spliceDisplay,
  toCanonical,
  toDisplay,
} from "@/lib/composerText";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const aliceRef = `nostr:${nip19.npubEncode(ALICE)}`;
const bobRef = `nostr:${nip19.nprofileEncode({ pubkey: BOB, relays: ["wss://r.example"] })}`;
const labels = (pk: string) => (pk === ALICE ? "@Alice" : pk === BOB ? "@Bob" : "");
const model = (canonical: string) => buildDisplayModel(canonical, labels);

describe("mentionLabel", () => {
  it("strips bidi controls, which would reorder the text after the label", () => {
    expect(mentionLabel("\u202Eecila\u2066x\u2069", ALICE)).toBe("@ecilax");
  });
});

describe("buildDisplayModel", () => {
  it("shows npub and nprofile references as their labels", () => {
    const m = model(`hi ${aliceRef} and ${bobRef}!`);
    expect(m.display).toBe("hi @Alice and @Bob!");
    expect(m.atoms.map((s) => s.pubkey)).toEqual([ALICE, BOB]);
    expect(mentionedPubkeys(m.canonical)).toEqual([ALICE, BOB]);
  });

  it("leaves references in code and invalid bech32 literal", () => {
    const canonical = `\`${aliceRef}\` nostr:npub1qqqq\n\`\`\`\n${aliceRef}\n\`\`\``;
    expect(model(canonical).display).toBe(canonical);
    expect(codeRanges("a `b` c")).toEqual([[2, 5]]);
  });

  it("does not render a reference whose bech32 runs on into a word", () => {
    expect(model(`${aliceRef}word`).atoms).toHaveLength(0);
  });

  it("maps positions both ways, snapping inside a mention", () => {
    const m = model(`x ${aliceRef} y`);
    const end = 2 + aliceRef.length;
    expect(toCanonical(m, 2)).toBe(2);
    expect(toCanonical(m, 8)).toBe(end);
    expect(toCanonical(m, 4, "start")).toBe(2);
    expect(toCanonical(m, 4)).toBe(end);
    expect(toDisplay(m, end + 1)).toBe(9);
  });
});

describe("applyDisplayEdit", () => {
  it("maps plain typing around a mention", () => {
    const m = model(`${aliceRef} `);
    const edit = applyDisplayEdit(m, "@Alice hey", 10);
    expect(edit.canonical).toBe(`${aliceRef} hey`);
  });

  it("deletes the whole mention on a backspace into it", () => {
    const m = model(`hi ${aliceRef} there`);
    expect(applyDisplayEdit(m, "hi @Alic there", 8).canonical).toBe("hi  there");
  });

  it("moves an insertion inside a mention to after it", () => {
    const m = model(`${aliceRef} `);
    expect(applyDisplayEdit(m, "@Alxice ", 4).canonical).toBe(`${aliceRef} x `);
  });

  it("keeps a mention apart from bech32 characters typed flush against it", () => {
    const m = model(aliceRef);
    expect(applyDisplayEdit(m, "@Alicez", 7).canonical).toBe(`${aliceRef} z`);
  });

  it("keeps mentions that survive a replacement, as undo of a wrap does", () => {
    const m = model(`x **${aliceRef}** y`);
    expect(m.display).toBe("x **@Alice** y");
    expect(applyDisplayEdit(m, "x @Alice y").canonical).toBe(`x ${aliceRef} y`);
  });

  it("does not keep a mention for pasted text that merely spells its label", () => {
    const m = model(`x ${aliceRef} y`);
    expect(applyDisplayEdit(m, "@Alice", undefined, { keepLabels: false }).canonical).toBe("@Alice");
  });

  it("splices canonical text in at display offsets", () => {
    const m = model(`${aliceRef} @bo`);
    const edit = spliceDisplay(m, 7, 10, `${bobRef} `);
    expect(edit.canonical).toBe(`${aliceRef} ${bobRef} `);
    expect(edit.caret).toBe(edit.canonical.length);
  });
});

describe("custom emoji", () => {
  const urls = (code: string) => (code === "blob" ? "https://e.example/blob.png" : undefined);
  const emojiModel = (canonical: string) => buildDisplayModel(canonical, labels, urls);

  it("shows a known shortcode as one placeholder, and nothing else", () => {
    const m = emojiModel("a :blob: :nope: `:blob:`");
    expect(m.display).toBe(`a ${EMOJI_PLACEHOLDER} :nope: \`:blob:\``);
    expect(m.atoms).toEqual([{ emoji: { shortcode: "blob", url: "https://e.example/blob.png" }, pubkey: undefined, cStart: 2, cEnd: 8, dStart: 2, dEnd: 3 }]);
  });

  it("deletes the whole shortcode on one backspace", () => {
    const m = emojiModel("a :blob: b");
    expect(applyDisplayEdit(m, "a  b", 2).canonical).toBe("a  b");
  });

  it("orders emoji and mentions together", () => {
    const m = emojiModel(`:blob:${aliceRef} :blob:`);
    expect(m.display).toBe(`${EMOJI_PLACEHOLDER}@Alice ${EMOJI_PLACEHOLDER}`);
  });
});
