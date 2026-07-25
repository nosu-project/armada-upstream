import { AlertTriangle, ImagePlus, Loader2, Smile, X } from "lucide-react";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KIND_EMOJI_SET, useAddEmojiPack } from "@/hooks/useEmojiPacks";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useUploadFile } from "@/hooks/useUploadFile";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

import type { NostrEvent } from "@nostrify/nostrify";

interface Entry {
  id: string;
  shortcode: string;
  url: string;
  uploading: boolean;
}

/**
 * Sanitize what someone is *typing* into a shortcode. Deliberately does not
 * trim leading/trailing underscores: doing that per-keystroke makes `foo_bar`
 * impossible to type (the `_` is eaten the moment it lands at the end).
 * Trimming happens once, in `finalShortcode()`, at validation/publish time.
 */
function sanitizeShortcode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 32);
}

/** The shortcode as it will be published. */
function finalShortcode(raw: string): string {
  return raw.replace(/^_+|_+$/g, "");
}

/** Seed a shortcode from an uploaded file's name (extension dropped). */
function shortcodeFromFilename(name: string): string {
  return finalShortcode(sanitizeShortcode(name.replace(/\.[a-z0-9]+$/i, "")));
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
  const { user } = useCurrentUser();
  const { mutateAsync: uploadFile } = useUploadFile();
  const { mutateAsync: publishEvent, isPending: publishing } = useNostrPublish();
  const { mutateAsync: addPack } = useAddEmojiPack();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [addToMine, setAddToMine] = useState(true);

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setEntries((prev) => [
        ...prev,
        { id, shortcode: shortcodeFromFilename(file.name), url: "", uploading: true },
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
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, shortcode: sanitizeShortcode(value) } : e)),
    );

  const removeEntry = (id: string) => setEntries((prev) => prev.filter((e) => e.id !== id));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };

  const uploading = entries.filter((e) => e.uploading).length;
  const uploaded = entries.filter((e) => !e.uploading && e.url);
  // Shortcodes must be present and unique — publishing a pack that silently
  // drops colliding entries leaves people with a pack missing emojis.
  const counts = new Map<string, number>();
  for (const e of uploaded) {
    const code = finalShortcode(e.shortcode);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const isDuplicate = (raw: string) => (counts.get(finalShortcode(raw)) ?? 0) > 1;
  const duplicates = [...counts.values()].filter((n) => n > 1).length;
  const missing = uploaded.filter((e) => !finalShortcode(e.shortcode)).length;
  const named = name.trim().length > 0;
  const canPublish =
    named && uploaded.length > 0 && !uploading && !publishing && duplicates === 0 && missing === 0;

  const hint = publishing
    ? "Publishing…"
    : uploading > 0
      ? `Uploading ${uploading} image${uploading === 1 ? "" : "s"}…`
      : missing > 0
        ? "Every emoji needs a shortcode."
        : duplicates > 0
          ? "Two emojis share a shortcode. Make each one unique."
          : !named
            ? "Give the pack a name."
            : uploaded.length === 0
              ? "Add at least one image."
              : "Anyone will be able to find and add this pack.";

  const publish = async () => {
    if (!canPublish) return;
    const identifier = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    const tags: string[][] = [["d", identifier], ["title", name.trim()]];
    for (const e of uploaded) {
      tags.push(["emoji", finalShortcode(e.shortcode), e.url]);
    }
    try {
      const event = await publishEvent({ kind: KIND_EMOJI_SET, content: "", tags });

      // Show the new pack by seeding the cache rather than refetching. An
      // immediate refetch races relay indexing on a 6s budget, so it can come
      // back with LESS than is already on screen — the browse list appearing to
      // empty itself the moment you publish. The stale mark (without a refetch)
      // lets the next natural fetch reconcile with the relays.
      queryClient.setQueriesData<NostrEvent[]>(
        { queryKey: ["discover", "emoji-packs"], predicate: (q) => q.queryKey[3] === "" },
        (prev) => (prev ? [event, ...prev.filter((e) => e.id !== event.id)] : prev),
      );
      void queryClient.invalidateQueries({
        queryKey: ["discover", "emoji-packs"],
        refetchType: "none",
      });

      // Your own pack in your own emoji list — an explicit opt-in on this
      // click, never automatic. A failure here (the read-modify-write refuses
      // rather than risk clobbering the list) must not read as a failed
      // publish: the pack itself is already out.
      if (addToMine && user) {
        try {
          await addPack({ pubkey: user.pubkey, identifier });
          toast({ title: "Emoji pack published", description: `${name.trim()} — added to your emojis` });
        } catch (e) {
          toast({
            title: "Published, but not added to your emojis",
            description: e instanceof Error ? e.message : "Couldn't update your emoji list.",
            variant: "destructive",
          });
        }
      } else {
        toast({ title: "Emoji pack published", description: name.trim() });
      }
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
    <div className="flex flex-col gap-5">
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
        <Label
          htmlFor="pack-name"
          className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
        >
          Pack name
        </Label>
        <Input
          id="pack-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My emoji pack"
          maxLength={60}
          autoFocus
        />
      </div>

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

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Emojis
          </span>
          {uploaded.length > 0 && (
            <span className="text-xs text-muted-foreground/70">{uploaded.length}</span>
          )}
          {entries.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-7 touch:h-9 gap-1.5 text-xs text-muted-foreground"
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus className="size-3.5" />
              Add more
            </Button>
          )}
        </div>

        {entries.length === 0 ? (
          // Drop target — the primary affordance while the pack is empty.
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center transition-colors",
              dragging
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:border-muted-foreground/60 hover:bg-foreground/5",
            )}
          >
            <ImagePlus className="size-6" />
            <span className="text-sm font-medium text-foreground">Add emoji images</span>
            <span className="text-xs">Drop them here, or click to browse. PNG, GIF or WebP.</span>
          </button>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "max-h-56 space-y-1.5 overflow-y-auto scrollbar-stable clip-corner-lg p-1.5 transition-colors",
              dragging ? "bg-primary/10" : "bg-foreground/5",
            )}
          >
            {entries.map((e) => {
              const invalid = !e.uploading && (!finalShortcode(e.shortcode) || isDuplicate(e.shortcode));
              return (
                <div key={e.id} className="flex items-center gap-2">
                  <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-background">
                    {e.uploading ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <CustomEmojiImg
                        name={e.shortcode}
                        url={e.url}
                        className="size-7 object-contain"
                      />
                    )}
                  </span>
                  <div
                    className={cn(
                      "flex min-w-0 flex-1 items-center rounded-md border bg-background px-2 focus-within:ring-1",
                      invalid
                        ? "border-destructive focus-within:ring-destructive"
                        : "border-input focus-within:ring-ring",
                    )}
                  >
                    <span className="text-sm text-muted-foreground">:</span>
                    <input
                      value={e.shortcode}
                      onChange={(ev) => setShortcode(e.id, ev.target.value)}
                      placeholder="shortcode"
                      aria-label="Emoji shortcode"
                      aria-invalid={invalid}
                      className="min-w-0 flex-1 bg-transparent py-1.5 touch:py-2.5 text-sm outline-none"
                    />
                    <span className="text-sm text-muted-foreground">:</span>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8 touch:size-10 shrink-0 text-muted-foreground"
                    onClick={() => removeEntry(e.id)}
                    aria-label={`Remove ${e.shortcode || "emoji"}`}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        {user && (
          <Label className="flex cursor-pointer items-center gap-2 py-1 text-sm font-normal text-muted-foreground">
            <Checkbox
              checked={addToMine}
              onCheckedChange={(v) => setAddToMine(v === true)}
              className="shrink-0"
            />
            Add to my emojis
          </Label>
        )}
        <Button className="w-full clip-corner-lg" onClick={publish} disabled={!canPublish}>
          {publishing && <Loader2 className="size-4 animate-spin" />}
          Publish pack
        </Button>
        <p
          className={cn(
            "flex items-center justify-center gap-1.5 text-center text-xs",
            duplicates > 0 || missing > 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {(duplicates > 0 || missing > 0) && <AlertTriangle className="size-3.5 shrink-0" />}
          {hint}
        </p>
      </div>
    </div>
  );
}
