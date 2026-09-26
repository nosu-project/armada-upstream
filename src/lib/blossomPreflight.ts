/**
 * BUD-06 upload requirements: `HEAD /upload` with the blob's size and type
 * lets a Blossom server say whether it will take a file BEFORE the client has
 * transcoded, encrypted and sent it. The server is the one place an upload
 * size policy lives; this only asks it early.
 *
 * Deliberately unauthenticated: signing a preflight would put a signer prompt
 * in front of every attachment on extension and bunker logins, for a question
 * most servers answer without auth. A server that wants auth (401) is simply
 * "unknown", and the real upload settles it.
 */

/** What a server said about a prospective upload. */
export type PreflightVerdict =
  | { kind: "accepted" }
  | { kind: "refused"; status: number; reason?: string }
  /** No usable answer: no BUD-06, auth wanted, network error, timeout. */
  | { kind: "unknown" };

export interface PreflightRequest {
  size: number;
  type?: string;
  /** Hex SHA-256, when already known. Omitted rather than computed for this. */
  sha256?: string;
}

/**
 * Statuses that are an answer about THIS blob rather than about the request:
 * too large, unsupported type, payment required. Anything else — including a
 * 400 from a server that insists on `X-SHA-256` we didn't send — says nothing
 * about whether the upload would be taken.
 */
const REFUSAL_STATUSES = new Set([402, 413, 415]);

const PREFLIGHT_TIMEOUT_MS = 5_000;

export async function preflightUpload(
  server: string,
  req: PreflightRequest,
  opts: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<PreflightVerdict> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = { "X-Content-Length": String(req.size) };
  if (req.type) headers["X-Content-Type"] = req.type;
  if (req.sha256) headers["X-SHA-256"] = req.sha256;
  try {
    const timeout = AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS);
    const response = await doFetch(new URL("/upload", server), {
      method: "HEAD",
      headers,
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (response.ok) return { kind: "accepted" };
    if (REFUSAL_STATUSES.has(response.status)) {
      return { kind: "refused", status: response.status, reason: response.headers.get("x-reason") ?? undefined };
    }
    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * Ask every server. The upload goes to all of them at once and succeeds on
 * the first to take it, so it is doomed only when EVERY server refuses —
 * then the first refusal's reason is returned. Otherwise undefined.
 */
export async function preflightRefusal(
  servers: string[],
  req: PreflightRequest,
  opts: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<{ status: number; reason?: string } | undefined> {
  if (servers.length === 0) return undefined;
  const verdicts = await Promise.all(servers.map((s) => preflightUpload(s, req, opts)));
  const refusals = verdicts.filter((v): v is Extract<PreflightVerdict, { kind: "refused" }> => v.kind === "refused");
  if (refusals.length !== servers.length) return undefined;
  return { status: refusals[0].status, reason: refusals.find((r) => r.reason)?.reason };
}

/** Human wording for a refusal whose server gave no reason. */
export function describeRefusal(refusal: { status: number; reason?: string }): string {
  if (refusal.reason) return refusal.reason;
  switch (refusal.status) {
    case 413: return "The file is larger than your media servers accept.";
    case 415: return "Your media servers don't accept this type of file.";
    case 402: return "Your media servers require payment for this upload.";
    default: return "Your media servers refused this file.";
  }
}

/**
 * The server's own words from a failed upload. `BlossomUploader.upload` races
 * every server with `Promise.any`, so a total failure is an `AggregateError`
 * whose message says nothing; the per-server errors carry
 * `Blossom request failed (<status>): <X-Reason or body>`.
 */
export function uploadFailureReason(error: unknown): string | undefined {
  const errors = error instanceof AggregateError ? error.errors : [error];
  for (const e of errors) {
    const message = e instanceof Error ? e.message : undefined;
    const match = message?.match(/^Blossom request failed \((\d+)\): ([\s\S]*)$/);
    if (!match) continue;
    const reason = match[2].trim();
    // A body can be an HTML error page; only a short plain line is worth showing.
    if (reason && reason.length <= 200 && !reason.startsWith("<")) return reason;
    return describeRefusal({ status: Number(match[1]) });
  }
  return undefined;
}

/**
 * How long one PUT may run. A flat per-request timeout caps the upload SIZE by
 * the uplink speed — 30 s killed any file much past a few MB on mobile data —
 * so allow a floor plus time for the bytes at a slow-but-working rate.
 */
export function uploadTimeoutMs(size: number): number {
  const FLOOR_MS = 30_000;
  const SLOW_BYTES_PER_SECOND = 50 * 1024;
  return FLOOR_MS + Math.ceil((size / SLOW_BYTES_PER_SECOND) * 1000);
}
