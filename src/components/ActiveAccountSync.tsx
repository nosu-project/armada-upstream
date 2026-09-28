import { useNostrLogin } from "@nostrify/react/login";
import { useEffect } from "react";

import { setActivePubkey } from "@/lib/activeAccount";

/**
 * Mirror the active pubkey into the synchronous `activeAccount` marker, read by
 * `AppProvider` above `NostrLoginProvider` (see `lib/activeAccount.ts`). An
 * effect, not part of the switch path, so it also tracks cold boots, signup and logout.
 */
export function ActiveAccountSync() {
  const { logins } = useNostrLogin();
  const pubkey = logins[0]?.pubkey ?? null;

  useEffect(() => {
    setActivePubkey(pubkey);
  }, [pubkey]);

  return null;
}
