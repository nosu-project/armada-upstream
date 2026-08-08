/**
 * Buzz relay invites.
 *
 * A Buzz invite is an HTTP flow, not a Nostr event: an owner/admin mints a
 * stateless HMAC'd code (`POST /api/invites`) shared as a landing-page URL
 * `https://<host>/invite/<code>`; the joiner claims it with a NIP-98-signed
 * `POST /api/invites/claim` (deliberately exempt from the relay-membership
 * gate). Deployments may additionally require accepting a join policy first
 * (`GET /api/join-policy` → `POST /api/invites/accept-policy` → receipt).
 */

import { buzzHttpPost } from "@/buzz/http";
import { normalizeRelayUrl, relayToHttpUrl } from "@/lib/platform";

import type { NostrSigner } from "@nostrify/nostrify";

export interface BuzzInvite {
  /** The tenant host (e.g. "team.communities.buzz.xyz"). */
  host: string;
  /** The invite code (opaque token from the URL path). */
  code: string;
  /** The relay websocket URL for this host. */
  relayUrl: string;
  /** The https origin for the host's API endpoints. */
  origin: string;
}

/**
 * Build a BuzzInvite from a code + the relay it lives on. `relay` may be a
 * bare host (`team.communities.buzz.xyz`) or a full ws(s)/http(s) URL.
 */
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
 * Build a shareable Buzz invite URL on `base` — the Armada host (armada.buzz),
 * which is the app's verified App Links domain, so the link opens directly in
 * the app instead of the relay's own web page. The relay host rides along in
 * `?r=` because the code itself doesn't encode it; the claim needs it to find
 * the relay.
 */
export function buildBuzzInviteUrl(base: string, relayUrl: string, code: string): string {
  const host = new URL(relayToHttpUrl(relayUrl)).host;
  const b = base.replace(/\/$/, "");
  return `${b}/invite/${encodeURIComponent(code)}?r=${encodeURIComponent(host)}`;
}

/**
 * Parse a Buzz invite landing URL (`https://<host>/invite/<code>`). Returns
 * undefined for anything else — including Armada's own `/invite/<naddr>`
 * Concord links, whose path segment is bech32 (`naddr1…`); Buzz codes are
 * dot-separated base64url HMAC tokens, so the shapes never collide.
 *
 * An Armada-hosted link (`https://armada.buzz/invite/<code>?r=<relay-host>`)
 * carries the true relay in `?r=` — its own host is only a deep-link façade.
 * A legacy relay-hosted link has no `?r=`; the landing host IS the relay.
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
  // A Concord invite path segment is an naddr; a Buzz code contains a `.`
  // (HMAC token separator) and is never bech32.
  if (/^naddr1[023456789acdefghjklmnpqrstuvwxyz]+$/i.test(code)) return undefined;
  if (!code.includes(".")) return undefined;
  const relayParam = url.searchParams.get("r")?.trim();
  if (relayParam) return buzzInviteFromRelay(code, relayParam);
  const scheme = url.protocol === "https:" ? "wss" : "ws";
  const relayUrl = normalizeRelayUrl(`${scheme}://${url.host}`);
  if (!relayUrl) return undefined;
  return { host: url.host, code, relayUrl, origin: url.origin };
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
 * Claim a Buzz invite for the signed-in user: accept the join policy first
 * when one is configured (exchanging acceptance for a code-bound receipt),
 * then claim relay membership with the NIP-98-signed joining key.
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
