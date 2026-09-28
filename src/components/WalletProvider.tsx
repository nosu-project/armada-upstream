import React, { useCallback, useEffect, useMemo, useState } from "react";

import { WalletContext, type WalletContextType } from "@/contexts/WalletContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { readActive, readConnections, writeWalletStorage, type NWCConnection } from "@/lib/walletStorage";
import { bolt11Info } from "@/lib/zaps";

import type { LN } from "@getalby/sdk";
import type { WebLNProvider } from "@webbtc/webln-types";

/** Lazy: the NWC SDK is heavy and most sessions never use it. */
async function loadSdk(): Promise<typeof import("@getalby/sdk")> {
  return import("@getalby/sdk");
}

/**
 * Lightning wallet state. NWC URIs are spending SECRETS in per-account
 * localStorage (src/lib/walletStorage.ts), never synced or rendered. Ported
 * from Ditto's useNWC minus SDK-instance caching (a fresh `LN` per operation).
 */

const CONNECT_TIMEOUT_MS = 10_000;
/**
 * Backstop for the SDK hanging. Must exceed the SDK's ~60s reply timeout so
 * {@link recoverPreimage} can still run; cutting it short loses the preimage.
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

type Recovery =
  /** The invoice settled; `preimage` is null when the wallet won't surface it. */
  | { state: "settled"; preimage: string | null }
  | { state: "failed" }
  /** Couldn't tell within the budget (lookup unsupported, pending, or erroring). */
  | { state: "unknown" };

/**
 * Ask the wallet (`lookup_invoice`) what happened to a payment whose reply was
 * missing, error-shaped, or preimage-less; wallet error replies are
 * unreliable. Critical for CORD.md private zaps, which need the preimage.
 */
async function recoverPreimage(
  client: LN,
  invoice: string,
  schedule: { attempts: number; firstDelayMs: number; delayMs: number } = { attempts: 5, firstDelayMs: 500, delayMs: 1500 },
): Promise<Recovery> {
  // NIP-47 wallets vary in honoring payment_hash vs bolt11; try both.
  const { paymentHash } = bolt11Info(invoice);
  const requests: Array<{ payment_hash: string } | { invoice: string }> = [];
  if (paymentHash) requests.push({ payment_hash: paymentHash });
  requests.push({ invoice });

  let settled = false;
  let unsupported = false;
  for (let attempt = 0; attempt < schedule.attempts && !unsupported; attempt++) {
    // A just-settled payment can report `pending` briefly.
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? schedule.firstDelayMs : schedule.delayMs));
    for (const request of requests) {
      try {
        const tx = await client.nwcClient.lookupInvoice(request);
        if (tx?.state === "settled") {
          if (tx.preimage) return { state: "settled", preimage: tx.preimage };
          settled = true; // the preimage may surface next round
        }
        if (tx?.state === "failed") return { state: "failed" };
      } catch (e) {
        const message = e instanceof Error ? e.message.toLowerCase() : "";
        if (message.includes("not supported") || message.includes("unsupported") || message.includes("not_implemented")) {
          unsupported = true;
          break;
        }
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

  // Account switch: swap wallet sets, never mixing.
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
      // Prove reachability with a NIP-47 get_info before saving.
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
        } catch { /* ignore */ }
      }
      const connection: NWCConnection = {
        connectionString: trimmed,
        alias: alias?.trim() || "Lightning wallet",
        addedAt: Date.now(),
      };
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
              const recovery = await recoverPreimage(client, invoice);
              return { preimage: recovery.state === "settled" ? recovery.preimage : null };
            } catch (payErr) {
              // A rejected pay() doesn't mean failure (lost acks, error-shaped replies for
              // payments that settle), so ask the wallet. Unknown: only a lost ack
              // (Nip47TimeoutError) gets the benefit of the doubt, matching Ditto.
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
        } catch { /* ignore */ }
      }
    },
    [connections, active],
  );

  /**
   * Long-window preimage recovery with its own NWC client (payWithNWC closes
   * its client on return). Polls every 5s until the budget (default 2 min).
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
        } catch { /* ignore */ }
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
