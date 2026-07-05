import { Check, Hash, ImagePlus, Loader2, Lock, Pencil, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCommunityManagement2 } from "@/concord-v2/hooks/useCommunityActions2";
import { useChannels2 } from "@/concord-v2/hooks/useControlPlane2";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import { useMetadataActions2 } from "@/concord-v2/hooks/useRoles2";
import { toast } from "@/hooks/useToast";
import { useUploadFile } from "@/hooks/useUploadFile";
import { encryptImageBlob } from "@/concord-v2/lib/image";
import type { ChannelV2, CommunityV2, ImagePointer } from "@/concord-v2/lib/types";
import { cn } from "@/lib/utils";

/**
 * Edit a Concord V2 community's metadata — name, description, encrypted icon
 * + banner — and manage channels (rename / delete). Publishes version-chained
 * vsk=0 / vsk=2 editions; every member's fold re-checks MANAGE_METADATA /
 * MANAGE_CHANNELS.
 */
export function SettingsDialog2({
  community,
  open,
  onOpenChange,
}: {
  community: CommunityV2 | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md border-0 rounded-none p-0 bg-transparent shadow-none">
        <DialogTitle className="sr-only">Community settings</DialogTitle>
        <div className="clip-corner-lg bg-chrome p-6 sm:p-7 max-h-[85vh] overflow-y-auto">
          {community && <SettingsBody community={community} onDone={() => onOpenChange(false)} />}
        </div>
        <ArmadaCrestKeyframes />
      </DialogContent>
    </Dialog>
  );
}

function SettingsBody({ community, onDone }: { community: CommunityV2; onDone: () => void }) {
  const { metadata, updateMetadata, isUpdating } = useMetadataActions2(community);
  const { mutateAsync: uploadFile } = useUploadFile();

  const currentName = metadata?.name ?? community.name;
  const currentDescription = metadata?.description ?? "";

  const [name, setName] = useState(currentName);
  const [description, setDescription] = useState(currentDescription);
  const [icon, setIcon] = useState<ImagePointer | null | undefined>(undefined);
  const [banner, setBanner] = useState<ImagePointer | null | undefined>(undefined);
  const [uploading, setUploading] = useState<"icon" | "banner" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(currentName);
    setDescription(currentDescription);
    setIcon(undefined);
    setBanner(undefined);
    setError(null);
  }, [currentName, currentDescription]);

  const effectiveIcon = icon === undefined ? metadata?.icon : icon ?? undefined;
  const effectiveBanner = banner === undefined ? metadata?.banner : banner ?? undefined;

  const handleUpload = async (which: "icon" | "banner", file: File) => {
    setError(null);
    setUploading(which);
    try {
      const { ciphertext, key, nonce, hash } = await encryptImageBlob(file);
      const tags = await uploadFile(new File([ciphertext], `${which}.enc`, { type: "application/octet-stream" }));
      const url = tags[0]?.[1];
      if (!url) throw new Error("Upload returned no URL.");
      const image: ImagePointer = { url, key, nonce, hash };
      if (which === "icon") setIcon(image);
      else setBanner(image);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(null);
    }
  };

  const handleSave = async () => {
    setError(null);
    try {
      await updateMetadata({
        name,
        description,
        ...(icon !== undefined ? { icon } : {}),
        ...(banner !== undefined ? { banner } : {}),
      });
      toast({ title: "Community updated" });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save changes.");
    }
  };

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <ArmadaCrest size={64} />
        <h2 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
          community settings
        </h2>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
        className="w-full space-y-4"
      >
        <ImageField label="Banner" aspect="banner" image={effectiveBanner} uploading={uploading === "banner"} onPick={(f) => handleUpload("banner", f)} />
        <ImageField label="Logo" aspect="logo" image={effectiveIcon} uploading={uploading === "icon"} onPick={(f) => handleUpload("icon", f)} />

        <div className="space-y-1.5">
          <Label htmlFor="c2-name">Name</Label>
          <Input id="c2-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="c2-desc">Description</Label>
          <Textarea
            id="c2-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this community about?"
            rows={3}
          />
        </div>

        <ChannelsSection community={community} />

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" disabled={isUpdating || Boolean(uploading) || !name.trim()} className="w-full clip-corner-lg">
          {isUpdating ? <><Loader2 className="size-4 mr-2 animate-spin" /> Saving...</> : <><Save className="size-4 mr-2" /> Save changes</>}
        </Button>
      </form>
    </div>
  );
}

/** A logo/banner picker that previews the (decrypted) current image and uploads a new one. */
function ImageField({
  label,
  aspect,
  image,
  uploading,
  onPick,
}: {
  label: string;
  aspect: "logo" | "banner";
  image: ImagePointer | undefined;
  uploading: boolean;
  onPick: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const preview = useDecryptedImage2(image);

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={cn(
          "relative flex w-full items-center justify-center overflow-hidden bg-secondary/50 text-muted-foreground transition-colors hover:bg-secondary/70",
          aspect === "banner" ? "h-24 clip-corner-lg" : "size-20 rounded-full",
        )}
      >
        {preview ? <img src={preview} alt={label} className="size-full object-cover" /> : <ImagePlus className="size-5" />}
        {uploading && (
          <span className="absolute inset-0 grid place-items-center bg-background/60">
            <Loader2 className="size-5 animate-spin" />
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** The community's channels with inline rename + delete (vsk=2 editions). */
function ChannelsSection({ community }: { community: CommunityV2 }) {
  const channels = useChannels2(community);
  const { renameChannel, isRenaming, deleteChannel } = useCommunityManagement2(community);
  return (
    <div className="space-y-1.5">
      <Label>Channels</Label>
      <div className="space-y-1 rounded-lg bg-secondary/40 p-1">
        {channels.map((ch) => (
          <ChannelRow
            key={ch.idHex}
            channel={ch}
            disabled={isRenaming}
            onRename={(name) => renameChannel({ channelIdHex: ch.idHex, name })}
            onDelete={
              channels.length > 1
                ? async () => {
                    if (!confirm(`Delete #${ch.name}? Its id is never reused.`)) return;
                    try {
                      await deleteChannel({ channelIdHex: ch.idHex });
                      toast({ title: "Channel deleted" });
                    } catch (e) {
                      toast({ title: "Couldn't delete", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
                    }
                  }
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
  disabled,
  onRename,
  onDelete,
}: {
  channel: ChannelV2;
  disabled: boolean;
  onRename: (name: string) => Promise<void>;
  onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(channel.name);

  useEffect(() => {
    setValue(channel.name);
  }, [channel.name]);

  const commit = async () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== channel.name) {
      try {
        await onRename(trimmed);
        toast({ title: "Channel renamed" });
      } catch (e) {
        toast({ title: "Rename failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
        setValue(channel.name);
      }
    }
    setEditing(false);
  };

  const Icon = channel.isPrivate ? Lock : Hash;
  return (
    <div className="flex items-center gap-2 px-1">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      {editing ? (
        <form
          className="flex flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus className="h-7 text-sm" onBlur={commit} />
          <Button type="submit" size="icon" variant="ghost" className="size-7 shrink-0" disabled={disabled} aria-label="Save name">
            <Check className="size-3.5" />
          </Button>
        </form>
      ) : (
        <>
          <span className="flex-1 truncate text-sm">{channel.name}</span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label="Rename channel"
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3.5" />
          </Button>
          {onDelete && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label="Delete channel"
              onClick={onDelete}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </>
      )}
    </div>
  );
}
