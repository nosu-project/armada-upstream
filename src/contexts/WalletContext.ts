import { createContext } from "react";

import type { NWCConnection } from "@/lib/walletStorage";
import type { WebLNProvider } from "@webbtc/webln-types";

export type { NWCConnection };

export interface WalletContextType {
  /** Saved NWC connections for the CURRENT account (local-only storage). */
  connections: NWCConnection[];
  /** The connection payments go through, or null. */
  activeConnection: NWCConnection | null;
  /** Validate, test (10s) and save a nostr+walletconnect:// URI; throws user-facing errors. */
  addConnection(uri: string, alias?: string): Promise<void>;
  removeConnection(connectionString: string): void;
  setActive(connectionString: string): void;
  /**
   * Pay a bolt11 over NWC. `preimage` is null if it settled but the proof wasn't
   * obtained (NIP-57 zaps don't need it; private CORD.md zaps treat it as fatal).
   * Rejects only on real payment failure.
   */
  payWithNWC(invoice: string): Promise<{ preimage: string | null }>;
  /**
   * Poll `lookup_invoice` for an ALREADY-PAID invoice's preimage (the lost-ack
   * case), so a private CORD.md zap can still seal. Null if never surfaced.
   */
  lookupPreimage(invoice: string, opts?: { budgetMs?: number }): Promise<string | null>;
  /** Browser WebLN provider, if an extension injected one (null on the APK). */
  webln: WebLNProvider | null;
}

export const WalletContext = createContext<WalletContextType | undefined>(undefined);
