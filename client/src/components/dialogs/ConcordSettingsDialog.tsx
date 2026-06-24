import { ImagePlus, Loader2, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useConcordMetadataActions } from "@/hooks/useConcordMetadata";
import { toast } from "@/hooks/useToast";
import { useUploadFile } from "@/hooks/useUploadFile";
import { decryptImageToObjectURL, encryptImage, extOf } from "@/lib/concord/communityImage";
import type { Community, CommunityImage } from "@/lib/concord/types";
import { cn } from "@/lib/utils";

/**
 * Edit a Concord community's GroupRoot metadata — name, description, encrypted
 * logo + banner — in the cut-corner chrome idiom. Publishes a version-chained
 * vsk=0 control edition; every member's fold re-checks MANAGE_METADATA.
 */
export function ConcordSettingsDialog({
  community,
  open,
  onOpenChange,
}: {
  community: Community | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md border-0 rounded-none p-0 bg-transparent shadow-none">
        <DialogTitle className="sr-only">Community settings</DialogTitle>
        <div className="clip-corner-lg bg-chrome p-6 sm:p-7">
          {community && <SettingsBody community={community} onDone={() => onOpenChange(false)} />}
        </div>
        <ArmadaCrestKeyframes />
      </DialogContent>
    </Dialog>
  );
}

function SettingsBody({ community, onDone }: { community: Community; onDone: () => void }) {
  const { updateMetadata, isUpdating } = useConcordMetadataActions(community);
  const { mutateAsync: uploadFile } = useUploadFile();

  const [name, setName] = useState(community.name);
  const [description, setDescription] = useState(community.description ?? "");
  const [icon, setIcon] = useState<CommunityImage | null | undefined>(undefined);
  const [banner, setBanner] = useState<CommunityImage | null | undefined>(undefined);
  const [uploading, setUploading] = useState<"icon" | "banner" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset local edits whenever the dialog is (re)opened on a community.
  useEffect(() => {
    setName(community.name);
    setDescription(community.description ?? "");
    setIcon(undefined);
    setBanner(undefined);
    setError(null);
  }, [community.name, community.description]);

  const effectiveIcon = icon === undefined ? community.icon : icon ?? undefined;
  const effectiveBanner = banner === undefined ? community.banner : banner ?? undefined;

  const handleUpload = async (which: "icon" | "banner", file: File) => {
    setError(null);
    setUploading(which);
    try {
      const ext = extOf(file.name);
      const { ciphertext, key, nonce, hash } = await encryptImage(file, ext);
      const tags = await uploadFile(
        new File([ciphertext], `${which}.${ext}.enc`, { type: "application/octet-stream" }),
      );
      const url = tags[0]?.[1];
      if (!url) throw new Error("Upload returned no URL.");
      const image: CommunityImage = { url, key, nonce, hash, ext };
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
        // Only send icon/banner when changed (undefined = unchanged).
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
        <ImageField
          label="Banner"
          aspect="banner"
          image={effectiveBanner}
          uploading={uploading === "banner"}
          onPick={(f) => handleUpload("banner", f)}
        />
        <ImageField
          label="Logo"
          aspect="logo"
          image={effectiveIcon}
          uploading={uploading === "icon"}
          onPick={(f) => handleUpload("icon", f)}
        />

        <div className="space-y-1.5">
          <Label htmlFor="concord-name">Name</Label>
          <Input id="concord-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="concord-desc">Description</Label>
          <Textarea
            id="concord-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this community about?"
            rows={3}
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button
          type="submit"
          disabled={isUpdating || Boolean(uploading) || !name.trim()}
          className="w-full clip-corner-lg"
        >
          {isUpdating ? (
            <><Loader2 className="size-4 mr-2 animate-spin" /> Saving...</>
          ) : (
            <><Save className="size-4 mr-2" /> Save changes</>
          )}
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
  image: CommunityImage | undefined;
  uploading: boolean;
  onPick: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // Decrypt the current image for preview; revoke the object URL on change/unmount.
  useEffect(() => {
    if (!image) {
      setPreview(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    const ac = new AbortController();
    decryptImageToObjectURL(image, ac.signal)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        url = u;
        setPreview(u);
      })
      .catch(() => setPreview(null));
    return () => {
      cancelled = true;
      ac.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [image]);

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
        {preview ? (
          <img src={preview} alt={label} className="size-full object-cover" />
        ) : (
          <ImagePlus className="size-5" />
        )}
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
