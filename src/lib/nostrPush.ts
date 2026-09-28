/**
 * nostr-push RPC client (NIP-PUSH, kind 25742 + NIP-44). The server is a
 * content-blind relay watcher: the client registers filters + a transport (Web
 * Push or APNs), and the server sends a static wake-up push; the client fetches
 * and decrypts the event. Requests/replies are `#p`-tagged kind 25742 correlated
 * by `request_id`, over `NOSTR_PUSH_RELAYS`. Spec: nostr-push `docs/HOW-IT-WORKS.md`.
 */

import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/types";

/** NIP-PUSH RPC event kind. */
export const KIND_PUSH_RPC = 25742;

const RPC_TIMEOUT_MS = 20_000;

/** A browser Push API endpoint (RFC 8291 + RFC 8292 VAPID). */
export interface WebPushTransport {
  type: "web";
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
}

/**
 * APNs device token. `bundle_id` becomes `apns-topic`. `environment` is required:
 * a token is valid on exactly one APNs host (Xcode → sandbox, TestFlight/App
 * Store → production), read from the app's `aps-environment` entitlement.
 */
export interface ApnsPushTransport {
  type: "apns";
  device_token: string;
  bundle_id: string;
  environment?: "sandbox" | "production";
}

/** How the gateway reaches this install; only the final delivery hop differs by `type`. */
export type PushTransport = WebPushTransport | ApnsPushTransport;

/**
 * A push registration. `relays` is an Armada extension (our rooms live on
 * arbitrary relays); servers ignoring it use their global relay list.
 */
export interface PushRegistration {
  subscription_id: string;
  domain: string;
  filter: NostrFilter;
  relays?: string[];
  notification: {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
    data?: Record<string, unknown>;
  };
  push_subscription: PushTransport;
}

export interface PushRelayPool {
  relay(url: string): {
    event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
    req(
      filters: NostrFilter[],
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<(string | NostrEvent)[]>;
  };
}

/** The signer surface the client needs (NIP-44 is mandatory for nostr-push). */
export interface PushSigner extends Pick<NostrSigner, "getPublicKey" | "signEvent"> {
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

interface RpcResponse {
  request_id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface NostrPushClientOptions {
  serverPubkey: string;
  relays: string[];
  signer: PushSigner;
  pool: PushRelayPool;
  now?: () => number;
  uuid?: () => string;
  timeoutMs?: number;
}

function defaultUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export class NostrPushError extends Error {}

/** Thin, stateless RPC client for one push server; construct per sync. */
export class NostrPushClient {
  readonly #serverPubkey: string;
  readonly #relays: string[];
  readonly #signer: PushSigner;
  readonly #pool: PushRelayPool;
  readonly #now: () => number;
  readonly #uuid: () => string;
  readonly #timeoutMs: number;

  constructor(opts: NostrPushClientOptions) {
    this.#serverPubkey = opts.serverPubkey;
    this.#relays = opts.relays;
    this.#signer = opts.signer;
    this.#pool = opts.pool;
    this.#now = opts.now ?? (() => Date.now());
    this.#uuid = opts.uuid ?? defaultUuid;
    this.#timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  }

  /** Fetch (auto-generating on first call) the server's per-domain VAPID key. */
  async getVapidKey(domain: string): Promise<string> {
    const result = await this.call("get_vapid_key", { domain });
    const key = (result as { vapid_public_key?: unknown })?.vapid_public_key;
    if (typeof key !== "string" || !key) {
      throw new NostrPushError("Push server returned no VAPID key");
    }
    return key;
  }

  /** Create or replace a subscription (idempotent on `subscription_id`). */
  async registerSubscription(params: PushRegistration): Promise<void> {
    await this.call("register_subscription", params);
  }

  async deleteSubscription(subscriptionId: string, domain: string): Promise<void> {
    await this.call("delete_subscription", { subscription_id: subscriptionId, domain });
  }

  /** List the calling pubkey's subscription ids for a domain. */
  async listSubscriptions(domain: string): Promise<string[]> {
    const result = await this.call("list_subscriptions", { domain });
    const subs = (result as { subscriptions?: Array<{ subscription_id?: unknown }> })?.subscriptions;
    if (!Array.isArray(subs)) return [];
    return subs
      .map((s) => s?.subscription_id)
      .filter((id): id is string => typeof id === "string");
  }

  /** Sign + encrypt + publish one RPC request and await the correlated reply. */
  private async call(method: string, params: unknown): Promise<unknown> {
    const nip44 = this.#signer.nip44;
    if (!nip44) throw new NostrPushError("This signer can't use push (NIP-44 unsupported)");

    const myPubkey = await this.#signer.getPublicKey();
    const requestId = this.#uuid();
    const payload = JSON.stringify({ method, params, request_id: requestId });
    const content = await nip44.encrypt(this.#serverPubkey, payload);
    const request = await this.#signer.signEvent({
      kind: KIND_PUSH_RPC,
      content,
      tags: [["p", this.#serverPubkey]],
      created_at: Math.floor(this.#now() / 1000),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    // Listen BEFORE publishing so a fast reply can't race ahead of the REQ.
    const replyPromise = this.awaitReply(myPubkey, requestId, controller.signal);
    await Promise.allSettled(
      this.#relays.map((url) =>
        this.#pool.relay(url).event(request, { signal: controller.signal }),
      ),
    );

    try {
      const response = await replyPromise;
      if (!response.success) {
        throw new NostrPushError(response.error || `Push RPC ${method} failed`);
      }
      return response.result;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /** Resolve with the first reply matching `requestId`, across all relays. */
  private awaitReply(
    myPubkey: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<RpcResponse> {
    const nip44 = this.#signer.nip44!;
    const filter: NostrFilter = {
      kinds: [KIND_PUSH_RPC],
      authors: [this.#serverPubkey],
      "#p": [myPubkey],
      since: Math.floor(this.#now() / 1000) - 5,
    };

    return new Promise<RpcResponse>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      signal.addEventListener("abort", () =>
        finish(() => reject(new NostrPushError("Push RPC timed out"))),
      );

      const drainRelay = async (url: string) => {
        try {
          for await (const msg of this.#pool.relay(url).req([filter], { signal })) {
            if (settled) return;
            if (msg[0] !== "EVENT") continue;
            const event = msg[2] as NostrEvent;
            let response: RpcResponse;
            try {
              response = JSON.parse(await nip44.decrypt(this.#serverPubkey, event.content));
            } catch {
              continue; // not our message / undecryptable
            }
            if (response?.request_id !== requestId) continue;
            finish(() => resolve(response));
            return;
          }
        } catch {
          // Relay closed/aborted — other relays may still answer.
        }
      };

      for (const url of this.#relays) void drainRelay(url);
    });
  }
}
