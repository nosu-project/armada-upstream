import { normalizeRelayUrl } from "@/lib/platform";
import { uniqueRelayUrls } from "@/lib/nip65";

/**
 * A signup referral link (`/join?relay=wss://…`) that seeds a new account's
 * app relays. Local config only — it never publishes anything; NIP-65 is
 * written later by an explicit action.
 */
export interface JoinLink {
  relays: string[];
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

/** Parse a `/join` query into relays + name, or `null` with no usable relay. `relay` may repeat or be comma-joined. */
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

// In memory only, so a stale stash can't reconfigure a later, unrelated signup.
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
