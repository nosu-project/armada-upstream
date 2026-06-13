import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCreateGroup, useGroupModeration } from "@/hooks/useGroupModeration";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { toast } from "@/hooks/useToast";
import { relayToRouteParam } from "@/lib/platform";

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
      updateList({ action: "add", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);

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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create channel</DialogTitle>
          <DialogDescription>
            Creates a NIP-29 group on this server. You become its first admin.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ops-room"
              maxLength={64}
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="group-about">Topic</Label>
            <Textarea
              id="group-about"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="What is this channel about? (optional)"
              maxLength={300}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="group-private" className="font-medium">Private</Label>
              <p className="text-xs text-muted-foreground">Only members can read messages.</p>
            </div>
            <Switch id="group-private" checked={isPrivate} onCheckedChange={setIsPrivate} />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="group-closed" className="font-medium">Closed</Label>
              <p className="text-xs text-muted-foreground">Joining requires an invite.</p>
            </div>
            <Switch id="group-closed" checked={isClosed} onCheckedChange={setIsClosed} />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? <><Loader2 className="size-4 mr-2 animate-spin" /> Creating…</> : "Create channel"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
