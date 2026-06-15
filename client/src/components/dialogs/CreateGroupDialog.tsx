import { Globe, Hash, Loader2, Lock, Mail } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCreateGroup, useGroupModeration } from "@/hooks/useGroupModeration";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { toast } from "@/hooks/useToast";
import { relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface CreateGroupDialogProps {
  relayUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Random NIP-29 group id. */
function randomGroupId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normalize a freeform name into a channel-style slug for preview. */
function toChannelSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
}

/**
 * Create a NIP-29 group on the server: kind 9007 (create-group) followed by
 * kind 9002 (edit-metadata) with the chosen name/visibility, then remember it
 * in the user's kind 10009 list.
 */
export function CreateGroupDialog({ relayUrl, open, onOpenChange }: CreateGroupDialogProps) {
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [groupId] = useState(randomGroupId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { mutateAsync: createGroup } = useCreateGroup(relayUrl);
  const { editMetadata } = useGroupModeration(relayUrl, groupId);
  const { mutateAsync: updateList } = useUpdateUserGroupList();

  const slug = toChannelSlug(name);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setPending(true);
    setError(null);
    try {
      await createGroup({ groupId });
      await editMetadata.mutateAsync({
        name: name.trim(),
        about: about.trim() || undefined,
        isPrivate,
        isClosed,
      });
      // Best-effort: remember the group in the user's NIP-51 list.
      updateList({ type: "add-group", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);

      toast({ title: "Channel created", description: name.trim() });
      onOpenChange(false);
      navigate(`/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(groupId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the channel.");
    } finally {
      setPending(false);
    }
  };

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden" aria-describedby={undefined}>
        <DialogHeader className="items-center text-center gap-2 px-6 pt-6 pb-5 bg-gradient-to-b from-primary/10 to-transparent">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <Hash className="size-6" />
          </div>
          <DialogTitle className="text-lg">Create a channel</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Channels are where your community talks. You&apos;ll be its first admin.
          </p>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          className="space-y-5 px-6 pb-6"
        >
          <div className="space-y-1.5">
            <Label htmlFor="group-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Channel name
            </Label>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="general"
                maxLength={64}
                autoComplete="off"
                autoFocus
                className="pl-9"
              />
            </div>
            {slug && (
              <p className="text-xs text-muted-foreground">
                Members will see <span className="font-medium text-foreground">#{slug}</span>
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="group-about" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Topic <span className="normal-case font-normal">(optional)</span>
            </Label>
            <Textarea
              id="group-about"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="What's this channel about?"
              maxLength={300}
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <PrivacyToggle
              id="group-private"
              icon={isPrivate ? <Lock className="size-4" /> : <Globe className="size-4" />}
              title="Private"
              description="Only members can read messages."
              checked={isPrivate}
              onCheckedChange={setIsPrivate}
            />
            <PrivacyToggle
              id="group-closed"
              icon={<Mail className="size-4" />}
              title="Invite only"
              description="People need an invite code to join."
              checked={isClosed}
              onCheckedChange={setIsClosed}
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="ghost" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={pending || !name.trim()}>
              {pending ? <><Loader2 className="size-4 mr-2 animate-spin" /> Creating…</> : "Create channel"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface PrivacyToggleProps {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** A toggle row with an icon, title, and description for a channel option. */
export function PrivacyToggle({ id, icon, title, description, checked, onCheckedChange }: PrivacyToggleProps) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-center gap-3 rounded-xl border p-3 cursor-pointer transition-colors",
        checked ? "border-primary/50 bg-primary/5" : "border-border/70 hover:bg-secondary/40",
      )}
    >
      <span className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
        checked ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground",
      )}>
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-tight">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
