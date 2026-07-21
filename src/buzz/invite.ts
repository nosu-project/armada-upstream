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
import { normalizeRelayUrl } from "@/lib/platform";

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
 * Parse a Buzz invite landing URL (`https://<host>/invite/<code>`). Returns
 * undefined for anything else — including Armada's own `/invite/<naddr>`
 * Concord links, whose path segment is bech32 (`naddr1…`); Buzz codes are
 * dot-separated base64url HMAC tokens, so the shapes never collide.
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
  // A Concord V2 invite path segment is an naddr; a Buzz code contains a `.`
  // (HMAC token separator) and is never bech32.
  if (/^naddr1[023456789acdefghjklmnpqrstuvwxyz]+$/i.test(code)) return undefined;
  if (!code.includes(".")) return undefined;
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
