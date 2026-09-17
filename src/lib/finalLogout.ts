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

/** Wrap a navigation so the deadline and the teardown can both call it, once. */
function navigateOnce(destination: string): () => void {
  let went = false;
  return () => {
    if (went) return;
    went = true;
    window.location.assign(destination);
  };
}

/**
 * Sign the LAST account out: wipe every trace of it and land on the login
 * screen. The counterpart to `signOutAccount`/`persistAndReload`, which handle
 * an exit that leaves other accounts mounted.
 *
 * The design point is that the reload is a GUARANTEE, not a consequence of
 * teardown finishing. Two things make it one:
 *
 *  - The logged-out state is made durable UP FRONT — the login list is written
 *    empty directly (as `persistAndReload` does, and for the same reason:
 *    `removeLogin` dispatches a reducer that persists from an effect, which a
 *    reload can tear down mid-flight and resurrect the session). So a reload
 *    triggered by the deadline below, before purge even runs, still boots
 *    logged out.
 *  - Navigation fires on an absolute {@link EXIT_NAV_DEADLINE_MS} deadline no
 *    matter what the teardown does. That is what a native `wipe()` bridge that
 *    never answers can no longer hang forever on, and it caps the whole
 *    operation whatever else stalls. The teardown races it and, on the happy
 *    path, wins — navigating the moment purge resolves.
 *
 * Everything between is best-effort and reported to the exit overlay as it
 * runs, so the wait names what it is doing.
 */
export async function finalLogout(pubkey: string | null): Promise<void> {
  // Instant feedback, before any await.
  beginAccountExit("logout", pubkey ?? "");
  const go = navigateOnce("/");
  // The backstop: navigate on the deadline regardless of the teardown below.
  const deadline = setTimeout(go, EXIT_NAV_DEADLINE_MS);

  // The removed account's secrets and in-memory plaintext must not outlive it
  // (the broad purge below only runs on this final logout).
  if (pubkey) {
    clearWalletStorage(pubkey);
    clearEsploraStorage(pubkey);
  }
  clearRenderedPlaintext();

  // Make the logout durable before the deadline can fire. purgeClientStorage
  // preserves `armada:login`, so an empty list written here survives the purge
  // and there is no reducer dispatch to race the reload.
  try {
    await secureStorage.setItem(LOGIN_STORAGE_KEY, "[]");
  } catch {
    // A failed write means a reload might land back on the account. Nothing
    // more this side can do; the purge below still strips its data.
  }
  setActivePubkey(null);

  // Fence other tabs, then give the notification controllers their bounded
  // window BEFORE purge erases the durable prune ids they need.
  beginCrossTabAccountExit(pubkey, null);
  exitStep("teardown", "closing secure channel");
  try {
    await runBeforeAccountExit("final-logout", EXIT_TEARDOWN_MS);
  } catch {
    // best-effort; runBeforeAccountExit swallows its own, but belt-and-braces
  }

  exitStep("purge", "purging local vault");
  try {
    await purgeClientStorage(pubkey);
  } catch {
    // best-effort — the deadline still navigates
  }

  exitDone("signed off");
  clearTimeout(deadline);
  go();
}
