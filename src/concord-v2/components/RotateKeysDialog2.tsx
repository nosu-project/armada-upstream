import { KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface RotateKeysDialogProps {
  open: boolean;
  /** Members carried into the new epoch — the keep-list this will rotate to. */
  memberCount: number;
  /** Private channels that rotate alongside the community root. */
  privateChannelCount: number;
  /** Whether a live invite link belongs to someone else (it goes stale). */
  strandsForeignLinks: boolean;
  onClose: () => void;
  /** Runs the rotation. Throws on failure; the message is shown inline. */
  onConfirm: () => Promise<void>;
}

/**
 * Confirmation for the standalone key rotation (a Refounding with nobody
 * excluded). Like the ban dialog it stays up for the duration rather than
 * firing and closing: the rotation is an exhaustive control-plane sweep, a
 * root roll, a re-wrap of every control head and a rekey per private channel,
 * which takes seconds and can fail partway with something the staffer needs to
 * read. The same 30s grace timer re-enables Cancel so a dead signer can't
 * trap them.
 */
export function RotateKeysDialog2({
  open,
  memberCount,
  privateChannelCount,
  strandsForeignLinks,
  onClose,
  onConfirm,
}: RotateKeysDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);

  // A fresh open is a fresh attempt.
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setStuck(false);
  }, [open]);

  useEffect(() => {
    if (!busy) {
      setStuck(false);
      return;
    }
    const t = setTimeout(() => setStuck(true), 30_000);
    return () => clearTimeout(t);
  }, [busy]);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
      setBusy(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't rotate the keys.");
      setBusy(false);
    }
  };

  const close = () => {
    if (busy && !stuck) return;
    setBusy(false);
    setError(null);
    setStuck(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rotate this community's keys?</DialogTitle>
          <DialogDescription>
            Every message from here on is encrypted to new keys. The old keys still read the history
            they already unlocked, but they read nothing new.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1 text-sm text-muted-foreground">
          <li>
            {memberCount === 1 ? "1 member keeps" : `${memberCount} members keep`} access — nobody is
            removed.
          </li>
          {privateChannelCount > 0 && (
            <li>
              {privateChannelCount === 1
                ? "1 private channel is rekeyed"
                : `${privateChannelCount} private channels are rekeyed`}{" "}
              alongside it.
            </li>
          )}
          <li>
            Anyone offline stays out until their app picks up the new keys. Someone who never picks
            them up needs a fresh invite.
          </li>
        </ul>

        {strandsForeignLinks && (
          <p className="text-sm text-destructive">
            Invite links created by other members will hand out dead keys until those members next
            open the app. Only their creator can refresh them.
          </p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        {stuck && busy && (
          <p className="text-sm text-muted-foreground">
            This is taking longer than expected. Your signer may be slow or offline. You can close
            this and try again — a rotation that already landed is picked up on its own.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy && !stuck}>
            {busy && stuck ? "Close" : "Cancel"}
          </Button>
          <Button type="button" variant="destructive" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            {busy ? "Rotating" : "Rotate keys"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
