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
 * `switchAccount` is not something a new call site can forget. The one path
 * that must NOT use it is signup/add-account (`addAndActivate`), which
 * activates a key mid-wizard and has to keep running afterwards — a reload
 * there would abandon the wizard's remaining steps, so the storage scoping has
 * to stand on its own regardless.
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
