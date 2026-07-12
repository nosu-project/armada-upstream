import { useCurrentUser } from "@/hooks/useCurrentUser";
import { readEsploraApis } from "@/lib/esploraStorage";

/** Returns the current user's configured Esplora API endpoints (or defaults). */
export function useEsploraApis(): string[] {
  const { user } = useCurrentUser();
  return readEsploraApis(user?.pubkey);
}
