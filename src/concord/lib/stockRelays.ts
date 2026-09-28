/**
 * The CORD-05 stock relay dictionary. A leaf module (re-exported by `invite.ts`)
 * so config and the landing page avoid the codec's crypto deps.
 */

/**
 * Stock relay dictionary, generation 4, referenced by a single byte. Versioned;
 * Vector and Soapbox ship it identically.
 */
export const RELAY_DICTIONARY: Record<number, string> = {
  1: "wss://jskitty.com/nostr",
  2: "wss://asia.vectorapp.io/nostr",
  3: "wss://relay.ditto.pub",
  4: "wss://relay.dreamith.to",
};

/** The stock set selected by the flags bit (dictionary ids 1–4, in order). */
export const STOCK_RELAYS: string[] = [1, 2, 3, 4].map((i) => RELAY_DICTIONARY[i]);
