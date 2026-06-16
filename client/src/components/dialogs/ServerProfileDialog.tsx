import { Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
import { useServerProfile, useUpdateServerProfile } from "@/hooks/useServerProfile";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { isHexColor } from "@/lib/nip29";

interface ServerProfileDialogProps {
  relayUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Default swatch used by the color input when no color is set yet. */
const DEFAULT_COLOR = "#7c5cff";

/** A few quick-pick swatches shown next to the custom color input. */
const PRESET_COLORS = [
  "#f87171", "#fb923c", "#facc15", "#4ade80",
  "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6",
];

/**
 * Edit the current user's per-server identity: a nickname (how you appear to
 * others on this server), a label (a short tag you set for yourself here), and
 * a username color. All three are NIP-32 self-labels scoped to this relay only
 * — they never appear on other servers or in your global profile.
 */
export function ServerProfileDialog({ relayUrl, open, onOpenChange }: ServerProfileDialogProps) {
  const { user, metadata } = useCurrentUser();
  const { data: profile, isLoading } = useServerProfile(relayUrl, user?.pubkey);
  const { mutateAsync: save, isPending } = useUpdateServerProfile(relayUrl);

  const [nickname, setNickname] = useState("");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("");
  const [colorEnabled, setColorEnabled] = useState(false);

  // Hydrate the form whenever the dialog opens or the loaded profile changes.
  useEffect(() => {
    if (open) {
      setNickname(profile?.nickname ?? "");
      setLabel(profile?.label ?? "");
      setColor(profile?.color ?? "");
      setColorEnabled(isHexColor(profile?.color));
    }
  }, [open, profile]);

  const handleSave = async () => {
    try {
      await save({
        nickname,
        label,
        color: colorEnabled ? (color || DEFAULT_COLOR) : "",
      });
      toast({ title: "Saved", description: "Your server identity has been updated." });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Couldn’t save",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const pickColor = (next: string) => {
    setColor(next);
    setColorEnabled(true);
  };

  // What the preview should show: nickname if set, else the global name.
  const previewName = nickname.trim() || getDisplayName(metadata, user?.pubkey);
  const previewColor = colorEnabled && isHexColor(color || DEFAULT_COLOR)
    ? (color || DEFAULT_COLOR)
    : undefined;
  const swatch = isHexColor(color) ? color : DEFAULT_COLOR;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>Server identity</DialogTitle>
          <DialogDescription>
            A nickname, label and color that apply only on this server — never on other
            servers or your global profile.
          </DialogDescription>
        </DialogHeader>

        {/* Live preview — mirrors a real chat message row. */}
        <div className="px-6 pb-5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-2">
            Preview
          </div>
          <div className="rounded-xl border bg-secondary/30 p-3">
            <div className="flex items-start gap-3">
              <Avatar shape={getAvatarShape(metadata)} className="size-10 shrink-0">
                <AvatarImage src={metadata?.picture} alt={previewName} />
                <AvatarFallback className="bg-primary/20 text-primary text-sm">
                  {previewName[0]?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="text-[15px] font-semibold text-primary truncate"
                    style={previewColor ? { color: previewColor } : undefined}
                  >
                    {previewName}
                  </span>
                  {label.trim() && (
                    <Badge variant="secondary" className="text-[10px] font-medium">
                      {label.trim()}
                    </Badge>
                  )}
                  <span className="text-[11px] text-muted-foreground/70">just now</span>
                </div>
                <p className="text-sm text-foreground/90 mt-0.5">
                  Hey everyone, glad to be here 👋
                </p>
              </div>
            </div>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          className="px-6 pb-6 space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="server-nickname">Nickname</Label>
            <Input
              id="server-nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="How others see you here"
              autoComplete="off"
              maxLength={64}
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="server-label">Label</Label>
            <Input
              id="server-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="A short tag, e.g. “Founder”"
              autoComplete="off"
              maxLength={32}
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Username color</Label>
              {colorEnabled && (
                <button
                  type="button"
                  onClick={() => {
                    setColorEnabled(false);
                    setColor("");
                  }}
                  disabled={isLoading}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RotateCcw className="size-3" />
                  Reset
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Custom color well. */}
              <label
                className="relative size-9 shrink-0 cursor-pointer rounded-lg border overflow-hidden"
                style={{ backgroundColor: colorEnabled ? swatch : "transparent" }}
                title="Custom color"
              >
                <input
                  type="color"
                  aria-label="Custom username color"
                  value={swatch}
                  onChange={(e) => pickColor(e.target.value)}
                  disabled={isLoading}
                  className="absolute inset-0 size-full cursor-pointer opacity-0"
                />
              </label>
              {/* Preset swatches. */}
              <div className="flex flex-wrap items-center gap-1.5">
                {PRESET_COLORS.map((c) => {
                  const active = colorEnabled && color.toLowerCase() === c.toLowerCase();
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Use color ${c}`}
                      onClick={() => pickColor(c)}
                      disabled={isLoading}
                      className="size-6 rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110"
                      style={{
                        backgroundColor: c,
                        boxShadow: active ? `0 0 0 2px var(--background, #000), 0 0 0 4px ${c}` : undefined,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || isLoading}>
              {isPending ? <><Loader2 className="size-4 mr-2 animate-spin" /> Saving…</> : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
