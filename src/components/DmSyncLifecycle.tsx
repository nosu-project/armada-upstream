import { useDm17ForegroundSync, useDm17HistoryWalk } from "@/hooks/useDm17";

/** One app-wide owner for NIP-17 foreground/reconnect recovery and the history walk. */
export function DmSyncLifecycle() {
  useDm17ForegroundSync();
  useDm17HistoryWalk();
  return null;
}
