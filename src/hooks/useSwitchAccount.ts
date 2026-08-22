import { useNostrLogin } from "@nostrify/react/login";
import { useCallback, useMemo } from "react";

import { signOutAccount, switchAccount } from "@/lib/switchAccount";

interface UseSwitchAccountReturn {
  /** Make `id` the active account, then reload. */
  switchTo: (id: string) => void;
  /** Sign `id` out with other accounts remaining, then reload. */
  signOut: (id: string) => void;
}

/**
 * The one way to change WHICH account is active.
 *
 * Every path that moves a different login into `logins[0]` must go through
 * this rather than `setLogin`/`removeLogin`, so that the reload in
 * `switchAccount` is not something a new call site can forget. Initial signup
 * may stay in-place only while there is no outgoing account; adding an
 * identity while one is active uses the same cleanup + reload fence.
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
