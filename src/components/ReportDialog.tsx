import { Flag, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuthor } from "@/hooks/useAuthor";
import { useMutedPubkeys, useMuteUser } from "@/hooks/useMuteList";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useSendReport } from "@/hooks/useSendReport";
import { toast } from "@/hooks/useToast";
import {
  reportAudience,
  REPORT_REASONS,
  type ReportDestination,
  type ReportReason,
  type ReportTarget,
} from "@/lib/report";

/** How long a report comment may be. Long enough to explain, short enough to read. */
const MAX_COMMENT = 500;

interface ReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ReportTarget;
  destination: ReportDestination;
}

/**
 * The one report dialog, used by every surface that can raise one: a message's
 * action menu, a member list, a profile card, a DM thread header.
 *
 * It asks for exactly two things — a reason, and optionally what happened — and
 * states in one line who will read the answer. It does NOT ask where the report
 * should go: {@link reportDestination} already answered that from the surface,
 * and a chooser would only ask the reporter to reason about three trust models
 * before they can flag a message.
 *
 * Muting rides along because it is what someone reporting a person almost
 * always also wants, and making them find it separately afterwards is the
 * difference between "handled" and "still there". It is checked by default and
 * omitted entirely for someone already muted.
 */
export function ReportDialog({ open, onOpenChange, target, destination }: ReportDialogProps) {
  const author = useAuthor(target.pubkey);
  const name = useScopedDisplayName(target.pubkey, author.data?.metadata);
  const { mutedPubkeys } = useMutedPubkeys();
  const sendReport = useSendReport();
  const muteUser = useMuteUser();

  const [reason, setReason] = useState<ReportReason | "">("");
  const [comment, setComment] = useState("");
  const [alsoMute, setAlsoMute] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const alreadyMuted = mutedPubkeys.has(target.pubkey);

  // A fresh open is a fresh report — never inherit the last one's reason.
  useEffect(() => {
    if (!open) return;
    setReason("");
    setComment("");
    setAlsoMute(true);
    setError(null);
    setBusy(false);
  }, [open]);

  const title =
    destination.kind === "network"
      ? "Report to the Nostr network"
      : target.eventId
        ? "Report message"
        : <>Report <DisplayName pubkey={target.pubkey} name={name} />?</>;

  const submit = async () => {
    if (!reason) return;
    setError(null);
    setBusy(true);
    try {
      await sendReport.mutateAsync({
        destination,
        target,
        reason,
        comment: comment.trim(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the report.");
      setBusy(false);
      return;
    }

    // The report landed. A mute failure from here is its own, smaller problem —
    // reporting it as a failed report would be a lie that invites a duplicate.
    if (alsoMute && !alreadyMuted) {
      try {
        await muteUser.mutateAsync(target.pubkey);
      } catch (e) {
        toast({
          title: "Reported, but couldn't mute",
          description: e instanceof Error ? e.message : "Failed to update your mute list.",
          variant: "destructive",
        });
        setBusy(false);
        onOpenChange(false);
        return;
      }
    }

    toast({
      title: "Report sent",
      description: reportAudience(destination),
    });
    setBusy(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{reportAudience(destination)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Select value={reason} onValueChange={(v) => setReason(v as ReportReason)}>
            <SelectTrigger aria-label="Reason">
              <SelectValue placeholder="Choose a reason" />
            </SelectTrigger>
            <SelectContent>
              {REPORT_REASONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT))}
            placeholder="Add details (optional)"
            rows={3}
            aria-label="Details"
          />

          {!alreadyMuted && (
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox
                checked={alsoMute}
                onCheckedChange={(v) => setAlsoMute(v === true)}
              />
              Also mute <DisplayName pubkey={target.pubkey} name={name} />
            </Label>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={busy || !reason}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Flag className="size-4" />}
            {busy ? "Sending" : "Report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
