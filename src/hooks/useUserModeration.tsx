import { Flag, UserCheck, UserX } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { ReportDialog } from "@/components/ReportDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useChatScope } from "@/hooks/useChatScope";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMemberActions, useMemberRolePicker } from "@/hooks/useMemberActions";
import { useMuteToggle } from "@/hooks/useMuteList";
import { reportDestination } from "@/lib/report";
import { cn } from "@/lib/utils";

import type { MemberActionItem, MemberRolePicker } from "@/contexts/MemberActionsContext";

export interface UserModeration {
  /** Staff actions from the scope's provider, then block and report. Empty for oneself. */
  actions: MemberActionItem[];
  /** The scope's role checklist, when the viewer may change this member's roles. */
  rolePicker?: MemberRolePicker;
  /** Mount OUTSIDE any menu or popover: those unmount on select, the dialog must not. */
  dialogs: ReactNode;
}

/**
 * Everything the viewer may do to one person, for every surface that offers it
 * (member list, message menus, profile card, voice tiles), so they can't drift.
 * `report: false` where the surface reports content instead of the person.
 */
export function useUserModeration(
  pubkey: string | undefined,
  { report = true }: { report?: boolean } = {},
): UserModeration {
  const { user } = useCurrentUser();
  const staff = useMemberActions(pubkey);
  const rolePicker = useMemberRolePicker(pubkey);
  const mute = useMuteToggle(pubkey);
  const toggleMute = mute.toggle;
  const reportTo = reportDestination(useChatScope());
  const [reportOpen, setReportOpen] = useState(false);
  const [confirming, setConfirming] = useState<MemberActionItem | null>(null);
  const canReport = report && Boolean(pubkey && reportTo && user && pubkey !== user.pubkey);

  const actions = useMemo<MemberActionItem[]>(() => {
    // An action that asks first opens the confirm instead of running.
    const out = staff.map((a) => (a.confirm ? { ...a, onSelect: () => setConfirming(a) } : a));
    if (mute.canMute) {
      out.push({
        id: "mute",
        label: mute.muted ? "Unblock person" : "Block person",
        icon: mute.muted ? UserCheck : UserX,
        // Unblocking restores someone, so it isn't styled destructive.
        destructive: !mute.muted,
        disabled: mute.pending,
        onSelect: () => void toggleMute(),
      });
    }
    if (canReport) {
      out.push({ id: "report", label: "Report person", icon: Flag, destructive: true, onSelect: () => setReportOpen(true) });
    }
    return out;
  }, [staff, mute.canMute, mute.muted, mute.pending, toggleMute, canReport]);

  const confirm = confirming?.confirm;
  const dialogs = (
    <>
      {reportOpen && reportTo && pubkey && (
        <ReportDialog open={reportOpen} onOpenChange={setReportOpen} destination={reportTo} target={{ pubkey }} />
      )}
      {confirming && confirm && (
        <AlertDialog open onOpenChange={(open) => !open && setConfirming(null)}>
          <AlertDialogContent className="gap-0">
            <div className="mb-4 flex flex-col items-center gap-2 text-center">
              <div
                className={cn(
                  "flex size-12 items-center justify-center clip-corner-lg",
                  confirming.destructive ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
                )}
              >
                <confirm.icon className="size-6" />
              </div>
              <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <ul className="mt-1 space-y-1.5 text-left">
                  {confirm.consequences.map((line) => (
                    <li key={line} className="flex gap-2">
                      <span aria-hidden className="mt-2 size-1 shrink-0 bg-muted-foreground/60" />
                      {line}
                    </li>
                  ))}
                </ul>
              </AlertDialogDescription>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className={cn(confirming.destructive && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
                onClick={() => confirming.onSelect()}
              >
                {confirm.confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );

  return { actions, rolePicker, dialogs };
}
