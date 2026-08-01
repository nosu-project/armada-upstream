/**
 * Which tenant an incoming relay event belongs in — `main`, or a tenant of its
 * own for the relay that served it.
 *
 * ============================================================================
 * WHY NIP-29 CANNOT SHARE `main`
 * ============================================================================
 *
 * A NIP-29 group is named by an `h`/`d` tag value like `abc123`, and that name
 * means nothing on its own: the SAME id on two relays is two unrelated groups.
 * The identity of the group is the PAIR (relay, id). So a store keyed only by
 * the event's own contents cannot answer "the messages in this group" — it can
 * only answer "the messages in every group anywhere that happens to be spelled
 * this way", and a query for one server's channel silently returns another's.
 *
 * The obvious patch is to scope by the signing key, since group state (39000+)
 * is relay-signed. It does not hold: some relay software (zooid, which backs
 * Flotilla/Soapbox) ships a SHARED relay identity, so two different servers
 * advertise the same NIP-11 `self`. Author-scoping then cannot tell them apart
 * either, and one server's channels appear in another's directory as phantom
 * rooms that vanish when opened. Worse, 39000 is addressable: same kind, same
 * pubkey, same `d` from two relays is ONE row by NIP-01 replacement rules, so
 * the two servers' metadata overwrite each other rather than merely mixing.
 *
 * The only thing that distinguishes them is WHERE THE EVENT WAS SERVED FROM,
 * which is not in the event. It was previously reconstructed by a KV side-table
 * recording (relay, day, event id) triples for the directory alone, with a
 * retention sweep to stop it growing as groups × edits × relays forever. This
 * module replaces that with the scope itself: the relay is in the TENANT ID, so
 * a query against one relay's tenant cannot see another's rows, there is no
 * side-table to keep in step with the events, and dropping a server is dropping
 * a tenant.
 *
 * ============================================================================
 * THE RULE
 * ============================================================================
 *
 * Relay-relative, therefore relay-scoped:
 *
 *  - **anything carrying an `h` tag.** `h` is NIP-29's group marker, so this is
 *    the protocol's own statement that the event is meaningful only inside one
 *    group on one relay: chat and polls, threads and comments, reactions,
 *    webxdc updates, the whole 9000-9022 moderation range, group-scoped NIP-52
 *    calendar entries, and the kind-5 deletes moderators issue inside a group.
 *    Derived from the event rather than listed as kinds, so a group-scoped kind
 *    added later is scoped correctly without this file changing.
 *  - **relay-signed relay/group state** ({@link RELAY_STATE_KINDS}). These carry
 *    no `h` — their scope is a `d` group id, or for kind 13534 the relay itself
 *    — and they are exactly the events the shared-identity problem above breaks.
 *
 * Everything else stays in `main`, and the distinction is deliberate: `main`
 * holds what is true regardless of who served it. Profiles, the user's own
 * kind-10009 group list, NIP-32 self-labels, git activity, sealed Concord
 * outers and NIP-04 ciphertext are global facts about a pubkey, and relay-
 * scoping them would fork one identity into N copies — a profile learned on
 * relay A invisible while reading relay B. Scope by what the data IS, never by
 * which socket happened to deliver it.
 *
 * ============================================================================
 * NO RELAY, NO STORE
 * ============================================================================
 *
 * A relay-relative event whose source relay is unknown is DROPPED rather than
 * filed under a guess. Provenance genuinely isn't always known: a pool-wide
 * `.query()` fans out to every relay in the routing set (joined NIP-29 servers
 * included), and a `group(urls)` read has N candidates for one event. Writing
 * those to `main`, or to all N tenants, is the collision this module exists to
 * remove — and the loss is nil in practice, because every NIP-29 read path goes
 * through `nostr.relay(url)` and therefore knows its relay. A dropped cache
 * write never affects what a query RETURNS; it only means no offline copy, of
 * an event refetchable from the one relay that has it.
 */
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Relay-signed state whose scope is the relay itself, not an `h` tag:
 * 39000 metadata, 39001 admins, 39002 members, 39003 roles, 39004 live
 * participants, 39005 pins, and 13534's relay-wide NIP-43 roster.
 */
export const RELAY_STATE_KINDS = [13534, 39000, 39001, 39002, 39003, 39004, 39005];

const RELAY_STATE = new Set(RELAY_STATE_KINDS);

/**
 * Whether this event's identity depends on the relay that served it, and so
 * belongs in that relay's tenant rather than in `main`.
 */
export function isRelayScoped(event: { kind: number; tags: string[][] }): boolean {
  if (RELAY_STATE.has(event.kind)) return true;
  return event.tags.some((tag) => tag[0] === "h" && typeof tag[1] === "string" && tag[1] !== "");
}

/**
 * The tenant holding one relay's NIP-29 data, or `undefined` for a URL that
 * isn't a usable relay address.
 *
 * Normalized so the tenant is the same one however the URL reached us — a
 * trailing slash or a mixed-case host must not fork a channel's history into
 * two tenants, since the id is the only thing keeping the scopes apart.
 */
export function nip29Tenant(relayUrl: string): string | undefined {
  const normalized = normalizeRelayUrl(relayUrl);
  return normalized ? `nip29:${normalized}` : undefined;
}

/** Every `nip29:` tenant id among `ids` (the purge and the migration walk these). */
export function nip29Tenants(ids: string[]): string[] {
  return ids.filter((id) => id.startsWith("nip29:"));
}

/**
 * The tenant an event belongs in, or `undefined` to not store it at all.
 *
 * `main` for the global cache; a relay tenant for relay-relative data; nothing
 * when relay-relative data arrives with no usable relay (see the header).
 */
export function tenantForEvent(
  event: NostrRumor | { kind: number; tags: string[][] },
  relayUrl: string | undefined,
  mainTenant: string,
): string | undefined {
  if (!isRelayScoped(event)) return mainTenant;
  return relayUrl ? nip29Tenant(relayUrl) : undefined;
}
