/**
 * Publish timeout budget by signer (#51). NIP-42 AUTH can require a sign
 * mid-publish; with a remote NIP-46 bunker each sign is its own round-trip,
 * which routinely exceeds 8s on lossy links.
 */

/** Default publish budget for local (nsec/extension) signers. */
const LOCAL_TIMEOUT_MS = 8_000;
/** Budget when signing rides a remote NIP-46 bunker round-trip. */
const REMOTE_TIMEOUT_MS = 30_000;

/**
 * Timeout for a `NUser["method"]`. Unknown methods get the remote budget:
 * timing out a slow success is worse than waiting on a dead one.
 */
export function publishTimeoutMs(method: string | undefined): number {
  if (method === "nsec" || method === "extension") return LOCAL_TIMEOUT_MS;
  return REMOTE_TIMEOUT_MS;
}
