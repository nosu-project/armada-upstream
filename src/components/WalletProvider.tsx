import React, { useCallback, useEffect, useMemo, useState } from "react";

import { WalletContext, type WalletContextType } from "@/contexts/WalletContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { readActive, readConnections, writeWalletStorage, type NWCConnection } from "@/lib/walletStorage";
import { bolt11Info } from "@/lib/zaps";

import type { LN } from "@getalby/sdk";
import type { WebLNProvider } from "@webbtc/webln-types";

/** Load the NWC SDK on first use — it's heavy and most sessions never pay. */
async function loadSdk(): Promise<typeof import("@getalby/sdk")> {
  return import("@getalby/sdk");
}

/**
 * Lightning wallet state for the current account.
 *
 * NWC connection URIs are wallet-spending SECRETS: they live in per-account
 * plain localStorage keys (see src/lib/walletStorage.ts — never synced, only
 * the alias + wallet-service pubkey prefix are ever rendered, purged when the
 * account is removed).
 *
 * Storage is keyed by pubkey and re-read on account switch, so wallets never
 * leak between accounts. Ported from Ditto's useNWC (validation budgets,
 * payment budget, error mapping) minus its context/SDK-instance caching —
 * a fresh `LN` per operation is simpler and each operation is seconds-long.
 */

const CONNECT_TIMEOUT_MS = 10_000;
/**
 * Outer backstop for a payment. The SDK owns the real reply timeout (~60s per
 * request); this only guards against the SDK itself hanging, and must be
 * LONGER than the SDK's timeout so a slow-settling payment is never cut off
 * before {@link recoverPreimage} can run — cutting it short loses the preimage
 * even though the sats already moved.
 */
const PAY_TIMEOUT_MS = 90_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** What `lookup_invoice` could establish about a payment. */
type Recovery =
  /** The invoice settled; `preimage` is null when the wallet won't surface it. */
  | { state: "settled"; preimage: string | null }
  /** The wallet says the payment failed. */
  | { state: "failed" }
  /** Couldn't tell within the budget (lookup unsupported, pending, or erroring). */
  | { state: "unknown" };

/**
 * Ask the wallet what actually happened to a payment whose `pay()` reply was
 * missing, error-shaped, or preimage-less. Wallet error replies are unreliable
 * narrators — some report "timeout" for a payment that settles a beat later —
 * so callers should trust THIS (the ledger), not the error's shape. Polls a
 * few rounds because a just-settled payment may briefly report `pending`, and
 * a settled one may briefly omit its preimage.
 *
 * This matters most for CORD.md private zaps, whose sealed announcement can't
 * be built without the preimage — a lost ack would otherwise mean paid sats
 * with no zap to show for them.
 */
async function recoverPreimage(
  client: LN,
  invoice: string,
  schedule: { attempts: number; firstDelayMs: number; delayMs: number } = { attempts: 5, firstDelayMs: 500, delayMs: 1500 },
): Promise<Recovery> {
  // NIP-47 lets lookup_invoice match on payment_hash OR the bolt11 string, and
  // wallets vary in which they honor — try both. The hash decodes locally.
  const { paymentHash } = bolt11Info(invoice);
  const requests: Array<{ payment_hash: string } | { invoice: string }> = [];
  if (paymentHash) requests.push({ payment_hash: paymentHash });
  requests.push({ invoice });

  let settled = false;
  let unsupported = false;
  for (let attempt = 0; attempt < schedule.attempts && !unsupported; attempt++) {
    // A just-settled payment can report `pending` briefly; poll a few rounds.
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? schedule.firstDelayMs : schedule.delayMs));
    for (const request of requests) {
      try {
        const tx = await client.nwcClient.lookupInvoice(request);
        if (tx?.state === "settled") {
          if (tx.preimage) return { state: "settled", preimage: tx.preimage };
          settled = true; // keep polling — the preimage may surface next round
        }
        if (tx?.state === "failed") return { state: "failed" };
      } catch (e) {
        const message = e instanceof Error ? e.message.toLowerCase() : "";
        if (message.includes("not supported") || message.includes("unsupported") || message.includes("not_implemented")) {
          unsupported = true;
          break;
        }
        // Transient lookup error — keep polling.
      }
    }
  }
  return settled ? { state: "settled", preimage: null } : { state: "unknown" };
}

const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;

  const [connections, setConnections] = useState<NWCConnection[]>(() => readConnections(pubkey));
  const [active, setActiveString] = useState<string | null>(() => readActive(pubkey));

  // Account switch: swap to the new account's wallet set, never mixing.
  useEffect(() => {
    setConnections(readConnections(pubkey));
    setActiveString(readActive(pubkey));
  }, [pubkey]);

  const persist = useCallback(
    (next: NWCConnection[], nextActive: string | null) => {
      setConnections(next);
      setActiveString(nextActive);
      if (pubkey) writeWalletStorage(pubkey, next, nextActive);
    },
    [pubkey],
  );

  const addConnection = useCallback(
    async (uri: string, alias?: string) => {
      const trimmed = uri.trim();
      if (!/^nostr\+?walletconnect:\/\//i.test(trimmed)) {
        throw new Error("Not a wallet connection string (expected nostr+walletconnect://…).");
      }
      if (connections.some((c) => c.connectionString === trimmed)) {
        throw new Error("That wallet is already connected.");
      }
      // Prove the wallet is reachable before saving: a NIP-47 get_info
      // round-trip against the wallet service's relay.
      let client: LN | undefined;
      try {
        await withTimeout(
          (async () => {
            const { LN: LNClass } = await loadSdk();
            client = new LNClass(trimmed);
            await client.nwcClient.getInfo();
          })(),
          CONNECT_TIMEOUT_MS,
          "Wallet didn't respond — check the connection string and try again.",
        );
      } catch (e) {
        throw e instanceof Error ? e : new Error("Couldn't reach that wallet.");
      } finally {
        try {
          client?.close();
        } catch {
          // best-effort socket cleanup
        }
      }
      const connection: NWCConnection = {
        connectionString: trimmed,
        alias: alias?.trim() || "Lightning wallet",
        addedAt: Date.now(),
      };
      // First wallet becomes active automatically.
      persist([...connections, connection], active ?? trimmed);
    },
    [connections, active, persist],
  );

  const removeConnection = useCallback(
    (connectionString: string) => {
      const next = connections.filter((c) => c.connectionString !== connectionString);
      const nextActive =
        active === connectionString ? (next[0]?.connectionString ?? null) : active;
      persist(next, nextActive);
    },
    [connections, active, persist],
  );

  const setActive = useCallback(
    (connectionString: string) => {
      if (connections.some((c) => c.connectionString === connectionString)) {
        persist(connections, connectionString);
      }
    },
    [connections, persist],
  );

  const payWithNWC = useCallback(
    async (invoice: string): Promise<{ preimage: string | null }> => {
      const connection = connections.find((c) => c.connectionString === active);
      if (!connection) throw new Error("No wallet connected.");
      let client: LN | undefined;
      try {
        return await withTimeout(
          (async () => {
            const sdk = await loadSdk();
            client = new sdk.LN(connection.connectionString);
            try {
              const result = await client.pay(invoice);
              if (result?.preimage) return { preimage: result.preimage };
              // Paid, but the reply carried no preimage — recover it by lookup.
              const recovery = await recoverPreimage(client, invoice);
              return { preimage: recovery.state === "settled" ? recovery.preimage : null };
            } catch (payErr) {
              // A rejected pay() does NOT mean the payment failed. Beyond the
              // SDK's own reply timeout (Nip47TimeoutError — response event
              // lost, sats very likely moved), wallets also REPLY with
              // error-shaped acks ("timeout", races with settlement) for
              // payments that settle anyway. Don't classify the error — ask
              // the wallet what actually happened via lookup_invoice:
              //  - settled: it paid; hand back the preimage (or null if the
              //    wallet won't surface it — the private caller keeps looking,
              //    the NIP-29 caller never needed it).
              //  - failed:  genuine failure, surface the original error.
              //  - unknown: only a lost ack (Nip47TimeoutError) earns the
              //    benefit of the doubt, matching Ditto; a definite error
              //    reply with no trace of settlement is a failure.
              const recovery = await recoverPreimage(client, invoice);
              if (recovery.state === "settled") return { preimage: recovery.preimage };
              if (recovery.state === "failed" || !(payErr instanceof sdk.Nip47TimeoutError)) {
                throw payErr instanceof Error ? payErr : new Error("Payment failed.");
              }
              return { preimage: null };
            }
          })(),
          PAY_TIMEOUT_MS,
          "Payment timed out — check your wallet before retrying.",
        );
      } finally {
        try {
          client?.close();
        } catch {
          // best-effort socket cleanup
        }
      }
    },
    [connections, active],
  );

  /**
   * Long-window preimage recovery for an already-paid invoice (see
   * WalletContext). Opens its own NWC client so it can outlive the payment
   * call — `payWithNWC` closes its client when it returns, and the whole point
   * here is to keep asking AFTER an "unproven" payment resolved. Polls
   * `lookup_invoice` every 5s until the budget (default 2 min) runs out.
   */
  const lookupPreimage = useCallback(
    async (invoice: string, opts?: { budgetMs?: number }): Promise<string | null> => {
      const connection = connections.find((c) => c.connectionString === active);
      if (!connection) return null;
      const budgetMs = opts?.budgetMs ?? 120_000;
      const delayMs = 5_000;
      let client: LN | undefined;
      try {
        const sdk = await loadSdk();
        client = new sdk.LN(connection.connectionString);
        const recovery = await recoverPreimage(client, invoice, {
          attempts: Math.max(1, Math.floor(budgetMs / delayMs)),
          firstDelayMs: delayMs,
          delayMs,
        });
        return recovery.state === "settled" ? recovery.preimage : null;
      } catch {
        return null;
      } finally {
        try {
          client?.close();
        } catch {
          // best-effort socket cleanup
        }
      }
    },
    [connections, active],
  );

  const value = useMemo<WalletContextType>(() => {
    const activeConnection = connections.find((c) => c.connectionString === active) ?? null;
    const webln = (globalThis as { webln?: WebLNProvider }).webln ?? null;
    return { connections, activeConnection, addConnection, removeConnection, setActive, payWithNWC, lookupPreimage, webln };
  }, [connections, active, addConnection, removeConnection, setActive, payWithNWC, lookupPreimage]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
};

export default WalletProvider;
