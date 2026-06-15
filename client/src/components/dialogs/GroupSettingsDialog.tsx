import { Check, Copy, Globe, Hash, Loader2, Lock, Mail, TicketPlus } from "lucide-react";
import { useEffect, useState } from "react";

import { PrivacyToggle } from "@/components/dialogs/CreateGroupDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
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
  const [copied, setCopied] = useState(false);

  // Re-seed form state whenever the dialog opens for (possibly updated) group data.
  useEffect(() => {
    if (open) {
      setName(group.name);
      setAbout(group.about ?? "");
      setPicture(group.picture ?? "");
      setIsPrivate(group.isPrivate);
      setIsClosed(group.isClosed);
      setInviteCode(null);
      setCopied(false);
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
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const displayName = name.trim() || group.name || group.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden" aria-describedby={undefined}>
        <DialogHeader className="items-center text-center gap-2 px-6 pt-6 pb-5 bg-gradient-to-b from-primary/10 to-transparent">
          <Avatar className="size-14 rounded-2xl">
            <AvatarImage src={picture.trim() || undefined} alt={displayName} />
            <AvatarFallback className="rounded-2xl bg-primary/15 text-primary">
              <Hash className="size-6" />
            </AvatarFallback>
          </Avatar>
          <DialogTitle className="text-lg truncate max-w-full">{displayName}</DialogTitle>
          <p className="text-sm text-muted-foreground">Channel settings</p>
        </DialogHeader>

        <div className="space-y-5 px-6 pb-6 max-h-[60vh] overflow-y-auto">
          <div className="space-y-1.5">
            <Label htmlFor="settings-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Channel name
            </Label>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input id="settings-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} className="pl-9" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-about" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Topic
            </Label>
            <Textarea id="settings-about" value={about} onChange={(e) => setAbout(e.target.value)} maxLength={300} rows={2} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-picture" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Channel icon
            </Label>
            <Input id="settings-picture" value={picture} onChange={(e) => setPicture(e.target.value)} placeholder="https://…" />
          </div>

          <div className="space-y-2">
            <PrivacyToggle
              id="settings-private"
              icon={isPrivate ? <Lock className="size-4" /> : <Globe className="size-4" />}
              title="Private"
              description="Only members can read messages."
              checked={isPrivate}
              onCheckedChange={setIsPrivate}
            />
            <PrivacyToggle
              id="settings-closed"
              icon={<Mail className="size-4" />}
              title="Invite only"
              description="People need an invite code to join."
              checked={isClosed}
              onCheckedChange={setIsClosed}
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Invites</Label>
            {inviteCode ? (
              <div className="flex gap-2">
                <Input readOnly value={inviteCode} className="font-mono" />
                <Button variant="outline" size="icon" aria-label="Copy invite code" onClick={copyInvite}>
                  {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
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

        <div className="flex gap-2 px-6 py-4 border-t bg-secondary/20">
          <Button variant="ghost" className="flex-1" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="flex-1" onClick={handleSave} disabled={editMetadata.isPending}>
            {editMetadata.isPending ? <><Loader2 className="size-4 mr-2 animate-spin" /> Saving…</> : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
