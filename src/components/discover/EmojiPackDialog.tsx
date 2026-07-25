import { ImagePlus, Loader2, Smile, X } from "lucide-react";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KIND_EMOJI_SET } from "@/hooks/useEmojiPacks";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useUploadFile } from "@/hooks/useUploadFile";
import { toast } from "@/hooks/useToast";

interface Entry {
  id: string;
  shortcode: string;
  url: string;
  uploading: boolean;
}

/** Sanitize a filename / input into a valid NIP-30 shortcode. */
function toShortcode(raw: string): string {
  return raw
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function slugify(title: string): string {
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "pack";
}

/**
 * Create (and publish) a NIP-30 emoji pack (kind 30030): name it, upload emoji
 * images, give each a shortcode. Publishing makes it discoverable and usable by
 * anyone. Only ever runs on an explicit user action.
 */
export function EmojiPackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title="Create emoji pack">
        <EmojiPackForm onDone={() => onOpenChange(false)} />
      </ChromeDialogContent>
    </Dialog>
  );
}

function EmojiPackForm({ onDone }: { onDone: () => void }) {
  const { mutateAsync: uploadFile } = useUploadFile();
  const { mutateAsync: publishEvent, isPending: publishing } = useNostrPublish();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setEntries((prev) => [
        ...prev,
        { id, shortcode: toShortcode(file.name), url: "", uploading: true },
      ]);
      try {
        const tags = await uploadFile(file);
        const url = tags[0]?.[1] ?? "";
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, url, uploading: false } : e)),
        );
      } catch {
        setEntries((prev) => prev.filter((e) => e.id !== id));
        toast({ title: "Upload failed", description: file.name, variant: "destructive" });
      }
    }
  };

  const setShortcode = (id: string, value: string) =>
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, shortcode: toShortcode(value) } : e)));

  const removeEntry = (id: string) => setEntries((prev) => prev.filter((e) => e.id !== id));

  const ready = entries.filter((e) => e.url && e.shortcode);
  const uploading = entries.some((e) => e.uploading);
  const canPublish = name.trim().length > 0 && ready.length > 0 && !uploading && !publishing;

  const publish = async () => {
    if (!canPublish) return;
    // Drop shortcode collisions (last wins would confuse the pack); keep first.
    const seen = new Set<string>();
    const tags: string[][] = [
      ["d", `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`],
      ["title", name.trim()],
    ];
    for (const e of ready) {
      if (seen.has(e.shortcode)) continue;
      seen.add(e.shortcode);
      tags.push(["emoji", e.shortcode, e.url]);
    }
    try {
      await publishEvent({ kind: KIND_EMOJI_SET, content: "", tags });
      void queryClient.invalidateQueries({ queryKey: ["discover", "emoji-packs"] });
      toast({ title: "Emoji pack published", description: name.trim() });
      onDone();
    } catch (e) {
      toast({
        title: "Couldn't publish pack",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
          <Smile className="size-6" />
        </div>
        <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
          create emoji pack
        </h2>
        <p className="text-sm text-muted-foreground">
          Upload images, give each a shortcode, and publish a pack anyone can add.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pack-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Pack name
        </Label>
        <Input
          id="pack-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My emoji pack"
          maxLength={60}
        />
      </div>

      {entries.length > 0 && (
        <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-stable pr-1">
          {entries.map((e) => (
            <div key={e.id} className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary overflow-hidden">
                {e.uploading ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <CustomEmojiImg name={e.shortcode} url={e.url} className="size-7 object-contain" />
                )}
              </span>
              <div className="flex min-w-0 flex-1 items-center rounded-md border border-input bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
                <span className="text-muted-foreground text-sm">:</span>
                <input
                  value={e.shortcode}
                  onChange={(ev) => setShortcode(e.id, ev.target.value)}
                  placeholder="shortcode"
                  className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
                  aria-label="Emoji shortcode"
                />
                <span className="text-muted-foreground text-sm">:</span>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="shrink-0 text-muted-foreground"
                onClick={() => removeEntry(e.id)}
                aria-label="Remove emoji"
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <Button type="button" variant="outline" className="w-full clip-corner-lg" onClick={() => fileInput.current?.click()}>
        <ImagePlus className="size-4" />
        Add emoji images
      </Button>

      <Button className="w-full clip-corner-lg" onClick={publish} disabled={!canPublish}>
        {publishing ? <Loader2 className="size-4 animate-spin" /> : null}
        Publish pack{ready.length > 0 ? ` (${ready.length})` : ""}
      </Button>
    </div>
  );
}
