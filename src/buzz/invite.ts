/**
 * Buzz relay invites: an HTTP flow, not a Nostr event. An admin mints an HMAC'd
 * code (`POST /api/invites`); the joiner claims it with NIP-98-signed
 * `POST /api/invites/claim`, optionally after accepting a join policy
 * (`GET /api/join-policy` → `POST /api/invites/accept-policy` → receipt).
 */

import { buzzHttpPost } from "@/buzz/http";
import { normalizeRelayUrl, relayToHttpUrl } from "@/lib/platform";

import type { NostrSigner } from "@nostrify/nostrify";

export interface BuzzInvite {
  /** The tenant host (e.g. "team.communities.buzz.xyz"). */
  host: string;
  code: string;
  relayUrl: string;
  origin: string;
}

/** `relay` may be a bare host or a full ws(s)/http(s) URL. */
export function buzzInviteFromRelay(code: string, relay: string): BuzzInvite | undefined {
  const asWs = /^wss?:\/\//i.test(relay)
    ? relay
    : /^https?:\/\//i.test(relay)
      ? relay.replace(/^http/i, "ws")
      : `wss://${relay}`;
  const relayUrl = normalizeRelayUrl(asWs);
  if (!relayUrl) return undefined;
  const http = new URL(relayToHttpUrl(relayUrl));
  return { host: http.host, code, relayUrl, origin: http.origin };
}

/**
 * Invite URL on the Armada host (a verified App Links domain, so it opens the
 * app). `?r=` carries the relay host, which the code doesn't encode.
 */
export function buildBuzzInviteUrl(base: string, relayUrl: string, code: string): string {
  const host = new URL(relayToHttpUrl(relayUrl)).host;
  const b = base.replace(/\/$/, "");
  return `${b}/invite/${encodeURIComponent(code)}?r=${encodeURIComponent(host)}`;
}

/**
 * Parse `https://<host>/invite/<code>`. The code is opaque (Buzz: dotted HMAC;
 * newlay: hex); only a bech32 naddr (a Concord invite) is rejected. `?r=` names
 * the relay; legacy relay-hosted links have none and the host IS the relay.
 */
export function parseBuzzInviteUrl(input: string): BuzzInvite | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const match = url.pathname.match(/^\/invite\/([^/]+)$/);
  if (!match) return undefined;
  const code = decodeURIComponent(match[1]);
  if (/^naddr1[023456789acdefghjklmnpqrstuvwxyz]+$/i.test(code)) return undefined;
  const relayParam = url.searchParams.get("r")?.trim();
  if (relayParam) return buzzInviteFromRelay(code, relayParam);
  const scheme = url.protocol === "https:" ? "wss" : "ws";
  const relayUrl = normalizeRelayUrl(`${scheme}://${url.host}`);
  if (!relayUrl) return undefined;
  return { host: url.host, code, relayUrl, origin: url.origin };
}

/** Cheap boolean sibling of `parseBuzzInviteUrl`. */
export function isBuzzInviteUrl(input: string): boolean {
  return parseBuzzInviteUrl(input) !== undefined;
}

export interface BuzzJoinPolicy {
  termsMarkdown?: string;
  privacyMarkdown?: string;
  ageAttestationRequired: boolean;
  version: string;
}

/** Fetch the relay's join policy, if the operator configured one. */
export async function fetchBuzzJoinPolicy(origin: string, signal?: AbortSignal): Promise<BuzzJoinPolicy | undefined> {
  const res = await fetch(`${origin}/api/join-policy`, {
    signal: signal ?? AbortSignal.timeout(8000),
  });
  if (!res.ok) return undefined;
  const json = (await res.json()) as {
    policy?: {
      terms_markdown?: string;
      privacy_markdown?: string;
      age_attestation_required?: boolean;
      version?: string;
    };
  };
  const policy = json.policy;
  if (!policy || typeof policy.version !== "string") return undefined;
  return {
    termsMarkdown: policy.terms_markdown,
    privacyMarkdown: policy.privacy_markdown,
    ageAttestationRequired: Boolean(policy.age_attestation_required),
    version: policy.version,
  };
}

/**
 * Accept the join policy if configured (for a code-bound receipt), then claim
 * membership with the NIP-98-signed joining key.
 */
export async function claimBuzzInvite(
  signer: NostrSigner,
  invite: BuzzInvite,
  opts?: { policy?: BuzzJoinPolicy; ageConfirmed?: boolean },
): Promise<void> {
  let policyReceipt: string | undefined;
  if (opts?.policy) {
    const res = await fetch(`${invite.origin}/api/invites/accept-policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: invite.code,
        policy_version: opts.policy.version,
        age_confirmed: Boolean(opts.ageConfirmed),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error("The server rejected the policy acceptance.");
    const json = (await res.json()) as { receipt?: string };
    policyReceipt = json.receipt;
  }
  await buzzHttpPost(signer, `${invite.origin}/api/invites/claim`, {
    code: invite.code,
    ...(policyReceipt ? { policy_receipt: policyReceipt } : {}),
  });
}
