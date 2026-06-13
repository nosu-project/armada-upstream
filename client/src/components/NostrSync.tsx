import { useNostr } from "@nostrify/react";
import { useEffect, useRef } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  getLastSettingsWrite,
  getLocalSettingsSync,
  setLocalSettingsSync,
  useEncryptedSettings,
} from "@/hooks/useEncryptedSettings";
import { useTheme } from "@/hooks/useTheme";
import { ACTIVE_THEME_KIND, parseDittoTheme } from "@/lib/themeEvent";

/**
 * Bridges the user's themes from Nostr into Armada on login / account switch.
 * Adapted from Ditto's NostrSync.
 *
 *  1. Pulls Armada's own encrypted settings (NIP-78, kind 30078,
 *     d="armada/metadata") into AppConfig — theme/customTheme/themes —
 *     timestamp-guarded so a stale relay event never clobbers a fresh local
 *     edit.
 *  2. Interop: if the user has never picked a theme in Armada, adopt their
 *     Ditto *active profile theme* (kind 16767) so Ditto users feel at home.
 *
 * Renders nothing.
 */
export function NostrSync() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const { settings } = useEncryptedSettings();
  const { applyCustomTheme } = useTheme();

  const lastAppliedPubkey = useRef<string | undefined>(undefined);
  const dittoCheckedPubkey = useRef<string | undefined>(undefined);

  // Reset guards when the account changes.
  useEffect(() => {
    if (user?.pubkey !== lastAppliedPubkey.current) {
      lastAppliedPubkey.current = undefined;
    }
  }, [user?.pubkey]);

  // ─── 1. Armada encrypted settings → local config ─────────────────────
  useEffect(() => {
    if (!user?.pubkey || !settings) return;
    if (lastAppliedPubkey.current === user.pubkey) return;

    const remoteTs = settings.lastSync ?? 0;
    const localTs = Math.max(getLocalSettingsSync(user.pubkey), getLastSettingsWrite());

    if (remoteTs <= localTs) {
      lastAppliedPubkey.current = user.pubkey;
      return;
    }

    updateConfig((current) => ({
      ...current,
      ...(settings.theme !== undefined ? { theme: settings.theme } : {}),
      ...(settings.customTheme !== undefined ? { customTheme: settings.customTheme } : {}),
      ...(settings.themes !== undefined ? { themes: settings.themes } : {}),
    }));

    setLocalSettingsSync(user.pubkey, remoteTs);
    lastAppliedPubkey.current = user.pubkey;
  }, [user?.pubkey, settings, updateConfig]);

  // ─── 2. Ditto active profile theme fallback (first-time Armada users) ─
  useEffect(() => {
    if (!user?.pubkey) return;
    if (dittoCheckedPubkey.current === user.pubkey) return;

    // Only adopt the Ditto theme if the user has no Armada theme yet:
    // never synced Armada settings AND still on the untouched default.
    const hasArmadaSettings =
      getLocalSettingsSync(user.pubkey) > 0 || (settings && (settings.lastSync ?? 0) > 0);
    const usingDefault = config.theme === "dark" && !config.customTheme;
    if (hasArmadaSettings || !usingDefault) {
      dittoCheckedPubkey.current = user.pubkey;
      return;
    }

    dittoCheckedPubkey.current = user.pubkey;
    let cancelled = false;

    (async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [ACTIVE_THEME_KIND], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(6000) },
        );
        const event = events.sort((a, b) => b.created_at - a.created_at)[0];
        if (!event || cancelled) return;
        const theme = parseDittoTheme(event);
        if (theme && !cancelled) {
          applyCustomTheme({ title: theme.title, colors: theme.colors });
        }
      } catch {
        // No Ditto theme / relay error — keep Armada's default.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.pubkey, settings, config.theme, config.customTheme, nostr, applyCustomTheme]);

  return null;
}
