/**
 * Buzz HTTP bridge auth: NIP-98 signed requests.
 *
 * Buzz relays expose HTTP endpoints (invite claim/mint, /query, /events)
 * authenticated with NIP-98 — a kind-27235 event carrying the request URL,
 * method, and (for bodies) a `payload` tag with the body's SHA-256, base64'd
 * into an `Authorization: Nostr …` header.
 */

import type { NostrSigner } from "@nostrify/nostrify";

/** SHA-256 of a UTF-8 string, hex-encoded. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build the `Authorization: Nostr <base64>` header value for a request. */
export async function nip98AuthHeader(
  signer: NostrSigner,
  url: string,
  method: string,
  body?: string,
): Promise<string> {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];
  if (body !== undefined) tags.push(["payload", await sha256Hex(body)]);
  const event = await signer.signEvent({
    kind: 27235,
    content: "",
    tags,
    created_at: Math.floor(Date.now() / 1000),
  });
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

/** POST JSON to a Buzz relay HTTP endpoint with NIP-98 auth. */
export async function buzzHttpPost<T>(
  signer: NostrSigner,
  url: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const body = JSON.stringify(payload);
  const auth = await nip98AuthHeader(signer, url, "POST", body);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
    },
    body,
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const message =
      (json as { error?: string; message?: string }).error ??
      (json as { error?: string; message?: string }).message ??
      `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json as T;
}
