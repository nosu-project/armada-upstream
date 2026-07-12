/**
 * Per-account Esplora API endpoint config — local only, never synced (matches
 * the wallet-secrets pattern in {@link walletStorage}). A user's preferred
 * Bitcoin blockchain explorers are a device-level concern, not a synced pref.
 */
import { DEFAULT_ESPLORA_APIS } from "@/lib/esplora";

const esploraKey = (pubkey: string) => `armada:esplora-apis:${pubkey}`;

export function readEsploraApis(pubkey: string | undefined): string[] {
  if (!pubkey) return [...DEFAULT_ESPLORA_APIS];
  try {
    const raw = localStorage.getItem(esploraKey(pubkey));
    if (!raw) return [...DEFAULT_ESPLORA_APIS];
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...DEFAULT_ESPLORA_APIS];
  } catch {
    return [...DEFAULT_ESPLORA_APIS];
  }
}

export function writeEsploraApis(pubkey: string, apis: string[]): void {
  try {
    localStorage.setItem(esploraKey(pubkey), JSON.stringify(apis));
  } catch {
    // Storage unavailable — config survives for the session only.
  }
}

export function clearEsploraStorage(pubkey: string): void {
  try {
    localStorage.removeItem(esploraKey(pubkey));
  } catch {
    // best-effort
  }
}

export { DEFAULT_ESPLORA_APIS };
