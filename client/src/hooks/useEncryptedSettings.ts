import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { APP_NAME } from "@/lib/platform";
import { EncryptedSettingsSchema, type EncryptedSettings } from "@/lib/schemas";

/** NIP-78 application-data kind. */
const SETTINGS_KIND = 30078;
/** `d` tag identifying Armada's settings event. */
const SETTINGS_D = "armada/metadata";

/**
 * ms timestamp of the last local encrypted-settings write this session. Lets
 * NostrSync avoid overwriting a fresh local edit with a stale relay event.
 */
let lastWriteTs = 0;
export function getLastSettingsWrite(): number {
  return lastWriteTs;
}

/** Persist the synced timestamp per-pubkey so reloads can trust localStorage. */
export function getLocalSettingsSync(pubkey: string): number {
  try {
    return Number(localStorage.getItem(`armada:settings-lastSync:${pubkey}`)) || 0;
  } catch {
    return 0;
  }
}
export function setLocalSettingsSync(pubkey: string, lastSync: number): void {
  try {
    localStorage.setItem(`armada:settings-lastSync:${pubkey}`, String(lastSync));
  } catch {
    // localStorage unavailable — ignore.
  }
}

/**
 * Read and write the user's encrypted app settings (theme + customTheme +
 * themes) as a NIP-44-encrypted kind 30078 event on the app relays. Adapted
 * from Ditto's useEncryptedSettings.
 */
export function useEncryptedSettings() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const pendingSettings = useRef<EncryptedSettings | null>(null);

  const queryKey = ["encrypted-settings", user?.pubkey];

  const settings = useQuery<EncryptedSettings | null>({
    queryKey,
    enabled: !!user?.pubkey && !!user.signer.nip44,
    queryFn: async ({ signal }) => {
      if (!user?.signer.nip44) return null;

      const events = await nostr.query(
        [{ kinds: [SETTINGS_KIND], authors: [user.pubkey], "#d": [SETTINGS_D], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) },
      );

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event?.content) return null;

      try {
        const decrypted = await user.signer.nip44.decrypt(user.pubkey, event.content);
        const parsed = EncryptedSettingsSchema.safeParse(JSON.parse(decrypted));
        return parsed.success ? parsed.data : null;
      } catch (err) {
        console.warn("Failed to decrypt settings:", err);
        return null;
      }
    },
    staleTime: 60_000,
  });

  const updateSettings = useMutation({
    mutationFn: async (patch: Partial<EncryptedSettings>) => {
      if (!user?.signer.nip44) throw new Error("NIP-44 encryption not supported by signer");

      // Merge over the freshest known state (cache + this session's pending).
      const base: EncryptedSettings = {
        ...(settings.data ?? {}),
        ...(pendingSettings.current ?? {}),
      };
      const next: EncryptedSettings = { ...base, ...patch, lastSync: Date.now() };
      pendingSettings.current = next;
      lastWriteTs = Date.now();

      const plaintext = JSON.stringify(next);
      const content = await user.signer.nip44.encrypt(user.pubkey, plaintext);

      const event = await user.signer.signEvent({
        kind: SETTINGS_KIND,
        content,
        tags: [
          ["d", SETTINGS_D],
          ["title", `${APP_NAME} Settings`],
        ],
        created_at: Math.floor(Date.now() / 1000),
      });

      // Optimistically update the cache, then publish in the background.
      queryClient.setQueryData(queryKey, next);
      setLocalSettingsSync(user.pubkey, next.lastSync ?? Date.now());
      nostr.event(event, { signal: AbortSignal.timeout(8000) }).catch((err) => {
        console.warn("Failed to publish encrypted settings:", err);
      });

      return next;
    },
  });

  return {
    settings: settings.data ?? null,
    isLoading: settings.isLoading,
    refetch: settings.refetch,
    updateSettings: updateSettings.mutateAsync,
    hasNip44Support: !!user?.signer.nip44,
  };
}
