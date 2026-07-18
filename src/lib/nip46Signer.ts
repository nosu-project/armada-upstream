/**
 * Nip46Signer — a NIP-46 remote signer built for reliability.
 *
 * Replaces Nostrify's `NConnectSigner` for the bunker session. The stock
 * signer opens a brand-new subscription per RPC and has three failure modes
 * that made remote signing feel broken next to other clients:
 *
 *  1. Kind-24133 traffic is EPHEMERAL: relays only deliver it to
 *     subscriptions that are live at publish time. A per-RPC sub that is
 *     torn down and rebuilt for every call (and rebuilt after every socket
 *     flap) has windows where the bunker's response has nowhere to land —
 *     the RPC then hangs until timeout even though the bunker answered.
 *  2. Its response promise never settles when the subscription ends without
 *     a matching event, so callers had to race it against an outer timer —
 *     and the loser of that race kept its subscription alive as a zombie
 *     that kept receiving (and decrypting) every response for up to a
 *     minute.
 *  3. EVERY failure was retried, including explicit bunker error responses —
 *     so a user tapping "reject" in their signer got re-prompted 15s later.
 *
 * This signer instead keeps ONE persistent response subscription for the
 * whole session (the transport re-issues it after every reconnect) and
 * dispatches incoming responses to pending RPCs by request id. Each RPC:
 *
 *  - signs + publishes a fresh request event per attempt,
 *  - is fenced by a per-attempt timeout, and ONLY silence/publish-failure is
 *    retried — an explicit error response from the bunker fails immediately,
 *  - always cleans up its pending entry (no zombies, ever).
 *
 * Requests are NIP-44 encrypted; responses are decrypted as NIP-44 with a
 * NIP-04 fallback for legacy bunkers (decryption is local and cheap).
 */

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import type { NostrConnectRequest, NostrConnectResponse } from "@nostrify/types";

import type { BtcSigner } from "@/lib/bitcoin-signers";
import type { Nip46Transport } from "@/lib/nip46Transport";
import { logSync } from "@/lib/syncLog";

export interface Nip46SignerOpts {
  /** Dedicated plain-WebSocket transport to the bunker relays. */
  transport: Nip46Transport;
  /** The remote signer's (bunker's) pubkey. */
  bunkerPubkey: string;
  /** Local ephemeral client signer (the pairing's client key). */
  clientSigner: NostrSigner;
  /** Per-attempt budget for one RPC round-trip. Default 30s. */
  attemptTimeoutMs?: number;
  /** How many attempts before an RPC fails. Default 2. */
  attempts?: number;
}

const NIP46_KIND = 24133;

/** Thrown when the bunker answered with an explicit error. Never retried. */
class BunkerResponseError extends Error {}

/**
 * Heuristics for detecting whether a NIP-46 `sign_psbt` error reflects a
 * missing-capability rejection (e.g. "method not supported", "unknown
 * command") versus a transient operational failure (network, user rejection,
 * malformed input). NIP-46 errors are plain strings without structured
 * codes, so we match on text.
 */
const CAPABILITY_ERROR_PATTERNS = [
  /unknown\s+(method|command)/i,
  /not\s+(implemented|supported|found)/i,
  /unsupported\s+method/i,
  /method\s+not\s+found/i,
  /invalid\s+method/i,
  /no\s+such\s+method/i,
];

function looksLikeCapabilityError(msg: string): boolean {
  return CAPABILITY_ERROR_PATTERNS.some((re) => re.test(msg));
}

interface PendingRpc {
  resolve: (response: NostrConnectResponse) => void;
  method: string;
}

export class Nip46Signer implements NostrSigner, BtcSigner {
  private readonly transport: Nip46Transport;
  private readonly bunkerPubkey: string;
  private readonly clientSigner: NostrSigner;
  private readonly attemptTimeoutMs: number;
  private readonly attempts: number;

  private readonly pending = new Map<string, PendingRpc>();
  private readonly abort = new AbortController();
  private clientPubkey: string | undefined;

  /** Resolves once the persistent response subscription is installed. */
  private readonly ready: Promise<void>;

  constructor(opts: Nip46SignerOpts) {
    this.transport = opts.transport;
    this.bunkerPubkey = opts.bunkerPubkey;
    this.clientSigner = opts.clientSigner;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? 30_000;
    this.attempts = opts.attempts ?? 2;
    this.ready = this.subscribe();
  }

  // --- response plumbing ----------------------------------------------------

  /** Open the session-lived response subscription and pump it forever. */
  private async subscribe(): Promise<void> {
    this.clientPubkey = await this.clientSigner.getPublicKey();
    const iter = this.transport.req(
      [{ kinds: [NIP46_KIND], authors: [this.bunkerPubkey], "#p": [this.clientPubkey] }],
      { signal: this.abort.signal },
    );
    // Detached pump: runs for the signer's lifetime. The transport only ends
    // the iterator on abort, which we never fire — swallow any exit.
    void (async () => {
      for await (const msg of iter) {
        if (msg[0] === "EVENT") await this.dispatch(msg[2]);
      }
    })().catch(() => undefined);
  }

  /** Decrypt an incoming response event and hand it to the waiting RPC. */
  private async dispatch(event: NostrEvent): Promise<void> {
    let plaintext: string;
    try {
      plaintext = await this.clientSigner.nip44!.decrypt(event.pubkey, event.content);
    } catch {
      // Legacy bunkers may answer NIP-04 even to a NIP-44 request.
      try {
        plaintext = await this.clientSigner.nip04!.decrypt(event.pubkey, event.content);
      } catch {
        return; // Not addressed to us / undecryptable noise.
      }
    }
    let response: NostrConnectResponse;
    try {
      response = JSON.parse(plaintext) as NostrConnectResponse;
    } catch {
      return;
    }
    if (typeof response?.id !== "string") return;
    const rpc = this.pending.get(response.id);
    if (!rpc) return; // Stale/foreign response (e.g. a retried attempt's twin).
    this.pending.delete(response.id);
    rpc.resolve(response);
  }

  // --- RPC core ---------------------------------------------------------------

  /** High-level RPC. Retries ONLY on silence/publish failure, never on an
   *  explicit bunker error (a user rejection must not re-prompt). */
  private async cmd(method: string, params: string[]): Promise<string> {
    await this.ready;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const t0 = Date.now();
      logSync("nip46", `→ ${method}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      try {
        const result = await this.attemptOnce(method, params);
        logSync("nip46", `← ${method} ok in ${Date.now() - t0}ms${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
        return result;
      } catch (err) {
        if (err instanceof BunkerResponseError) {
          logSync("nip46", `✗ ${method} rejected by bunker in ${Date.now() - t0}ms: ${err.message}`);
          throw err;
        }
        lastErr = err;
        logSync(
          "nip46",
          `✗ ${method} attempt ${attempt}/${this.attempts} failed in ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    throw lastErr;
  }

  /** One RPC attempt: sign + publish the request, await its matched response. */
  private async attemptOnce(method: string, params: string[]): Promise<string> {
    const request: NostrConnectRequest = { id: crypto.randomUUID(), method, params };
    const event = await this.clientSigner.signEvent({
      kind: NIP46_KIND,
      content: await this.clientSigner.nip44!.encrypt(this.bunkerPubkey, JSON.stringify(request)),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", this.bunkerPubkey]],
    });

    const response = new Promise<NostrConnectResponse>((resolve) => {
      this.pending.set(request.id, { resolve, method });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`NIP-46 ${method} timed out after ${this.attemptTimeoutMs}ms`)),
        this.attemptTimeoutMs,
      );
    });
    try {
      // Publish first (bounded by its own abort), then wait for the bunker.
      // The persistent sub is already live — the response can't miss us.
      await this.transport.event(event, { signal: AbortSignal.timeout(this.attemptTimeoutMs) });
      const { result, error } = await Promise.race([response, timeout]);
      if (error) throw new BunkerResponseError(error);
      if (typeof result !== "string") throw new BunkerResponseError("malformed NIP-46 response");
      return result;
    } finally {
      clearTimeout(timer);
      this.pending.delete(request.id);
    }
  }

  // --- NostrSigner surface ----------------------------------------------------

  getPublicKey(): Promise<string> {
    return this.cmd("get_public_key", []);
  }

  async signEvent(event: Omit<NostrEvent, "id" | "pubkey" | "sig">): Promise<NostrEvent> {
    const result = await this.cmd("sign_event", [JSON.stringify(event)]);
    const signed = JSON.parse(result) as NostrEvent;
    if (
      typeof signed?.id !== "string" ||
      typeof signed?.pubkey !== "string" ||
      typeof signed?.sig !== "string"
    ) {
      throw new Error("NIP-46 sign_event returned a malformed event");
    }
    return signed;
  }

  async getRelays(): Promise<Record<string, { read: boolean; write: boolean }>> {
    const result = await this.cmd("get_relays", []);
    return JSON.parse(result) as Record<string, { read: boolean; write: boolean }>;
  }

  readonly nip04 = {
    encrypt: (pubkey: string, plaintext: string): Promise<string> =>
      this.cmd("nip04_encrypt", [pubkey, plaintext]),
    decrypt: (pubkey: string, ciphertext: string): Promise<string> =>
      this.cmd("nip04_decrypt", [pubkey, ciphertext]),
  };

  readonly nip44 = {
    encrypt: (pubkey: string, plaintext: string): Promise<string> =>
      this.cmd("nip44_encrypt", [pubkey, plaintext]),
    decrypt: (pubkey: string, ciphertext: string): Promise<string> =>
      this.cmd("nip44_decrypt", [pubkey, ciphertext]),
  };

  // --- NIP-46 session methods ---------------------------------------------------

  /** `connect` handshake used when pairing via a bunker:// URI. */
  connect(secret?: string): Promise<string> {
    const params = [this.bunkerPubkey];
    if (secret) params.push(secret);
    return this.cmd("connect", params);
  }

  /** Liveness probe. */
  ping(): Promise<string> {
    return this.cmd("ping", []);
  }

  // --- BtcSigner ------------------------------------------------------------

  /**
   * NIP-46 `sign_psbt`. Capability failures (the bunker doesn't know the
   * method) are re-wrapped with the message that flips the UI into the
   * unsupported state; everything else (timeouts, rejections, malformed
   * input) propagates unchanged so the caller surfaces the real error.
   */
  async signPsbt(psbtHex: string): Promise<string> {
    try {
      return await this.cmd("sign_psbt", [psbtHex]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (looksLikeCapabilityError(msg)) {
        throw new Error(
          `Your remote signer doesn't support sending Bitcoin. Update your signer, or log in with your secret key. (${msg})`,
        );
      }
      throw error;
    }
  }
}
