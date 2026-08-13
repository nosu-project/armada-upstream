import { useDm17ForegroundSync } from "@/hooks/useDm17";

/** One app-wide owner for NIP-17 foreground/reconnect recovery. */
export function DmSyncLifecycle() {
  useDm17ForegroundSync();
  return null;
}
