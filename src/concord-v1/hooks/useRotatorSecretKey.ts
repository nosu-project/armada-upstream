import { useNostrLogin } from "@nostrify/react/login";
import { nip19 } from "nostr-tools";
import { useMemo } from "react";

/**
 * The current user's RAW identity secret key (hex), available only for local
 * `nsec` logins. Concord rekey (channel/server-root rotation) needs the raw key
 * to mint per-recipient ECDH blobs — a NIP-46 bunker or extension signer only
 * signs and cannot perform the rotation. Returns `undefined` for those, which
 * is the same constraint Vector enforces ("bunker can't rekey").
 */
export function useRotatorSecretKey(): string | undefined {
  const { logins } = useNostrLogin();
  return useMemo(() => {
    const login = logins[0];
    if (!login || login.type !== "nsec") return undefined;
    try {
      const decoded = nip19.decode(login.data.nsec) as { type: "nsec"; data: Uint8Array };
      return [...decoded.data].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return undefined;
    }
  }, [logins]);
}
