import { canPeekDecryptCache } from "@/lib/AppSigner";
import { ensureDecryptConsent, getDecryptConsent } from "@/lib/decryptConsent";

import type { NostrSigner } from "@nostrify/nostrify";

/** One decrypt's inputs, for the cache-peek. */
export interface DecryptTarget {
  counterparty: string;
  ciphertext: string;
}

/**
 * Decide whether a batch of signer decrypts may proceed without flooding the
 * signer: yes if the signer can't prompt (local nsec), consent is already
 * allowed, or every target is cached; otherwise ask the one-time app-wide
 * consent gate. On false, callers leave encrypted placeholders with manual
 * "Decrypt" affordances.
 */
export async function mayBulkDecrypt(
  signer: NostrSigner,
  method: "nip04" | "nip44",
  targets: DecryptTarget[],
  needsApproval: boolean,
): Promise<boolean> {
  if (targets.length === 0) return true;
  if (!needsApproval) return true;
  if (getDecryptConsent() === "allowed") return true;
  if (getDecryptConsent() === "declined" && (await allCached(signer, method, targets))) return true;
  if (getDecryptConsent() === "declined") return false;

  // Undecided: if the whole batch is cached, proceed without ever asking.
  if (await allCached(signer, method, targets)) return true;

  return (await ensureDecryptConsent()) === "allowed";
}

/** Whether every target's plaintext is already cached (no signer round-trip). */
async function allCached(signer: NostrSigner, method: "nip04" | "nip44", targets: DecryptTarget[]): Promise<boolean> {
  if (!canPeekDecryptCache(signer)) return false;
  for (const t of targets) {
    if (!(await signer.isDecryptCached(method, t.counterparty, t.ciphertext))) return false;
  }
  return true;
}

/** Whether a login's signer may prompt per decrypt (bunker/extension/unknown; not local nsec). */
export function signerNeedsApproval(method: string | undefined): boolean {
  return method !== "nsec";
}
