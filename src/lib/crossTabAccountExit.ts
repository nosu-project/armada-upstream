import { ACTIVE_PUBKEY_KEY } from "@/lib/activeAccount";

/** Pre-teardown origin-wide epoch; written before any shared push mutation. */
export const ACCOUNT_EXIT_EPOCH_KEY = "armada:account-exit-epoch:v1";
const LOCAL_ACCOUNT_EXIT_EVENT = "armada-account-exit";

export interface AccountExitEpoch {
  id: string;
  fromPubkey: string;
  toPubkey: string | null;
}

export interface CrossTabAccountExitOptions {
  pubkey: string;
  /** Must synchronously stop every writer before this callback returns. */
  fence: () => void;
  reload?: () => void;
}

function parseEpoch(value: unknown): AccountExitEpoch | undefined {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object") return undefined;
    const epoch = parsed as Partial<AccountExitEpoch>;
    if (
      typeof epoch.id !== "string"
      || typeof epoch.fromPubkey !== "string"
      || (epoch.toPubkey !== null && typeof epoch.toPubkey !== "string")
    ) return undefined;
    return epoch as AccountExitEpoch;
  } catch {
    return undefined;
  }
}

/**
 * Fence every same-origin tab before the leader starts shared cleanup (local
 * CustomEvent for this tab, storage event for others). Followers never run
 * destructive teardown; they wait for the active-account marker and reload.
 */
export function beginCrossTabAccountExit(
  fromPubkey: string | null | undefined,
  toPubkey: string | null,
): AccountExitEpoch | undefined {
  if (!fromPubkey || fromPubkey === toPubkey) return undefined;
  const epoch: AccountExitEpoch = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    fromPubkey,
    toPubkey,
  };
  try {
    localStorage.setItem(ACCOUNT_EXIT_EPOCH_KEY, JSON.stringify(epoch));
  } catch {
    // Without storage, only this document is fenced.
  }
  window.dispatchEvent(new CustomEvent(LOCAL_ACCOUNT_EXIT_EVENT, { detail: epoch }));
  return epoch;
}

/**
 * Fence a stale tab: the exit epoch stops writers before the leader touches
 * the shared endpoint; the active marker then triggers a reload. Followers never
 * run beforeAccountExit handlers, so they can't clobber the incoming account.
 */
export function installCrossTabAccountExit(
  options: CrossTabAccountExitOptions,
): () => void {
  let fenced = false;
  let reloading = false;
  const fence = () => {
    if (fenced) return;
    fenced = true;
    options.fence();
  };
  const reload = () => {
    if (reloading) return;
    reloading = true;
    (options.reload ?? (() => window.location.assign("/")))();
  };
  const acceptEpoch = (epoch: AccountExitEpoch | undefined) => {
    if (!epoch || epoch.fromPubkey !== options.pubkey) return;
    fence();
  };
  const onLocal = (event: Event) => {
    acceptEpoch(parseEpoch((event as CustomEvent<unknown>).detail));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACCOUNT_EXIT_EPOCH_KEY) {
      acceptEpoch(parseEpoch(event.newValue));
      return;
    }
    if (event.key !== ACTIVE_PUBKEY_KEY || event.newValue === options.pubkey) return;
    // No preceding epoch (older tab): still fence and reload, never clean up.
    fence();
    reload();
  };
  window.addEventListener(LOCAL_ACCOUNT_EXIT_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LOCAL_ACCOUNT_EXIT_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}
