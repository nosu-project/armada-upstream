/**
 * Scryfall card-image URLs for magic-deck events (kind 37381). Deck `c`/`b` tags
 * carry set + collector number or an exact name. https://scryfall.com/docs/api
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
