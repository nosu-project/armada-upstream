import { useNostrLogin } from "@nostrify/react/login";

import { useCurrentUser } from "@/hooks/useCurrentUser";

/** The active account's nsec, when this client holds it. */
export function useActiveNsec(): { nsec: string; pubkey: string } | undefined {
  const { user } = useCurrentUser();
  const { logins } = useNostrLogin();
  const login = logins[0];
  if (!user || login?.type !== "nsec" || login.pubkey !== user.pubkey) return undefined;
  return { nsec: login.data.nsec, pubkey: login.pubkey };
}
