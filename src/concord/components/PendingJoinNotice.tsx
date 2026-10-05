import { Loader2, RotateCw, UserX } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { PendingJoinState } from "@/concord/hooks/usePendingGuestbookJoin";

/** A signer this quick never surfaces the notice. */
const SIGNING_NOTICE_DELAY_MS = 1500;

/**
 * The member's Guestbook Join hasn't reached a relay, so nobody else lists them
 * (CORD-02 §5). Said plainly, since nothing else in the room shows it.
 */
export function PendingJoinNotice({ state, onRetry }: { state: PendingJoinState | undefined; onRetry: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (state !== "signing") return;
    const t = setTimeout(() => setSlow(true), SIGNING_NOTICE_DELAY_MS);
    return () => clearTimeout(t);
  }, [state]);

  if (!state || state === "sending" || (state === "signing" && !slow)) return null;
  const signing = state === "signing";
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs border-t border-warning/20 bg-warning/10 text-warning">
      {signing ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <UserX className="size-4 shrink-0" />}
      <span className="flex-1 min-w-0">
        {signing
          ? "Finishing your join: waiting for your signer to approve it. Other members won't see you until it does."
          : "Other members can't see you here yet: your join hasn't been signed or reached the community's relays. Armada keeps retrying."}
      </span>
      {!signing && (
        <Button variant="secondary" size="sm" className="h-7 px-2.5 shrink-0 clip-corner-lg" onClick={onRetry}>
          <RotateCw className="size-3.5" />
          Retry
        </Button>
      )}
    </div>
  );
}
