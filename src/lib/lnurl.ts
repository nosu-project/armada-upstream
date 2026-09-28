/**
 * LNURL-pay (LUD-06/LUD-16) resolution and invoice fetching. Hand-rolled rather
 * than nostr-tools' `getZapEndpoint` because CORD.md private zaps must fetch an
 * invoice WITHOUT `nostr`, whose presence makes providers publish a kind-9735 receipt.
 */

import { bech32 } from "@scure/base";

export interface LnurlPayParams {
  callback: string;
  /** millisats */
  minSendable: number;
  /** millisats */
  maxSendable: number;
  /** Max comment length the provider forwards; 0/absent = no comments. */
  commentAllowed: number;
  /** Provider supports NIP-57 zap requests (public receipts). */
  allowsNostr: boolean;
}

/** https only (as LUD-06 requires), so profile fields can't probe intranet hosts over http. */
function httpsOnly(url: string): string | null {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** lud16 `name@domain` → LNURL-pay metadata URL. */
function lud16Url(address: string): string | null {
  const match = address.trim().match(/^([\w.+-]+)@([\w.-]+)$/);
  if (!match) return null;
  const [, name, domain] = match;
  return `https://${domain}/.well-known/lnurlp/${name.toLowerCase()}`;
}

/** lud06 bech32 `lnurl1…` → its embedded URL (https only). */
function lud06Url(lnurl: string): string | null {
  try {
    const { words } = bech32.decode(lnurl.trim().toLowerCase() as `${string}1${string}`, 20000);
    return httpsOnly(new TextDecoder().decode(bech32.fromWords(words)));
  } catch {
    return null;
  }
}

/** Resolve LNURL-pay params from kind-0 lightning fields. Throws a user-facing message on failure. */
export async function resolveLnurlPay(
  metadata: { lud16?: string; lud06?: string },
  fetchFn: typeof fetch = fetch,
): Promise<LnurlPayParams> {
  const url = (metadata.lud16 && lud16Url(metadata.lud16)) || (metadata.lud06 && lud06Url(metadata.lud06));
  if (!url) throw new Error("Recipient has no lightning address.");

  let data: Record<string, unknown>;
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    data = await response.json();
  } catch {
    throw new Error("Couldn't reach the recipient's lightning wallet service.");
  }
  if (data.status === "ERROR") {
    throw new Error(typeof data.reason === "string" ? data.reason : "Lightning wallet service error.");
  }
  if (data.tag !== "payRequest" || typeof data.callback !== "string" || !httpsOnly(data.callback)) {
    throw new Error("Recipient's lightning address doesn't accept payments.");
  }
  return {
    callback: data.callback,
    minSendable: typeof data.minSendable === "number" ? data.minSendable : 1000,
    maxSendable: typeof data.maxSendable === "number" ? data.maxSendable : Number.MAX_SAFE_INTEGER,
    commentAllowed: typeof data.commentAllowed === "number" ? data.commentAllowed : 0,
    allowsNostr: data.allowsNostr === true && typeof data.nostrPubkey === "string",
  };
}

/**
 * Fetch a bolt11 invoice. `zapRequest` (signed kind-9734 JSON) makes it a
 * NIP-57 zap with a public receipt; omit it for a traceless payment (CORD.md).
 */
export async function fetchLnurlInvoice(
  params: LnurlPayParams,
  opts: { amountMsats: number; comment?: string; zapRequest?: string },
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const url = new URL(params.callback);
  url.searchParams.set("amount", String(opts.amountMsats));
  if (opts.comment && params.commentAllowed > 0) {
    url.searchParams.set("comment", opts.comment.slice(0, params.commentAllowed));
  }
  if (opts.zapRequest) url.searchParams.set("nostr", opts.zapRequest);

  let data: Record<string, unknown>;
  try {
    const response = await fetchFn(url.toString(), { signal: AbortSignal.timeout(15_000) });
    data = await response.json();
  } catch {
    throw new Error("Couldn't fetch an invoice from the recipient's wallet service.");
  }
  if (data.status === "ERROR") {
    throw new Error(typeof data.reason === "string" ? data.reason : "Invoice request rejected.");
  }
  if (typeof data.pr !== "string" || !data.pr) {
    throw new Error("The wallet service returned no invoice.");
  }
  return data.pr;
}
