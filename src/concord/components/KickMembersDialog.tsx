import { Loader2, UserMinus } from "lucide-react";
import { useEffect, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";

export interface KickResult {
  kicked: string[];
  failed: { target: string; message: string }[];
  skipped: string[];
}

interface KickMembersDialogProps {
  targets: string[] | null;
  /** Members the actor can't act on — shown as skipped, never sent. */
  ineligible?: string[];
  onClose: () => void;
  /** Throws only if nothing landed. */
  onConfirm: (targets: string[], onProgress: (done: number, total: number) => void) => Promise<KickResult>;
}

/** Kick confirmation. Kicks are per-target on the wire, so they run sequentially and partial success is shown. */
export function KickMembersDialog({ targets, ineligible, onClose, onConfirm }: KickMembersDialogProps) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<{ target: string; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;
  const count = targets?.length ?? 0;

  useEffect(() => {
    setProgress(null);
    setFailures([]);
    setError(null);
  }, [targets]);

  const run = async () => {
    // Retry resends ONLY failures.
    const batch = failures.length > 0 ? failures.map((f) => f.target) : targets;
    if (!batch || batch.length === 0) return;
    setError(null);
    setFailures([]);
    setProgress({ done: 0, total: batch.length });
    try {
      const result = await onConfirm(batch, (done, total) => setProgress({ done, total }));
      setProgress(null);
      if (result.failed.length > 0) {
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
      <ChromeDialogContent
        title={count > 1 ? "Kick members" : "Kick member"}
        className="sm:max-w-sm focus:outline-none"
        onOpenAutoFocus={(e) => {
          // Keep initial focus off Cancel (paints a ring on open); focus stays trapped.
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-destructive/15 text-destructive">
            <UserMinus className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            {count > 1 ? `kick ${count} members?` : "kick member?"}
          </h2>
          <p className="text-sm text-muted-foreground">
            A kick removes them from the member list but doesn't block them. They can rejoin from an
            invite, so use Ban to keep someone out.
          </p>
        </div>

        {targets && targets.length > 0 && (
          <ul className="mt-5 max-h-40 space-y-1 overflow-y-auto text-sm">
            {targets.map((pk) => (
              <TargetRow key={pk} pubkey={pk} />
            ))}
          </ul>
        )}
        {ineligible && ineligible.length > 0 && (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {ineligible.length} selected member{ineligible.length === 1 ? " is" : "s are"} skipped. You
            don't outrank them.
          </p>
        )}

        {busy && progress && (
          <p className="mt-4 flex items-center justify-center gap-2 text-sm" aria-live="polite">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            Kicking {Math.min(progress.done + 1, progress.total)} of {progress.total}…
          </p>
        )}

        {failures.length > 0 && (
          <div className="mt-4 space-y-1 text-sm">
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

        {error && <p className="mt-4 text-center text-sm text-destructive">{error}</p>}

        <div className="mt-6 flex items-center gap-2">
          <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={close} disabled={busy}>
            {failures.length > 0 ? "Close" : "Cancel"}
          </Button>
          <Button type="button" variant="destructive" className="flex-1 clip-corner-lg" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <UserMinus className="size-4" />}
            {busy
              ? "Kicking"
              : failures.length > 0
                ? "Retry failed"
                : count > 1
                  ? `Kick ${count} members`
                  : "Kick member"}
          </Button>
        </div>
      </ChromeDialogContent>
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
        <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
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
