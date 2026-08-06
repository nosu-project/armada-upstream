import { SYNCED_CONFIG_KEYS, type AppConfig } from "@/contexts/AppContext";

import type { EncryptedSettings } from "@/lib/schemas";

/** Pick the account-portable fields out of AppConfig for encrypted NIP-78. */
export function syncedConfigSnapshot(config: AppConfig): Partial<EncryptedSettings> {
  const out: Record<string, unknown> = {};
  for (const key of SYNCED_CONFIG_KEYS) {
    const value = config[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<EncryptedSettings>;
}
