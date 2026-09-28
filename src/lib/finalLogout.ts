import {
  beginAccountExit,
  exitDone,
  exitStep,
} from "@/components/accountExitState";
import { clearRenderedPlaintext } from "@/hooks/dmRenderCache";
import { setActivePubkey } from "@/lib/activeAccount";
import {
  EXIT_NAV_DEADLINE_MS,
  EXIT_TEARDOWN_MS,
  runBeforeAccountExit,
} from "@/lib/beforeAccountExit";
import { beginCrossTabAccountExit } from "@/lib/crossTabAccountExit";
import { clearEsploraStorage } from "@/lib/esploraStorage";
import { purgeClientStorage } from "@/lib/purgeClientStorage";
import { secureStorage } from "@/lib/secureStorage";
import { LOGIN_STORAGE_KEY } from "@/lib/switchAccount";
import { clearWalletStorage } from "@/lib/walletStorage";

/** Callable by both the deadline and the teardown; navigates once. */
function navigateOnce(destination: string): () => void {
  let went = false;
  return () => {
    if (went) return;
    went = true;
    window.location.assign(destination);
  };
}

/**
 * Sign the LAST account out: wipe everything and land on login. The reload is
 * guaranteed: the empty login list is written up front (so an early reload
 * boots logged out), and navigation fires on {@link EXIT_NAV_DEADLINE_MS}
 * regardless of teardown (e.g. a native `wipe()` that never answers).
 */
export async function finalLogout(pubkey: string | null): Promise<void> {
  beginAccountExit("logout", pubkey ?? "");
  const go = navigateOnce("/");
  const deadline = setTimeout(go, EXIT_NAV_DEADLINE_MS);

  // The broad purge below only runs on final logout, so clear this account's secrets explicitly.
  if (pubkey) {
    clearWalletStorage(pubkey);
    clearEsploraStorage(pubkey);
  }
  clearRenderedPlaintext();

  // purgeClientStorage preserves `armada:login`, so this survives the purge.
  try {
    await secureStorage.setItem(LOGIN_STORAGE_KEY, "[]");
  } catch { /* ignore */ }
  setActivePubkey(null);

  // Notification controllers must run before purge erases the push client key
  // they clear with.
  beginCrossTabAccountExit(pubkey, null);
  exitStep("teardown", "closing secure channel");
  try {
    await runBeforeAccountExit("final-logout", EXIT_TEARDOWN_MS);
  } catch { /* ignore */ }

  exitStep("purge", "purging local vault");
  try {
    await purgeClientStorage();
  } catch {
    // best-effort — the deadline still navigates
  }

  exitDone("signed off");
  clearTimeout(deadline);
  go();
}
