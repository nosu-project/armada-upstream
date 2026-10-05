import { Flag, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
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

const MAX_COMMENT = 500;

interface ReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ReportTarget;
  destination: ReportDestination;
}

/**
 * The one report dialog for every surface. Doesn't ask where the report goes
 * ({@link reportDestination} decides). Mute is checked by default, omitted if already muted.
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

  // Never inherit the last report's reason.
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

    // The report landed; a mute failure mustn't read as a failed report (invites duplicates).
    if (alsoMute && !alreadyMuted) {
      try {
        await muteUser.mutateAsync(target.pubkey);
      } catch (e) {
        toast({
          title: "Reported, but couldn't block",
          description: e instanceof Error ? e.message : "Failed to update your block list.",
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
      <ChromeDialogContent title={typeof title === "string" ? title : `Report ${name}`} className="sm:max-w-sm">
        <ChromeDialogHeader icon={Flag} tone="destructive" title={title} description={reportAudience(destination)} />

        <div className="mt-6 space-y-3">
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
              Also block <DisplayName pubkey={target.pubkey} name={name} />
            </Label>
          )}
        </div>

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

        <ChromeDialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={busy || !reason}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Flag className="size-4" />}
            {busy ? "Sending" : "Report"}
          </Button>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}
