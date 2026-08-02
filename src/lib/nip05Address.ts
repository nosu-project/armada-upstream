/**
 * A NIP-05 address, split and canonicalized.
 *
 * `mk@ditto.pub` and `ditto.pub` name the same person: NIP-05 calls a domain's
 * root user `_`, and clients show `_@domain` as the bare domain. Both spellings
 * are things people say out loud and write in a URL, so both arrive here and
 * both have to land on one lookup.
 */
export interface Nip05Address {
  /** Local part. `_` for a bare domain. */
  name: string;
  /** Lowercased domain. */
  domain: string;
  /** Canonical `name@domain` — the form the well-known lookup is keyed by. */
  address: string;
  /** How to show it: the domain alone when the name is `_`. */
  display: string;
}

/** NIP-05 local part: the characters the spec allows in a `names` key. */
const NAME_RE = /^[a-z0-9\-_.]+$/i;
/**
 * A hostname with at least one dot. The dot is what makes this safe to run
 * against a bare path segment: it's the only thing separating `ditto.pub` from
 * `settings`, and without it every unrouted single-segment path would become a
 * NIP-05 lookup instead of a 404.
 */
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/**
 * Parse a user-supplied string as a NIP-05 address, or return undefined if it
 * isn't shaped like one. Accepts `name@domain`, a bare `domain` (expanded to
 * `_@domain`), and a leading `@` (how people write handles: `@mk@ditto.pub`).
 */
export function parseNip05Address(input: string): Nip05Address | undefined {
  const value = input.trim().replace(/^@/, "");
  if (!value) return undefined;

  const at = value.indexOf("@");
  const name = at === -1 ? "_" : value.slice(0, at);
  const rawDomain = at === -1 ? value : value.slice(at + 1);
  if (!NAME_RE.test(name) || !DOMAIN_RE.test(rawDomain)) return undefined;

  const domain = rawDomain.toLowerCase();
  return {
    name,
    domain,
    address: `${name}@${domain}`,
    display: name === "_" ? domain : `${name}@${domain}`,
  };
}
