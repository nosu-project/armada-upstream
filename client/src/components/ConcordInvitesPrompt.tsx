import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  ChromeDialogContent,
} from "@/components/ui/dialog";
import {
  useAcceptConcordInvite,
  useConcordInvites,
  useDeclineConcordInvite,
  type ParkedInvite,
} from "@/hooks/useConcordInvites";
import { toast } from "@/hooks/useToast";

/**
 * Consent-gated prompt for direct (gift-wrapped) Concord invites. A received
 * invite is parked — it never auto-joins — and surfaced here for the user to
 * accept or decline. Accepting reconstructs the community + records it in the
 * encrypted membership list; declining tombstones it so it stops re-nagging.
 *
 * Mounted globally (MainLayout) so an invite that arrives on any screen prompts.
 */
export function ConcordInvitesPrompt() {
  const { data: invites } = useConcordInvites();
  const { mutateAsync: accept, isPending: accepting } = useAcceptConcordInvite();
  const { mutateAsync: decline, isPending: declining } = useDeclineConcordInvite();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const pending = (invites ?? []).filter((i) => !dismissed.has(i.wrapId));
  const current: ParkedInvite | undefined = pending[0];
  const open = Boolean(current);
  const busy = accepting || declining;

  if (!current) return null;

  const handleAccept = async () => {
    try {
      const community = await accept({ invite: current.invite });
      toast({ title: "Joined encrypted chat", description: community.name });
      navigate(`/c/${encodeURIComponent(community.communityId)}`);
    } catch (e) {
      toast({
        title: "Couldn't join",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const handleDecline = async () => {
    try {
      await decline({ communityId: current.communityId });
    } catch {
      // Best-effort; dismiss locally regardless.
    }
    setDismissed((prev) => new Set(prev).add(current.wrapId));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleDecline()}>
      <ChromeDialogContent title="Encrypted chat invite">
        <div className="flex flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <ArmadaCrest size={72} />
            <div className="space-y-1">
              <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
                encrypted chat invite
              </h2>
              <p className="text-sm text-muted-foreground">
                You've been invited to an end-to-end-encrypted community. Accepting gives you the
                keys to read and post; no host can see its messages.
              </p>
            </div>
          </div>

          <div className="w-full clip-corner-lg border border-chrome bg-secondary/40 p-4">
            <div className="flex items-center gap-2 font-medium">
              <ShieldCheck className="size-4 shrink-0 text-success" />
              <span className="min-w-0 truncate">{current.name}</span>
            </div>
            <div className="mt-1 break-all text-xs text-muted-foreground">
              from {current.sender.slice(0, 16)}…
            </div>
            {pending.length > 1 && (
              <div className="mt-2 text-xs text-muted-foreground">
                +{pending.length - 1} more invite{pending.length - 1 === 1 ? "" : "s"} after this
              </div>
            )}
          </div>

          <div className="flex w-full justify-end gap-2">
            <Button variant="ghost" className="clip-corner-lg" onClick={handleDecline} disabled={busy}>
              Decline
            </Button>
            <Button className="clip-corner-lg" onClick={handleAccept} disabled={busy}>
              {accepting ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" /> Joining…
                </>
              ) : (
                "Accept"
              )}
            </Button>
          </div>
        </div>
        <ArmadaCrestKeyframes />
      </ChromeDialogContent>
    </Dialog>
  );
}
