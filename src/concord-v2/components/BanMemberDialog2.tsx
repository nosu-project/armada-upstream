import { Ban, Check, Loader2 } from "lucide-react";
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
import type { BanPhase } from "@/concord-v2/hooks/useModeration2";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";

interface BanMemberDialogProps {
  /** The pubkeys queued for banning; null keeps the dialog closed. */
  targets: string[] | null;
  /** Selected members the actor can't act on — shown as skipped, never sent. */
  ineligible?: string[];
  /** Whether this ban will also rotate the community keys (Private mode). */
  willRotate: boolean;
  onClose: () => void;
  /** Runs the full ban; reports each step as it starts. Throws on failure. */
  onConfirm: (
    targets: string[],
    onPhase: (phase: BanPhase) => void,
    onStripProgress: (done: number, total: number) => void,
  ) => Promise<void>;
}

const PHASE_ORDER: Record<BanPhase, number> = { silence: 0, roles: 1, rekey: 2 };

/**
 * Ban confirmation + progress, single member or a whole selection. The ban is
 * several sequential publishes (ONE banlist edition for the group, per-member
 * grant strips, and in a Private community ONE whole-group Refounding, which
 * can take seconds), so the dialog stays up and walks its step list until
 * everything lands — closing mid-flight would read as "banned" while the
 * severance is still in the air.
 */
export function BanMemberDialog({ targets, ineligible, willRotate, onClose, onConfirm }: BanMemberDialogProps) {
  const [phase, setPhase] = useState<BanPhase | null>(null);
  const [strip, setStrip] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Signer calls (a bunker blob-wrap) carry no timeout of their own; a dead
  // signer would otherwise wedge the dialog un-dismissable. After a grace
  // period, re-enable Cancel so the user is never trapped (the operation, if
  // it ever lands, is idempotent and self-heals via the read-cut retry).
  const [stuck, setStuck] = useState(false);
  const busy = phase !== null;
  const count = targets?.length ?? 0;
  const single = count === 1 ? targets?.[0] : undefined;

  // A fresh selection is a fresh flow.
  useEffect(() => {
    setPhase(null);
    setStrip(null);
    setError(null);
    setStuck(false);
  }, [targets]);

  // Grace timer: while busy, arm a fallback that lets the user bail out.
  useEffect(() => {
    if (!busy) {
      setStuck(false);
      return;
    }
    const t = setTimeout(() => setStuck(true), 30_000);
    return () => clearTimeout(t);
  }, [busy]);

  const steps: Array<{ key: BanPhase; label: string }> = [
    { key: "silence", label: count > 1 ? "Blocking members" : "Blocking member" },
    {
      key: "roles",
      label:
        strip && strip.total > 1
          ? `Removing their roles (${strip.done}/${strip.total})`
          : "Removing their roles",
    },
    ...(willRotate ? [{ key: "rekey" as BanPhase, label: "Locking them out" }] : []),
  ];

  const run = async () => {
    if (!targets || targets.length === 0) return;
    setError(null);
    setPhase("silence");
    try {
      await onConfirm(targets, setPhase, (done, total) => setStrip({ done, total }));
      setPhase(null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't ban.");
      setPhase(null);
    }
  };

  const close = () => {
    if (busy && !stuck) return;
    setPhase(null);
    setStrip(null);
    setError(null);
    setStuck(false);
    onClose();
  };

  return (
    <Dialog open={targets !== null && targets.length > 0} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {single ? (
              <>
                Ban <TargetName pubkey={single} />?
              </>
            ) : (
              <>Ban {count} members?</>
            )}
          </DialogTitle>
          <DialogDescription>
            They will be removed and silenced for everyone in this community.
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

        {busy && (
          <ul className="space-y-1.5 text-sm" aria-live="polite">
            {steps.map((step) => {
              const state =
                PHASE_ORDER[phase] > PHASE_ORDER[step.key]
                  ? "done"
                  : phase === step.key
                    ? "active"
                    : "pending";
              return (
                <li key={step.key} className="flex items-center gap-2">
                  {state === "done" ? (
                    <Check className="size-4 text-success" />
                  ) : state === "active" ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <span className="size-4 rounded-full border border-muted-foreground/40" />
                  )}
                  <span className={state === "pending" ? "text-muted-foreground" : undefined}>
                    {step.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        {stuck && busy && (
          <p className="text-sm text-muted-foreground">
            This is taking longer than expected. Your signer may be slow or offline. You can close this
            and try again; anything already sent will finish on its own.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy && !stuck}>
            {busy && stuck ? "Close" : "Cancel"}
          </Button>
          <Button type="button" variant="destructive" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
            {busy ? "Banning" : count > 1 ? `Ban ${count} members` : "Ban member"}
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
