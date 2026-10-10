import { useNostr } from "@nostrify/react";
import { useEffect, useRef } from "react";

import { accountDataRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  markNotificationSettingsReady,
  notificationSettingsReady,
  useNotificationSettingsReady,
} from "@/lib/notificationSettingsAuthority";
import { proveNotificationSettingsAbsence } from "@/lib/notificationSettingsProof";
import { useSettingsKeys } from "@/hooks/useSettingsKeys";

/** Delays between attempts; the first leaves a fresh login's own pass room to finish. */
const RETRY_MS = [10_000, 60_000, 5 * 60_000, 15 * 60_000];
const ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * Finish the notifications-settings absence proof when the login pass couldn't
 * (`useInitialSync` runs only after a fresh login and cuts slow relays off), so
 * one offline or slow first login doesn't leave notifications unconfigured for
 * good. A document found here is left to `useConfigDocSync`, which marks ready
 * once it has applied it.
 */
export function useNotificationSettingsAbsenceProof(): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const ready = useNotificationSettingsReady(user?.pubkey);
  const automaticSettingsSync = config.automaticSettingsSync !== false;
  const configRef = useRef(config);
  configRef.current = config;
  const { keys } = useSettingsKeys();
  const derivedRef = useRef(keys.keyring?.settings.notifications);
  derivedRef.current = keys.keyring?.settings.notifications;

  const pubkey = user?.pubkey;
  const nip44 = user?.signer.nip44;
  useEffect(() => {
    if (!pubkey || !nip44 || ready || !automaticSettingsSync) return;
    let cancelled = false;
    let running = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (cancelled) return;
      clearTimeout(timer);
      timer = setTimeout(run, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
    };

    async function run() {
      if (cancelled || running || notificationSettingsReady(pubkey)) return;
      // `online` re-runs it; no point burning an attempt.
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      running = true;
      try {
        const verdict = await proveNotificationSettingsAbsence(
          nostr,
          accountDataRelays(configRef.current, pubkey),
          pubkey!,
          (ciphertext) => nip44!.decrypt(pubkey!, ciphertext),
          AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
          derivedRef.current,
        );
        if (cancelled) return;
        if (verdict === "absent") {
          markNotificationSettingsReady(pubkey);
          return;
        }
        if (verdict === "present") return;
      } catch {
        // An unanswered read is "unknown": retry below.
      } finally {
        running = false;
      }
      schedule();
    }

    const onOnline = () => void run();
    window.addEventListener("online", onOnline);
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [nostr, pubkey, nip44, ready, automaticSettingsSync]);
}
