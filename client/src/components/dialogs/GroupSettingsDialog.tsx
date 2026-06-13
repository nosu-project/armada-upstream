import { Copy, Loader2, TicketPlus } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { toast } from "@/hooks/useToast";

import type { Nip29Group } from "@/lib/nip29";

interface GroupSettingsDialogProps {
  relayUrl: string;
  group: Nip29Group;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function randomInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Admin controls for a channel: edit NIP-29 metadata (kind 9002) and mint
 * invite codes (kind 9009). The relay enforces permissions by role.
 */
export function GroupSettingsDialog({ relayUrl, group, open, onOpenChange }: GroupSettingsDialogProps) {
  const { editMetadata, createInvite } = useGroupModeration(relayUrl, group.id);
  const [name, setName] = useState(group.name);
  const [about, setAbout] = useState(group.about ?? "");
  const [picture, setPicture] = useState(group.picture ?? "");
  const [isPrivate, setIsPrivate] = useState(group.isPrivate);
  const [isClosed, setIsClosed] = useState(group.isClosed);
  const [inviteCode, setInviteCode] = useState<string | null>(null);

  // Re-seed form state whenever the dialog opens for (possibly updated) group data.
  useEffect(() => {
    if (open) {
      setName(group.name);
      setAbout(group.about ?? "");
      setPicture(group.picture ?? "");
      setIsPrivate(group.isPrivate);
      setIsClosed(group.isClosed);
      setInviteCode(null);
    }
  }, [open, group]);

  const handleSave = async () => {
    try {
      await editMetadata.mutateAsync({
        name: name.trim() || group.id,
        about: about.trim(),
        picture: picture.trim(),
        isPrivate,
        isClosed,
      });
      toast({ title: "Channel updated" });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Update failed",
        description: e instanceof Error ? e.message : "The relay rejected the edit.",
        variant: "destructive",
      });
    }
  };

  const handleInvite = async () => {
    const code = randomInviteCode();
    try {
      await createInvite.mutateAsync({ code });
      setInviteCode(code);
    } catch (e) {
      toast({
        title: "Invite failed",
        description: e instanceof Error ? e.message : "The relay rejected the invite.",
        variant: "destructive",
      });
    }
  };

  const copyInvite = () => {
    if (!inviteCode) return;
    navigator.clipboard.writeText(inviteCode).then(
      () => toast({ title: "Invite code copied" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Channel settings</DialogTitle>
          <DialogDescription>
            Changes are submitted as NIP-29 moderation events; the relay applies them
            if your role allows.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="settings-name">Name</Label>
            <Input id="settings-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-about">Topic</Label>
            <Textarea id="settings-about" value={about} onChange={(e) => setAbout(e.target.value)} maxLength={300} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-picture">Picture URL</Label>
            <Input id="settings-picture" value={picture} onChange={(e) => setPicture(e.target.value)} placeholder="https://…" />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="settings-private" className="font-medium">Private</Label>
              <p className="text-xs text-muted-foreground">Only members can read messages.</p>
            </div>
            <Switch id="settings-private" checked={isPrivate} onCheckedChange={setIsPrivate} />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="settings-closed" className="font-medium">Closed</Label>
              <p className="text-xs text-muted-foreground">Joining requires an invite code.</p>
            </div>
            <Switch id="settings-closed" checked={isClosed} onCheckedChange={setIsClosed} />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Invites</Label>
            {inviteCode ? (
              <div className="flex gap-2">
                <Input readOnly value={inviteCode} className="font-mono" />
                <Button variant="outline" size="icon" aria-label="Copy invite code" onClick={copyInvite}>
                  <Copy className="size-4" />
                </Button>
              </div>
            ) : (
              <Button variant="outline" className="w-full" onClick={handleInvite} disabled={createInvite.isPending}>
                {createInvite.isPending
                  ? <><Loader2 className="size-4 mr-2 animate-spin" /> Creating…</>
                  : <><TicketPlus className="size-4 mr-2" /> Create invite code</>}
              </Button>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSave} disabled={editMetadata.isPending}>
            {editMetadata.isPending ? <><Loader2 className="size-4 mr-2 animate-spin" /> Saving…</> : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
