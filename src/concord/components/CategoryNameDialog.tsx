import { Folder } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NAME_MAX_BYTES } from "@/concord/lib/types";

/**
 * Name a channel category — the prompt behind both "New category" and a
 * category rename. A category has no id of its own; it is only ever the set of
 * channels naming it (channelCategory.ts), so "rename" re-files every member
 * and "create" simply files the first one under the name typed here.
 *
 * Shared by the channel sidebar (ConcordPage) and the community settings
 * organizer (CommunitySettingsView) so the two ask the question identically.
 */
export function CategoryNameDialog({
  open,
  initial,
  count,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initial: string;
  /** How many channels the name will be applied to, for the button's copy. */
  count: number;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const trimmed = value.trim();
  const unchanged = trimmed === initial.trim();
  const renaming = Boolean(initial);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={renaming ? "Rename category" : "New category"}>
        {/* The house dialog header: centered crest + lowercase mono heading.
            It also gives the shell's close button its own row — the form used
            to start flush at the top, putting the X over the input's corner. */}
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Folder className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            {renaming ? "rename category" : "new category"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {renaming
              ? count > 1
                ? `Renames it for all ${count} channels in it — a category is only ever the channels naming it, so each one is re-filed.`
                : "A category is only ever the channels naming it, so renaming re-files the channel in it."
              : "A heading to group channels under in the sidebar. It exists for as long as a channel is in it."}
          </p>
        </div>

        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed || unchanged) {
              onOpenChange(false);
              return;
            }
            onSubmit(trimmed);
            onOpenChange(false);
          }}
        >
          <div className="space-y-1.5">
            <Label
              htmlFor="channel-category-name"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Category name
            </Label>
            <Input
              id="channel-category-name"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. Voice"
              autoComplete="off"
              autoFocus
              maxLength={NAME_MAX_BYTES}
              className="bg-background/40 border-transparent"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              className="flex-1 clip-corner-lg"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" className="flex-1 clip-corner-lg" disabled={!trimmed || unchanged}>
              {renaming ? "Rename" : "Create"}
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}
