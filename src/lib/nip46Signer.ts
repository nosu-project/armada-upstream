/**
 * NIP-46 remote signer, replacing Nostrify's `NConnectSigner`, whose per-RPC
 * subscriptions missed ephemeral kind-24133 responses, left zombie subs, and
 * retried explicit rejections. This keeps ONE session-lived response
 * subscription and dispatches by request id. Requests are NIP-44; responses
 * fall back to NIP-04 for legacy bunkers.
 *
 * Each RPC keeps ONE request id and re-publishes it while unanswered: relays
 * don't store ephemeral 24133, so a sleeping signer only sees a copy published
 * after it reconnects, and signers key prompts by request id. A signature waits
 * minutes, since the user may have to go approve it.
 */

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import type { NostrConnectRequest, NostrConnectResponse } from "@nostrify/types";

import type { BtcSigner } from "@/lib/bitcoin-signers";
import type { Nip46Transport } from "@/lib/nip46Transport";
import { logSync } from "@/lib/syncLog";

export interface Nip46SignerOpts {
  transport: Nip46Transport;
  bunkerPubkey: string;
  /** Local ephemeral client signer (the pairing's client key). */
  clientSigner: NostrSigner;
  /** Re-publish an unanswered request this often. Default 30s. */
  attemptTimeoutMs?: number;
  /** How many publishes a non-signing RPC gets before it fails. Default 2. */
  attempts?: number;
  /** How long a `sign_event` waits for the user to approve it. Default 5 min. */
  signTimeoutMs?: number;
}

/** Long enough to switch to the signer app, find the request and approve it. */
export const NIP46_SIGN_TIMEOUT_MS = 5 * 60_000;

const NIP46_KIND = 24133;

/** Thrown when the bunker answered with an explicit error. Never retried. */
class BunkerResponseError extends Error {}

/**
 * Text patterns marking a `sign_psbt` error as missing capability rather than a
 * transient failure (NIP-46 errors are unstructured strings).
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
  private readonly signTimeoutMs: number;

  private readonly pending = new Map<string, PendingRpc>();
  /** Re-publish of each unanswered request, by request id. */
  private readonly republish = new Map<string, () => Promise<void>>();
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
    this.signTimeoutMs = opts.signTimeoutMs ?? NIP46_SIGN_TIMEOUT_MS;
    this.ready = this.subscribe();
    // A backgrounded page's timers stall; coming back is when the signer most
    // likely just woke, so give it a fresh copy of everything outstanding.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.resendPending();
      }, { signal: this.abort.signal });
    }
  }

  /** Re-publish every unanswered request now (same ids, so no duplicate prompts). */
  resendPending(): void {
    for (const publish of this.republish.values()) void publish().catch(() => undefined);
  }

  /** Open the session-lived response subscription and pump it forever. */
  private async subscribe(): Promise<void> {
    this.clientPubkey = await this.clientSigner.getPublicKey();
    const iter = this.transport.req(
      [{ kinds: [NIP46_KIND], authors: [this.bunkerPubkey], "#p": [this.clientPubkey] }],
      { signal: this.abort.signal },
    );
    // Detached pump for the signer's lifetime; the transport only ends it on abort, which never fires.
    void (async () => {
      for await (const msg of iter) {
        if (msg[0] === "EVENT") await this.dispatch(msg[2]);
      }
    })().catch(() => undefined);
  }

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
    if (!rpc) return; // Stale/foreign: settled already (a re-published copy's second answer).
    this.pending.delete(response.id);
    rpc.resolve(response);
  }

  /**
   * One RPC under one request id, re-published every `attemptTimeoutMs` while
   * unanswered. A bunker error (a rejection) fails at once and is never re-asked.
   */
  private async cmd(method: string, params: string[]): Promise<string> {
    await this.ready;
    const request: NostrConnectRequest = { id: crypto.randomUUID(), method, params };
    const budgetMs = method === "sign_event" ? this.signTimeoutMs : this.attemptTimeoutMs * this.attempts;
    const t0 = Date.now();
    const deadline = t0 + budgetMs;
    const response = new Promise<NostrConnectResponse>((resolve) => {
      this.pending.set(request.id, { resolve, method });
    });
    let copies = 0;
    const publish = async () => {
      copies++;
      const event = await this.clientSigner.signEvent({
        kind: NIP46_KIND,
        content: await this.clientSigner.nip44!.encrypt(this.bunkerPubkey, JSON.stringify(request)),
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.bunkerPubkey]],
      });
      await this.transport.event(event, { signal: AbortSignal.timeout(this.attemptTimeoutMs) });
    };
    this.republish.set(request.id, publish);
    logSync("nip46", `→ ${method} ${request.id.slice(0, 8)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let lastErr: unknown;
      for (;;) {
        try {
          await publish();
          lastErr = undefined;
        } catch (err) {
          lastErr = err;
          logSync("nip46", `✗ ${method} publish failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const wait = Math.min(this.attemptTimeoutMs, deadline - Date.now());
        const outcome = await Promise.race([
          response,
          new Promise<undefined>((r) => {
            timer = setTimeout(() => r(undefined), Math.max(0, wait));
          }),
        ]);
        clearTimeout(timer);
        if (outcome) {
          const { result, error } = outcome;
          if (error) {
            logSync("nip46", `✗ ${method} rejected by bunker in ${Date.now() - t0}ms: ${error}`);
            throw new BunkerResponseError(error);
          }
          if (typeof result !== "string") throw new BunkerResponseError("malformed NIP-46 response");
          logSync("nip46", `← ${method} ok in ${Date.now() - t0}ms (${copies} cop${copies === 1 ? "y" : "ies"})`);
          return result;
        }
        if (Date.now() >= deadline) {
          logSync("nip46", `✗ ${method} unanswered after ${Date.now() - t0}ms (${copies} copies)`);
          throw lastErr ?? new Error(`NIP-46 ${method} timed out after ${budgetMs}ms`);
        }
        logSync("nip46", `… ${method} unanswered after ${Date.now() - t0}ms, re-publishing`);
      }
    } finally {
      clearTimeout(timer);
      this.pending.delete(request.id);
      this.republish.delete(request.id);
    }
  }

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

  /** `connect` handshake used when pairing via a bunker:// URI. */
  connect(secret?: string): Promise<string> {
    const params = [this.bunkerPubkey];
    if (secret) params.push(secret);
    return this.cmd("connect", params);
  }

  ping(): Promise<string> {
    return this.cmd("ping", []);
  }

  /**
   * NIP-46 `sign_psbt`. Capability failures are re-wrapped to flip the UI into
   * the unsupported state; other errors propagate unchanged.
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
