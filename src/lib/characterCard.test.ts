import { afterEach, describe, expect, it, vi } from "vitest";

import {
  characterCardFromPngBytes,
  clearCharacterCardCache,
  isCharacterCardCandidate,
  parseCharacterCardJson,
  sniffCharacterCard,
} from "@/lib/characterCard";

const encoder = new TextEncoder();

/** The sniffer's contract is bytes, so tests build real PNG framing (CRCs are left zeroed — readers must not consult them). */
function pngOf(chunks: Array<{ type: string; data: Uint8Array }>): Uint8Array {
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const { type, data } of chunks) {
    parts.push(
      (data.length >>> 24) & 0xff,
      (data.length >>> 16) & 0xff,
      (data.length >>> 8) & 0xff,
      data.length & 0xff,
    );
    for (let i = 0; i < 4; i++) parts.push(type.charCodeAt(i));
    for (const byte of data) parts.push(byte);
    parts.push(0, 0, 0, 0);
  }
  return new Uint8Array(parts);
}

function textChunk(keyword: string, payload: string): { type: string; data: Uint8Array } {
  const keywordBytes = encoder.encode(keyword);
  const payloadBytes = encoder.encode(payload);
  const data = new Uint8Array(keywordBytes.length + 1 + payloadBytes.length);
  data.set(keywordBytes, 0);
  data.set(payloadBytes, keywordBytes.length + 1);
  return { type: "tEXt", data };
}

/** Base64 of UTF-8, as card writers emit it. */
function b64(value: unknown): string {
  return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value))));
}

const V2_CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Nail",
    description: "A Redscale Kobold refugee.",
    personality: "lawful neutral",
    scenario: "The Tinder Depths",
    first_mes: "*Nail looks up at you warily.*",
    mes_example: "<START>\n{{user}}: Hello\n{{char}}: …",
    creator_notes: "Made for testing",
    system_prompt: "Stay in character.",
    post_history_instructions: "Write one paragraph.",
    alternate_greetings: ["*Nail hisses softly.*"],
    tags: ["fantasy", "kobold"],
    creator: "tester",
    character_version: "1.0",
    extensions: { koboldai: { note: true } },
  },
};

describe("parseCharacterCardJson", () => {
  it("normalizes a V2 card to its data, keeping the spec revision", () => {
    const card = parseCharacterCardJson(V2_CARD);
    expect(card).not.toBeNull();
    expect(card!.spec).toBe("v2");
    expect(card!.name).toBe("Nail");
    expect(card!.alternate_greetings).toEqual(["*Nail hisses softly.*"]);
    expect(card!.tags).toEqual(["fantasy", "kobold"]);
    expect(card!.creator).toBe("tester");
    expect(card!.character_version).toBe("1.0");
  });

  it("reads a V3 card, which shares the V2 layout", () => {
    const card = parseCharacterCardJson({ ...V2_CARD, spec: "chara_card_v3" });
    expect(card!.spec).toBe("v3");
    expect(card!.name).toBe("Nail");
  });

  it("reads a flat V1 card", () => {
    const card = parseCharacterCardJson({
      name: "Nail",
      description: "A Redscale Kobold refugee.",
      first_mes: "*hiss*",
    });
    expect(card).not.toBeNull();
    expect(card!.spec).toBe("v1");
    expect(card!.name).toBe("Nail");
    expect(card!.alternate_greetings).toEqual([]);
  });

  it("normalizes character book entries, content required", () => {
    const card = parseCharacterCardJson({
      ...V2_CARD,
      data: {
        ...V2_CARD.data,
        character_book: {
          name: "Lore",
          entries: [
            { keys: ["drake"], content: "Drakes are small dragons.", comment: "Species" },
            { keys: "not-an-array", content: "Kept, keys normalized." },
            { keys: ["missing content"] },
          ],
        },
      },
    });
    expect(card!.character_book?.name).toBe("Lore");
    expect(card!.character_book?.entries).toHaveLength(2);
    expect(card!.character_book?.entries[0]).toMatchObject({
      keys: ["drake"],
      name: "Species",
      enabled: true,
    });
    expect(card!.character_book?.entries[1].keys).toEqual([]);
  });

  it("rejects non-objects, missing names, and V2 markers without data", () => {
    expect(parseCharacterCardJson(null)).toBeNull();
    expect(parseCharacterCardJson("nope")).toBeNull();
    expect(parseCharacterCardJson({ spec: "chara_card_v2" })).toBeNull();
    expect(parseCharacterCardJson({ spec: "chara_card_v2", data: {} })).toBeNull();
    // A bare {name} JSON is not a V1 card.
    expect(parseCharacterCardJson({ name: "Nail" })).toBeNull();
    expect(parseCharacterCardJson({ name: "Nail", unrelated: 42 })).toBeNull();
  });

  it("rejects V2 data whose name is blank or mistyped", () => {
    expect(parseCharacterCardJson({ spec: "chara_card_v2", data: { name: "  " } })).toBeNull();
    expect(parseCharacterCardJson({ spec: "chara_card_v2", data: { name: 7 } })).toBeNull();
  });
});

describe("characterCardFromPngBytes", () => {
  const ihdr = { type: "IHDR", data: new Uint8Array(13) };
  const iend = { type: "IEND", data: new Uint8Array(0) };

  it("extracts a card from the `chara` tEXt chunk", () => {
    const png = pngOf([ihdr, textChunk("chara", b64(V2_CARD)), iend]);
    const card = characterCardFromPngBytes(png);
    expect(card).not.toBeNull();
    expect(card!.spec).toBe("v2");
    expect(card!.name).toBe("Nail");
    expect(card!.description).toBe("A Redscale Kobold refugee.");
  });

  it("extracts a V3 card from the `ccv3` chunk", () => {
    const png = pngOf([textChunk("ccv3", b64({ ...V2_CARD, spec: "chara_card_v3" })), iend]);
    const card = characterCardFromPngBytes(png);
    expect(card!.spec).toBe("v3");
  });

  it("prefers the `ccv3` payload over the `chara` copy a V3 writer keeps for older readers", () => {
    const v3 = { ...V2_CARD, spec: "chara_card_v3", data: { ...V2_CARD.data, name: "Nail v3" } };
    const png = pngOf([ihdr, textChunk("chara", b64(V2_CARD)), textChunk("ccv3", b64(v3)), iend]);
    const card = characterCardFromPngBytes(png);
    expect(card!.spec).toBe("v3");
    expect(card!.name).toBe("Nail v3");
  });

  it("decodes UTF-8 names through the base64 layer", () => {
    const png = pngOf([textChunk("chara", b64({ name: "Séréna 🐉", description: "Accentué" })), iend]);
    const card = characterCardFromPngBytes(png);
    expect(card!.name).toBe("Séréna 🐉");
    expect(card!.spec).toBe("v1");
  });

  it("skips sibling keywords, including `chara_ext-asset`, until a card parses", () => {
    const png = pngOf([
      textChunk("chara_ext-asset:user", b64({ not: "a card" })),
      textChunk("Software", btoa("made with an editor")),
      textChunk("chara", "%%%not base64%%%"),
      textChunk("chara", b64(V2_CARD)),
      iend,
    ]);
    const card = characterCardFromPngBytes(png);
    expect(card).not.toBeNull();
    expect(card!.name).toBe("Nail");
  });

  it("returns null for non-PNG bytes and for PNGs without a card chunk", () => {
    expect(characterCardFromPngBytes(new Uint8Array(0))).toBeNull();
    expect(characterCardFromPngBytes(encoder.encode("not a png at all"))).toBeNull();
    expect(characterCardFromPngBytes(pngOf([ihdr, iend]))).toBeNull();
    expect(characterCardFromPngBytes(pngOf([textChunk("Description", btoa("some note")), iend]))).toBeNull();
  });

  it("stops the walk at truncated framing instead of throwing", () => {
    const png = pngOf([ihdr, textChunk("chara", b64(V2_CARD)), iend]);
    // Cut mid-card-payload: readers must not read past the buffer.
    expect(characterCardFromPngBytes(png.slice(0, 40))).toBeNull();
  });
});

describe("isCharacterCardCandidate", () => {
  it("accepts PNGs by extension or declared MIME", () => {
    expect(isCharacterCardCandidate("https://x.example/nail.png")).toBe(true);
    expect(isCharacterCardCandidate("https://x.example/a.png?si=1#y")).toBe(true);
    expect(isCharacterCardCandidate("https://x.example/abc123", "image/png")).toBe(true);
  });

  it("lets an extension-less encrypted blob through when the MIME is opaque", () => {
    expect(isCharacterCardCandidate("https://x.example/abc123.png", "application/octet-stream")).toBe(true);
    expect(isCharacterCardCandidate("https://x.example/abc123", "application/octet-stream")).toBe(false);
  });

  it("rejects other images and files", () => {
    expect(isCharacterCardCandidate("https://x.example/pic.jpg")).toBe(false);
    expect(isCharacterCardCandidate("https://x.example/pic.png", "image/jpeg")).toBe(false);
    expect(isCharacterCardCandidate("https://x.example/pic.pngx")).toBe(false);
  });
});

describe("sniffCharacterCard", () => {
  const card = pngOf([textChunk("chara", b64(V2_CARD)), { type: "IEND", data: new Uint8Array(0) }]);
  const ok = () => new Response(card.slice().buffer);

  afterEach(() => {
    vi.unstubAllGlobals();
    clearCharacterCardCache();
  });

  it("retries an attachment whose fetch failed rather than remembering it as no card", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    const ref = { url: "https://x.example/retry.png" };
    expect(await sniffCharacterCard(ref, [ref.url])).toBeNull();
    expect((await sniffCharacterCard(ref, [ref.url]))?.name).toBe("Nail");
  });

  it("forgets every sniffed card on clear", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const ref = { url: "https://x.example/clear.png" };
    await sniffCharacterCard(ref, [ref.url]);
    await sniffCharacterCard(ref, [ref.url]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearCharacterCardCache();
    await sniffCharacterCard(ref, [ref.url]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
