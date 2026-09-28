import { useNostrLogin } from "@nostrify/react/login";
import { useCallback, useMemo } from "react";

import { signOutAccount, switchAccount } from "@/lib/switchAccount";

interface UseSwitchAccountReturn {
  switchTo: (id: string) => void;
  signOut: (id: string) => void;
}

/**
 * The one way to change the active account, so the reload in `switchAccount` can't be
 * forgotten. Initial signup may stay in place only when there's no outgoing account.
 */
export function useSwitchAccount(): UseSwitchAccountReturn {
  const { logins } = useNostrLogin();

  const switchTo = useCallback(
    (id: string) => {
      void switchAccount(logins, id);
    },
    [logins],
  );

  const signOut = useCallback(
    (id: string) => {
      void signOutAccount(logins, id);
    },
    [logins],
  );

  return useMemo(() => ({ switchTo, signOut }), [switchTo, signOut]);
}
