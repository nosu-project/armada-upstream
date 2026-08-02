import { Loader2, UserMinus } from "lucide-react";
import { useEffect, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";

export interface KickResult {
  kicked: string[];
  failed: { target: string; message: string }[];
  skipped: string[];
}

interface KickMembersDialogProps {
  /** The pubkeys queued for kicking; null keeps the dialog closed. */
  targets: string[] | null;
  /** Selected members the actor can't act on — shown as skipped, never sent. */
  ineligible?: string[];
  onClose: () => void;
  /** Runs the batch; reports progress per member. Throws only if nothing landed. */
  onConfirm: (targets: string[], onProgress: (done: number, total: number) => void) => Promise<KickResult>;
}

/**
 * Kick confirmation + per-member progress. A kick is per-target on the wire
 * (strip, then the Guestbook directive — no batch form exists), so a mass kick
 * runs sequentially and the dialog reports how far it got. Partial success is
 * shown, not hidden: 9 of 10 landing beats aborting at #2, and the failures
 * are listed for a retry.
 */
export function KickMembersDialog({ targets, ineligible, onClose, onConfirm }: KickMembersDialogProps) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<{ target: string; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;
  const count = targets?.length ?? 0;
  const single = count === 1 ? targets?.[0] : undefined;

  useEffect(() => {
    setProgress(null);
    setFailures([]);
    setError(null);
  }, [targets]);

  const run = async () => {
    // A retry resends ONLY what failed — the rest already left the guestbook.
    const batch = failures.length > 0 ? failures.map((f) => f.target) : targets;
    if (!batch || batch.length === 0) return;
    setError(null);
    setFailures([]);
    setProgress({ done: 0, total: batch.length });
    try {
      const result = await onConfirm(batch, (done, total) => setProgress({ done, total }));
      setProgress(null);
      if (result.failed.length > 0) {
        // Stay open: the partial outcome is the information.
        setFailures(result.failed);
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't kick.");
      setProgress(null);
    }
  };

  const close = () => {
    if (busy) return;
    setProgress(null);
    setFailures([]);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={targets !== null && targets.length > 0} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {single ? (
              <>
                Kick <TargetName pubkey={single} />?
              </>
            ) : (
              <>Kick {count} members?</>
            )}
          </DialogTitle>
          <DialogDescription>
            A kick removes them from the member list but doesn't block them — they can rejoin from an
            invite. Use Ban to keep someone out.
          </DialogDescription>
        </DialogHeader>

        {count > 1 && targets && (
          <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
            {targets.map((pk) => (
              <TargetRow key={pk} pubkey={pk} />
            ))}
          </ul>
        )}
        {ineligible && ineligible.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {ineligible.length} selected member{ineligible.length === 1 ? " is" : "s are"} skipped — you
            don't outrank them.
          </p>
        )}

        {busy && progress && (
          <p className="flex items-center gap-2 text-sm" aria-live="polite">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            Kicking {Math.min(progress.done + 1, progress.total)} of {progress.total}…
          </p>
        )}

        {failures.length > 0 && (
          <div className="space-y-1 text-sm">
            <p className="text-destructive">
              {failures.length} kick{failures.length === 1 ? "" : "s"} didn't land:
            </p>
            <ul className="max-h-32 space-y-1 overflow-y-auto">
              {failures.map((f) => (
                <li key={f.target} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <TargetName pubkey={f.target} />
                  <span className="truncate">{f.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy}>
            {failures.length > 0 ? "Close" : "Cancel"}
          </Button>
          <Button type="button" variant="destructive" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <UserMinus className="size-4" />}
            {busy
              ? "Kicking"
              : failures.length > 0
                ? "Retry failed"
                : count > 1
                  ? `Kick ${count} members`
                  : "Kick member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TargetName({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <DisplayName pubkey={pubkey} name={name} />;
}

function TargetRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <li className="flex items-center gap-2">
      <Avatar className="size-5 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-[9px] text-primary">
          {name[0]?.toUpperCase() ?? "?"}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">
        <DisplayName pubkey={pubkey} name={name} />
      </span>
    </li>
  );
}
