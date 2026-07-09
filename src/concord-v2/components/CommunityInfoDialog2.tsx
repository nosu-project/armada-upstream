import {
  Check,
  Hash,
  ImagePlus,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Shield,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ImageLightbox2 } from "@/concord-v2/components/ImageLightbox2";
import { useCommunityManagement2 } from "@/concord-v2/hooks/useCommunityActions2";
import { useChannels2 } from "@/concord-v2/hooks/useControlPlane2";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import { useMetadataActions2 } from "@/concord-v2/hooks/useRoles2";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { useUploadFile } from "@/hooks/useUploadFile";
import { encryptImageBlob } from "@/concord-v2/lib/image";
import type {
  ChannelV2,
  CommunityMetadata,
  CommunityV2,
  ImagePointer,
} from "@/concord-v2/lib/types";
import { cn } from "@/lib/utils";

/**
 * The single "community" surface: the same view is shown to everyone (icon,
 * banner, name, description, owner, member count, relays, channels). Viewers
 * with MANAGE_METADATA can edit the name / description / icon / banner inline
 * (Signal-style — tap to change); viewers with MANAGE_CHANNELS can rename,
 * delete and add channels. Edits publish version-chained editions; every
 * member's fold re-checks the permission (CORD-02/04), so the UI gating is a
 * convenience, not the enforcement point.
 */
export function CommunityInfoDialog2({
  community,
  metadata,
  ownerHex,
  memberCount,
  canManageMetadata,
  canManageChannels,
  open,
  onOpenChange,
}: {
  community: CommunityV2 | undefined;
  metadata: CommunityMetadata | undefined;
  ownerHex: string | undefined;
  memberCount: number;
  canManageMetadata: boolean;
  canManageChannels: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md border-0 rounded-none p-0 bg-transparent shadow-none">
        <DialogTitle className="sr-only">Community</DialogTitle>
        <div className="clip-corner-lg bg-chrome max-h-[85vh] overflow-y-auto">
          {community && (
            <InfoBody
              community={community}
              metadata={metadata}
              ownerHex={ownerHex}
              memberCount={memberCount}
              canManageMetadata={canManageMetadata}
              canManageChannels={canManageChannels}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InfoBody({
  community,
  metadata,
  ownerHex,
  memberCount,
  canManageMetadata,
  canManageChannels,
}: {
  community: CommunityV2;
  metadata: CommunityMetadata | undefined;
  ownerHex: string | undefined;
  memberCount: number;
  canManageMetadata: boolean;
  canManageChannels: boolean;
}) {
  const { updateMetadata, isUpdating } = useMetadataActions2(community);
  const { mutateAsync: uploadFile } = useUploadFile();

  const name = metadata?.name || community.name;
  const description = metadata?.description?.trim();
  const relays = metadata?.relays ?? community.relays;

  const bannerUrl = useDecryptedImage2(metadata?.banner);
  const iconUrl = useDecryptedImage2(metadata?.icon);
  const [iconZoom, setIconZoom] = useState(false);
  const [bannerZoom, setBannerZoom] = useState(false);
  const [uploading, setUploading] = useState<"icon" | "banner" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editingField, setEditingField] = useState<"name" | "description" | null>(null);

  const bannerInputRef = useRef<HTMLInputElement>(null);
  const iconInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (which: "icon" | "banner", file: File) => {
    setError(null);
    setUploading(which);
    try {
      const { ciphertext, key, nonce, hash } = await encryptImageBlob(file);
      const tags = await uploadFile(
        new File([ciphertext], `${which}.enc`, { type: "application/octet-stream" }),
      );
      const url = tags[0]?.[1];
      if (!url) throw new Error("Upload returned no URL.");
      const image: ImagePointer = { url, key, nonce, hash };
      await updateMetadata(which === "icon" ? { icon: image } : { banner: image });
      toast({ title: which === "icon" ? "Icon updated" : "Banner updated" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(null);
    }
  };

  const saveField = async (field: "name" | "description", value: string) => {
    setError(null);
    try {
      await updateMetadata(field === "name" ? { name: value } : { description: value });
      setEditingField(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save changes.");
    }
  };

  return (
    <div className="space-y-5">
      {/* Banner: shown when present, or as an add affordance for editors. */}
      {(bannerUrl || canManageMetadata) && (
        <div className="relative -mb-2">
          {bannerUrl ? (
            <button
              type="button"
              className="block h-24 w-full overflow-hidden cursor-zoom-in"
              aria-label="View banner"
              onClick={() => setBannerZoom(true)}
            >
              <img src={bannerUrl} alt="" className="size-full object-cover" />
            </button>
          ) : (
            <button
              type="button"
              className="flex h-24 w-full items-center justify-center bg-secondary/40 text-muted-foreground transition-colors hover:bg-secondary/60"
              onClick={() => bannerInputRef.current?.click()}
              aria-label="Add banner"
            >
              <ImagePlus className="size-5" />
            </button>
          )}
          {canManageMetadata && (
            <button
              type="button"
              className="absolute bottom-2 right-2 grid size-8 place-items-center rounded-full bg-background/70 text-foreground backdrop-blur transition-colors hover:bg-background/90"
              onClick={() => bannerInputRef.current?.click()}
              disabled={uploading === "banner"}
              aria-label="Change banner"
            >
              {uploading === "banner" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Pencil className="size-3.5" />
              )}
            </button>
          )}
        </div>
      )}

      <div className={cn("space-y-5 px-6 pb-6 sm:px-7 sm:pb-7", !(bannerUrl || canManageMetadata) && "pt-6 sm:pt-7")}>
        <div className="flex flex-col items-center text-center gap-3">
          <div className="relative">
            {iconUrl ? (
              <button
                type="button"
                className="cursor-zoom-in rounded-2xl"
                aria-label="View icon"
                onClick={() => setIconZoom(true)}
              >
                <img src={iconUrl} alt="" className="size-16 rounded-2xl object-cover" />
              </button>
            ) : canManageMetadata ? (
              <button
                type="button"
                className="grid size-16 place-items-center rounded-2xl bg-secondary/50 text-muted-foreground transition-colors hover:bg-secondary/70"
                onClick={() => iconInputRef.current?.click()}
                aria-label="Add icon"
              >
                <ImagePlus className="size-5" />
              </button>
            ) : (
              <div className="grid size-16 place-items-center rounded-2xl bg-primary/15 text-primary">
                <span className="text-2xl font-semibold">{name[0]?.toUpperCase() ?? "?"}</span>
              </div>
            )}
            {canManageMetadata && (
              <button
                type="button"
                className="absolute -bottom-1 -right-1 grid size-6 place-items-center rounded-full bg-background text-foreground ring-1 ring-border transition-colors hover:bg-secondary"
                onClick={() => iconInputRef.current?.click()}
                disabled={uploading === "icon"}
                aria-label="Change icon"
              >
                {uploading === "icon" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Pencil className="size-3" />
                )}
              </button>
            )}
          </div>

          {editingField === "name" ? (
            <InlineEdit
              initial={name}
              saving={isUpdating}
              multiline={false}
              onCancel={() => setEditingField(null)}
              onSave={(v) => saveField("name", v)}
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <h2 className="text-lg font-semibold leading-tight break-words">{name}</h2>
              {canManageMetadata && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0 text-muted-foreground"
                  aria-label="Edit name"
                  onClick={() => setEditingField("name")}
                >
                  <Pencil className="size-3" />
                </Button>
              )}
            </div>
          )}
        </div>

        {iconUrl && iconZoom && <ImageLightbox2 src={iconUrl} onClose={() => setIconZoom(false)} />}
        {bannerUrl && bannerZoom && <ImageLightbox2 src={bannerUrl} onClose={() => setBannerZoom(false)} />}

        {/* Description */}
        {editingField === "description" ? (
          <InlineEdit
            initial={description ?? ""}
            saving={isUpdating}
            multiline
            placeholder="What's this community about?"
            onCancel={() => setEditingField(null)}
            onSave={(v) => saveField("description", v)}
          />
        ) : description ? (
          <div className="flex items-start gap-1.5">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {description}
            </p>
            {canManageMetadata && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground"
                aria-label="Edit description"
                onClick={() => setEditingField("description")}
              >
                <Pencil className="size-3" />
              </Button>
            )}
          </div>
        ) : (
          canManageMetadata && (
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start gap-1.5 text-muted-foreground"
              onClick={() => setEditingField("description")}
            >
              <Plus className="size-3.5" /> Add a description
            </Button>
          )
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-3">
          {ownerHex && <OwnerRow pubkey={ownerHex} />}
          <div className="flex items-center gap-2.5 text-sm">
            <Users className="size-4 shrink-0 text-muted-foreground" />
            <span>
              {memberCount} {memberCount === 1 ? "member" : "members"}
            </span>
          </div>
        </div>

        <ChannelsSection community={community} canManage={canManageChannels} />

        {relays.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Relays
            </span>
            <ul className="space-y-1">
              {relays.map((r) => (
                <li key={r} className="truncate rounded-md bg-secondary/40 px-2 py-1 text-xs font-mono">
                  {r}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <input
        ref={bannerInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload("banner", f);
          e.target.value = "";
        }}
      />
      <input
        ref={iconInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload("icon", f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** An inline text/textarea editor with save + cancel, used for name & description. */
function InlineEdit({
  initial,
  saving,
  multiline,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string;
  saving: boolean;
  multiline: boolean;
  placeholder?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <form
      className="flex w-full items-start gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value.trim());
      }}
    >
      {multiline ? (
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          rows={3}
          autoFocus
          className="flex-1"
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoFocus
          autoComplete="off"
          className="h-8 flex-1 text-center"
        />
      )}
      <Button
        type="submit"
        size="icon"
        variant="ghost"
        className="size-8 shrink-0"
        disabled={saving || (!multiline && !value.trim())}
        aria-label="Save"
      >
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8 shrink-0 text-muted-foreground"
        onClick={onCancel}
        disabled={saving}
        aria-label="Cancel"
      >
        <X className="size-4" />
      </Button>
    </form>
  );
}

function OwnerRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const displayName = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <Avatar className="size-6 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">{displayName}</span>
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
        <Shield className="size-3" />
        Owner
      </span>
    </div>
  );
}

/** The community's channels. Read-only for everyone; rename / delete / add for
 *  viewers with MANAGE_CHANNELS. */
function ChannelsSection({
  community,
  canManage,
}: {
  community: CommunityV2;
  canManage: boolean;
}) {
  const channels = useChannels2(community);
  const { renameChannel, isRenaming, deleteChannel, createChannel, isAddingChannel } =
    useCommunityManagement2(community);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await createChannel({ name });
      setNewName("");
      setCreating(false);
    } catch (e) {
      toast({
        title: "Couldn't create channel",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Channels
        </span>
        {canManage && !creating && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label="Add channel"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="space-y-1 rounded-lg bg-secondary/40 p-1">
        {channels.map((ch) => (
          <ChannelRow
            key={ch.idHex}
            channel={ch}
            canManage={canManage}
            disabled={isRenaming}
            onRename={(name) => renameChannel({ channelIdHex: ch.idHex, name })}
            onDelete={
              canManage && channels.length > 1
                ? async () => {
                    if (!confirm(`Delete #${ch.name}? Its id is never reused.`)) return;
                    try {
                      await deleteChannel({ channelIdHex: ch.idHex });
                      toast({ title: "Channel deleted" });
                    } catch (e) {
                      toast({
                        title: "Couldn't delete",
                        description: e instanceof Error ? e.message : undefined,
                        variant: "destructive",
                      });
                    }
                  }
                : undefined
            }
          />
        ))}
        {creating && (
          <form
            className="flex items-center gap-1 px-1"
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
          >
            <Hash className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new-channel"
              autoFocus
              className="h-7 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              disabled={isAddingChannel || !newName.trim()}
              aria-label="Create channel"
            >
              {isAddingChannel ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
  canManage,
  disabled,
  onRename,
  onDelete,
}: {
  channel: ChannelV2;
  canManage: boolean;
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
        toast({
          title: "Rename failed",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        });
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
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            className="h-7 text-sm"
            onBlur={commit}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            disabled={disabled}
            aria-label="Save name"
          >
            <Check className="size-3.5" />
          </Button>
        </form>
      ) : (
        <>
          <span className="flex-1 truncate text-sm">{channel.name}</span>
          {canManage && (
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
          )}
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
