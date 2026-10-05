import { KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";

interface RotateKeysDialogProps {
  open: boolean;
  memberCount: number;
  privateChannelCount: number;
  /** A live invite link belongs to someone else (it goes stale). */
  strandsForeignLinks: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

/** Standalone rotation (Refounding excluding nobody). Stays up while it runs; 30s grace re-enables Cancel. */
export function RotateKeysDialog({
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
      <ChromeDialogContent title="Rotate this community's keys?" className="sm:max-w-sm">
        <ChromeDialogHeader
          icon={KeyRound}
          tone="warning"
          title="rotate keys?"
          description="New messages are encrypted to new keys. Old keys still read the history they already unlocked, and nothing after."
        />

        <ul className="mt-5 space-y-1 text-sm text-muted-foreground">
          <li>
            {memberCount === 1 ? "1 member keeps" : `${memberCount} members keep`} access. Nobody is
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
          <p className="mt-3 text-sm text-destructive">
            Invite links created by other members will hand out dead keys until those members next
            open the app. Only their creator can refresh them.
          </p>
        )}

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        {stuck && busy && (
          <p className="mt-3 text-sm text-muted-foreground">
            This is taking longer than expected. Your signer may be slow or offline. You can close
            this and try again. A rotation that already landed is picked up automatically.
          </p>
        )}

        <ChromeDialogFooter>
          <Button type="button" variant="ghost" onClick={close} disabled={busy && !stuck}>
            {busy && stuck ? "Close" : "Cancel"}
          </Button>
          <Button type="button" variant="destructive" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            {busy ? "Rotating" : "Rotate keys"}
          </Button>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}
