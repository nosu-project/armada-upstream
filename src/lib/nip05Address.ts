/** A NIP-05 address, canonicalized: a bare `domain` is the root user `_@domain`. */
export interface Nip05Address {
  /** Local part. `_` for a bare domain. */
  name: string;
  domain: string;
  /** Canonical `name@domain` — the form the well-known lookup is keyed by. */
  address: string;
  /** How to show it: the domain alone when the name is `_`. */
  display: string;
}

/** NIP-05 local part: the characters the spec allows in a `names` key. */
const NAME_RE = /^[a-z0-9\-_.]+$/i;
/**
 * Hostname with at least one dot — the dot keeps unrouted single-segment paths
 * (`settings`) from becoming NIP-05 lookups.
 */
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** Parse `name@domain`, bare `domain` (→ `_@domain`), or `@name@domain`; undefined otherwise. */
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
