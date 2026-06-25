import { Loader2, Smile } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { useSetUserStatus, useUserStatus } from "@/hooks/useUserStatus";

interface StatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A few one-tap status suggestions. */
const PRESETS = ["👋 Available", "🎧 Focusing", "🌴 Away", "💤 Sleeping", "🍕 Lunch"];

const MAX_LEN = 140;

/**
 * Set or clear the current user's NIP-38 status (kind 30315, `d: "general"`).
 * The status is a short, ephemeral message shown next to your name in member
 * lists and your profile card. Leaving it empty and saving clears it.
 */
export function StatusDialog({ open, onOpenChange }: StatusDialogProps) {
  const { user } = useCurrentUser();
  const { data } = useUserStatus(user?.pubkey);
  const { mutateAsync: setStatus, isPending } = useSetUserStatus();

  const [content, setContent] = useState("");

  // Hydrate from the current status whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setContent(data?.status?.content ?? "");
    }
  }, [open, data?.status?.content]);

  const save = async (next: string) => {
    try {
      await setStatus({ content: next });
      toast({
        title: next.trim() ? "Status updated" : "Status cleared",
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Couldn’t update status",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smile className="size-4" />
            Set a status
          </DialogTitle>
          <DialogDescription>
            A short message shown next to your name. Visible to everyone. Clear it any time.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(content);
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="user-status">What's happening?</Label>
            <Input
              id="user-status"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="e.g. 🎧 Heads down"
              autoComplete="off"
              maxLength={MAX_LEN}
              autoFocus
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setContent(preset)}
                  className="rounded-full border bg-secondary/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            {data?.status?.content && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-muted-foreground"
                disabled={isPending}
                onClick={() => save("")}
              >
                Clear status
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? <><Loader2 className="size-4 mr-2 animate-spin" /> Saving…</> : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
