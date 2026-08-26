/**
 * Scryfall card-image URLs for NIP magic-deck events (kind 37381).
 *
 * Scryfall is the de-facto Magic: The Gathering card database, with open CORS
 * and a `format=image` redirect endpoint whose URL can be used directly as an
 * `<img src>`. A deck's `c`/`b` card tags carry `set`+`collector-number`
 * (an exact printing) or, failing that, an exact card name. See
 * https://scryfall.com/docs/api for the full API.
 */

/** Version of image to request from the `format=image` Scryfall endpoint. */
export type ScryfallImageVersion = "small" | "normal" | "large" | "png" | "art_crop" | "border_crop";

/** Reference to a card by its Scryfall-native identifiers. */
export interface CardRef {
  /** Set code, e.g. "neo". Case-insensitive. */
  setId?: string;
  /** Collector number, e.g. "42". */
  artId?: string;
  /** Exact card name, used when setId/artId is unavailable. */
  name?: string;
}

/**
 * Build a Scryfall image URL for a card. Prefers `set + collector_number` for
 * the exact printing, falling back to `named?exact=` when only a name is known.
 */
export function scryfallImageUrl(card: CardRef, version: ScryfallImageVersion = "normal"): string {
  if (card.setId && card.artId) {
    return `https://api.scryfall.com/cards/${encodeURIComponent(card.setId.toLowerCase())}/${encodeURIComponent(card.artId)}?format=image&version=${version}`;
  }
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name ?? "")}&format=image&version=${version}`;
}
