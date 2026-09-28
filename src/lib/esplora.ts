// Esplora REST failover client. Tries each configured URL in order with a
// per-attempt timeout; network errors, timeouts, 429/5xx park the URL in an
// in-memory exponential cool-down and fail over. Caller aborts propagate
// immediately without trying other endpoints.

/** Initial cool-down on first failure, in milliseconds. */
const INITIAL_COOLDOWN_MS = 30_000;

/** Maximum cool-down after repeated failures, in milliseconds. */
const MAX_COOLDOWN_MS = 300_000;

/**
 * Default Esplora roots; also the Settings "Restore defaults" target. mempool
 * mirrors come first so `/v1/prices` works without the soft-failover hop.
 */
export const DEFAULT_ESPLORA_APIS: readonly string[] = [
  'https://mempool.space/api',
  'https://mempool.emzy.de/api',
  'https://blockstream.info/api',
];

/** Per-attempt timeout; catches mempool.space's "absorb and never reply" rate-limit hangs. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** HTTP status codes that trigger failover + cool-down. */
const RETRYABLE_STATUS = new Set<number>([
  408, // Request Timeout
  425, // Too Early
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

interface EndpointState {
  /** Earliest time (ms epoch) the endpoint may be retried. */
  retryAt: number;
  /** Consecutive failure count; drives backoff length. */
  failures: number;
}

const state = new Map<string, EndpointState>();

function isAvailable(url: string, now: number): boolean {
  const s = state.get(url);
  return !s || s.retryAt <= now;
}

/** Mark an endpoint as failed, extending its cool-down with exponential backoff. */
function markFailure(url: string, now: number): void {
  const prev = state.get(url);
  const failures = (prev?.failures ?? 0) + 1;
  const backoff = Math.min(
    INITIAL_COOLDOWN_MS * 2 ** (failures - 1),
    MAX_COOLDOWN_MS,
  );
  state.set(url, { retryAt: now + backoff, failures });
}

function markSuccess(url: string): void {
  if (state.has(url)) state.delete(url);
}

function normalize(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export interface EsploraFetchOptions extends Omit<RequestInit, 'signal'> {
  /** On abort, the request is cancelled and `AbortError` propagates — no further endpoints. */
  signal?: AbortSignal;
  /** Per-attempt timeout (ms); on expiry the endpoint is marked failed. `0` disables (not recommended). */
  timeoutMs?: number;
  /**
   * Statuses meaning "endpoint doesn't support this path" (e.g. `/v1/prices` on
   * Blockstream): try the next URL without penalizing this one.
   */
  skipStatuses?: number[];
  /**
   * Extra statuses treated as retryable (failover + cool-down) for this call.
   * For always-present paths where 404 means mempool.space rate-limiting, not
   * "not found". Don't use where 404 is meaningful (e.g. `/tx/{txid}`).
   */
  retryStatuses?: number[];
}

/** Error thrown when every endpoint in the list is unreachable or cooled down. */
export class EsploraAllEndpointsFailedError extends Error {
  constructor(
    public readonly urls: string[],
    public readonly causes: Array<{ url: string; reason: string }>,
  ) {
    const summary = causes.map((c) => `${c.url} → ${c.reason}`).join('; ');
    super(`All Esplora endpoints failed: ${summary || '(none available)'}`);
    this.name = 'EsploraAllEndpointsFailedError';
  }
}

/** Merge the caller's signal with a per-attempt timeout; returns the signal and a cleanup. */
function buildAttemptSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const timeoutController = new AbortController();
  let didTimeout = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        didTimeout = true;
        timeoutController.abort();
      }, timeoutMs)
    : undefined;

  const signals: AbortSignal[] = [timeoutController.signal];
  if (callerSignal) signals.push(callerSignal);

  let signal: AbortSignal;
  let removeListener: (() => void) | undefined;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    signal = AbortSignal.any(signals);
  } else if (callerSignal) {
    if (callerSignal.aborted) {
      timeoutController.abort();
    } else {
      const onAbort = () => timeoutController.abort();
      callerSignal.addEventListener('abort', onAbort, { once: true });
      removeListener = () => callerSignal.removeEventListener('abort', onAbort);
    }
    signal = timeoutController.signal;
  } else {
    signal = timeoutController.signal;
  }

  return {
    signal,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      removeListener?.();
    },
    timedOut: () => didTimeout,
  };
}

/**
 * Fetch an Esplora path with ordered failover across `baseUrls`, skipping
 * cooled-down endpoints. The first non-retryable response wins; callers handle
 * 2xx and expected 4xx themselves.
 */
export async function esploraFetch(
  baseUrls: string[],
  path: string,
  options: EsploraFetchOptions = {},
): Promise<Response> {
  if (baseUrls.length === 0) {
    throw new EsploraAllEndpointsFailedError([], []);
  }

  const {
    skipStatuses = [],
    retryStatuses = [],
    signal: callerSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ...fetchInit
  } = options;

  if (callerSignal?.aborted) {
    throw callerSignal.reason instanceof Error
      ? callerSignal.reason
      : new DOMException('Aborted', 'AbortError');
  }

  const skip = new Set(skipStatuses);
  const retry = new Set(retryStatuses);
  const causes: Array<{ url: string; reason: string }> = [];
  const now = Date.now();

  // Cooled-down endpoints go last rather than being skipped, so we still try
  // something when every endpoint is cooling down.
  const normalized = baseUrls.map(normalize);
  const available = normalized.filter((u) => isAvailable(u, now));
  const cooling = normalized.filter((u) => !isAvailable(u, now));
  const attemptOrder = available.length > 0 ? [...available, ...cooling] : cooling;

  for (const baseUrl of attemptOrder) {
    const fullUrl = `${baseUrl}${path}`;
    const attempt = buildAttemptSignal(callerSignal, timeoutMs);

    let response: Response;
    try {
      response = await fetch(fullUrl, { ...fetchInit, signal: attempt.signal });
    } catch (err) {
      attempt.cleanup();

      if (callerSignal?.aborted) {
        throw err;
      }

      // Timeout: fail over. mempool.space sometimes absorbs rate-limited connections
      // and never responds.
      if (attempt.timedOut()) {
        markFailure(baseUrl, Date.now());
        causes.push({ url: baseUrl, reason: `timeout after ${timeoutMs}ms` });
        continue;
      }

      markFailure(baseUrl, Date.now());
      causes.push({ url: baseUrl, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    attempt.cleanup();

    if (response.ok) {
      markSuccess(baseUrl);
      return response;
    }

    // Capability mismatch: try next URL without penalizing this one.
    if (skip.has(response.status)) {
      causes.push({ url: baseUrl, reason: `HTTP ${response.status} (skipped)` });
      continue;
    }

    if (RETRYABLE_STATUS.has(response.status) || retry.has(response.status)) {
      markFailure(baseUrl, Date.now());
      causes.push({ url: baseUrl, reason: `HTTP ${response.status}` });
      continue;
    }

    // Non-retryable 4xx is a real answer.
    markSuccess(baseUrl);
    return response;
  }

  throw new EsploraAllEndpointsFailedError(baseUrls, causes);
}

export function _resetEsploraStateForTests(): void {
  state.clear();
}
