import { normalizeRelayUrl } from "@/lib/platform";
import { uniqueRelayUrls } from "@/lib/nip65";

/**
 * A signup "join" / referral link: `https://armada.buzz/join?relay=wss://op.example`
 * (also `armada://open/join?...`). An operator shares it so a brand-new account
 * is seeded to live on their relay(s) from the start — "onboard to my infra".
 *
 * The link carries only local, non-secret configuration: relay URL(s) and an
 * optional display name for the confirmation screen. It NEVER publishes anything
 * on the user's behalf (the never-auto-publish rule): accepting it seeds local
 * app-relay config, and a NIP-65 is only written later by an explicit action.
 */
export interface JoinLink {
  /** Normalized relay URLs to adopt as the new account's app/data relays. */
  relays: string[];
  /** Operator/community name to show on the confirmation screen, if provided. */
  name?: string;
}

/** Cap the relay set a single link can seed — mirrors NIP-65's small-list intent. */
const MAX_JOIN_RELAYS = 8;

/** Read a display name safely: trimmed, control-chars stripped, length-capped. */
function cleanName(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const name = raw.replace(/\p{Cc}/gu, "").trim().slice(0, 48);
  return name.length > 0 ? name : undefined;
}

/**
 * Parse the query string of a `/join` link into normalized relays + name, or
 * `null` when it names no usable relay. `relay` may repeat or be comma-joined.
 */
export function parseJoinLink(search: string): JoinLink | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }

  const raw = params.getAll("relay").flatMap((value) => value.split(","));
  const relays = uniqueRelayUrls(
    raw.map((value) => normalizeRelayUrl(value)).filter((url): url is string => Boolean(url)),
  ).slice(0, MAX_JOIN_RELAYS);
  if (relays.length === 0) return null;

  return { relays, name: cleanName(params.get("name")) };
}

/**
 * A parsed join link waiting for the signup wizard to pick it up. Held in memory
 * only: the `/join` route stashes it and hands off to the wizard within the same
 * session, and a stash that never outlives the tab can't silently reconfigure a
 * later, unrelated signup.
 */
let pending: JoinLink | undefined;

export function setPendingJoin(join: JoinLink): void {
  pending = join;
}

export function peekPendingJoin(): JoinLink | undefined {
  return pending;
}

export function clearPendingJoin(): void {
  pending = undefined;
}
