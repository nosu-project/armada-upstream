/**
 * Concord Nostr event kinds — ported from Vector's `stored_event.rs` event_kind
 * constants (the 3300–3311 block, claimed by Vector in the regular range).
 *
 * These are the kinds an armada relay must accept (as opaque blobs) for Concord
 * to work; the relay never needs to understand them.
 */

/** Channel chat message (append plane). */
export const KIND_COMMUNITY_MESSAGE = 3300;
/** Reaction. */
export const KIND_COMMUNITY_REACTION = 3301;
/** Message edit. */
export const KIND_COMMUNITY_EDIT = 3302;
/** Rekey / epoch transition (carries per-recipient key blobs). */
export const KIND_COMMUNITY_REKEY = 3303;
/** Direct invite bundle (carried inside a NIP-17 gift wrap). */
export const KIND_COMMUNITY_INVITE_BUNDLE = 3304;
/** Cooperative delete / moderation-hide. */
export const KIND_COMMUNITY_DELETE = 3305;
/** Join/leave presence announcement. */
export const KIND_COMMUNITY_PRESENCE = 3306;
// 3307 — RETIRED, never reuse.
/** Control-plane authority edition (roster/roles/grants/banlist/metadata/owner attestation). */
export const KIND_COMMUNITY_CONTROL = 3308;
/** Cooperative kick (soft removal). */
export const KIND_COMMUNITY_KICK = 3309;
/** WebXDC realtime peer signal. */
export const KIND_COMMUNITY_WEBXDC = 3310;
/** Typing indicator (ephemeral, never persisted). */
export const KIND_COMMUNITY_TYPING = 3311;

/** NIP-78 application-specific (owner attestation, public invite bundle, lists). */
export const KIND_APPLICATION_SPECIFIC = 30078;
/** NIP-59 gift wrap (carries the direct invite). */
export const KIND_GIFT_WRAP = 1059;

/** Every Concord kind a relay should allow-list for storage/forwarding. */
export const CONCORD_RELAY_KINDS: readonly number[] = [
  KIND_COMMUNITY_MESSAGE,
  KIND_COMMUNITY_REACTION,
  KIND_COMMUNITY_EDIT,
  KIND_COMMUNITY_REKEY,
  KIND_COMMUNITY_DELETE,
  KIND_COMMUNITY_PRESENCE,
  KIND_COMMUNITY_CONTROL,
  KIND_COMMUNITY_KICK,
  KIND_COMMUNITY_WEBXDC,
  KIND_COMMUNITY_TYPING,
];
