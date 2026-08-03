import { Loader2, Lock, Pin, ShieldCheck, X } from "lucide-react";

import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { VerifiedPin } from "@/concord-v2/lib/pins";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { shortTimeAgo } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

/** A pin as the bar renders it: verified, plus any locally-applied Edit. */
type BarPin = VerifiedPin & { staleEdit?: boolean };

/** Strip URLs to a paperclip for a compact preview. */
function previewText(content: string): string {
  return content.replace(/https?:\/\/\S+/g, "📎").trim() || "📎";
}

/**
 * One pin. Nothing is fetched: the author, the words and the time all come out
 * of the proof this row already verified, which is why a pin renders for a
 * member who holds none of the channel's history.
 */
function PinRow({
  pin,
  canUnpin,
  busy,
  onJump,
  onUnpin,
}: {
  pin: BarPin;
  canUnpin: boolean;
  busy: boolean;
  onJump?: (rumorId: string) => void;
  onUnpin: (rumorId: string) => void;
}) {
  const author = useAuthor(pin.author);
  const name = useScopedDisplayName(pin.author, author.data?.metadata);
  // Jump-to-context needs the epoch the message was written under; a member
  // who can't derive that address simply doesn't get the affordance (§7).
  const jumpable = Boolean(onJump);

  return (
    <div className="group/pin flex items-start gap-2 min-w-0 rounded-md px-2 py-1.5 hover:bg-secondary/60">
      <button
        type="button"
        disabled={!jumpable}
        onClick={() => onJump?.(pin.rumorId)}
        className={cn("flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left", !jumpable && "cursor-default")}
      >
        <span className="flex items-center gap-1.5 max-w-full">
          <span className="text-[11px] font-semibold text-primary truncate">
            <DisplayName pubkey={pin.author} name={name} />
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <ShieldCheck className="size-3 shrink-0 text-success" />
            </TooltipTrigger>
            <TooltipContent className="max-w-56 text-xs">
              Proven: this author signed exactly these words. Verified from the pin itself, with no
              history and no old keys.
            </TooltipContent>
          </Tooltip>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {shortTimeAgo(pin.createdAt)}
          </span>
          {pin.edited && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 text-[10px] text-muted-foreground">(edited)</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-56 text-xs">
                {pin.staleEdit
                  ? "The author revised this. You can read the revision; members who joined later still see the original until an admin refreshes the pin."
                  : "The author revised this, and the revision is proven for everyone."}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
        <span className="text-[12px] text-muted-foreground line-clamp-2 break-words">
          {previewText(pin.content)}
        </span>
      </button>
      {canUnpin && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="h-6 touch:h-9 shrink-0 px-2 touch:px-3 text-muted-foreground hover:text-primary"
              onClick={() => onUnpin(pin.rumorId)}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Unpin</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * The channel's pinned messages (CORD-04 §7), sliding open below the header.
 *
 * Every row shown here passed full verification, so the bar is a claim the
 * client can stand behind rather than a list of quotes. A private channel whose
 * pins were sealed under an epoch this member never held renders as locked
 * instead of empty — pins exist, they just aren't ours to read yet.
 */
export function PinnedBar2({
  open,
  pins,
  dark,
  canUnpin,
  isUnpinning,
  staleEdits,
  isRefreshingEdits,
  onRefreshEdits,
  onJump,
  onUnpin,
  onClose,
}: {
  open: boolean;
  pins: BarPin[];
  dark: boolean;
  canUnpin: boolean;
  isUnpinning: boolean;
  staleEdits: number;
  isRefreshingEdits: boolean;
  onRefreshEdits?: () => void;
  onJump?: (rumorId: string) => void;
  onUnpin: (rumorId: string) => void;
  onClose: () => void;
}) {
  const expanded = open && (pins.length > 0 || dark);

  return (
    <div
      className={cn(
        "shrink-0 mx-2 overflow-hidden transition-all duration-300 ease-in-out",
        expanded ? "mt-2 max-h-72 opacity-100" : "mt-0 max-h-0 opacity-0",
      )}
      aria-hidden={!expanded}
    >
      <div className="clip-corner-lg bg-chrome px-3 py-2.5">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            <Pin className="size-3 text-amber-500" />
            Pinned messages
            {pins.length > 0 && <span className="tabular-nums text-muted-foreground/60">{pins.length}</span>}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close pinned messages"
            className="size-6 touch:size-10 text-muted-foreground"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
        {staleEdits > 0 && onRefreshEdits && (
          // Informational, not an errand: the push happens on its own (§7
          // Edits). The manual trigger stays only so a curator who is watching
          // can skip the wait, or retry one that failed.
          <button
            type="button"
            disabled={isRefreshingEdits}
            onClick={onRefreshEdits}
            className="mb-1.5 flex w-full items-center gap-2 rounded-md bg-foreground/5 px-2 py-1.5 text-left text-[11px] text-muted-foreground disabled:opacity-60"
          >
            <Loader2 className={cn("size-3 shrink-0", isRefreshingEdits && "animate-spin")} />
            {isRefreshingEdits
              ? "Publishing the revision so later members see it too…"
              : `${staleEdits} pin${staleEdits === 1 ? "" : "s"} edited — publishing the revision shortly.`}
            {!isRefreshingEdits && <span className="ml-auto shrink-0 underline">Now</span>}
          </button>
        )}
        {dark && pins.length === 0 ? (
          <p className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
            <Lock className="size-3.5 shrink-0" />
            This channel has pins from before you joined. They were sealed with keys you don't hold —
            an admin can republish them to bring them back.
          </p>
        ) : (
          <div className="max-h-56 overflow-y-auto space-y-0.5 pr-0.5">
            {pins.map((pin) => (
              <PinRow
                key={pin.rumorId}
                pin={pin}
                canUnpin={canUnpin}
                busy={isUnpinning}
                onJump={onJump}
                onUnpin={onUnpin}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
