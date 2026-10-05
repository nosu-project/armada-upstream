import { Blocks, EyeOff, Eye, FileIcon, Loader2, Music, Paperclip, Pencil, Play, Trash2, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FallbackImage } from "@/components/ui/FallbackImage";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAudioMetadata } from "@/hooks/useAudioMetadata";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { companionEncryption } from "@/lib/imeta";
import { modelFormat } from "@/lib/mediaUrls";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";

import type { ImetaEncryption } from "@/lib/imeta";

/** The longest description the edit dialog accepts. */
export const MAX_ALT_CHARS = 1000;

export interface TrayAttachment {
  kind: "attachment";
  url: string;
  mime: string;
  label: string;
  /** A webxdc icon, a video's poster frame, or a 3D model's still. */
  icon?: string;
  isImage: boolean;
  isVideo: boolean;
  isAudio: boolean;
  isWebxdc: boolean;
  encryption?: ImetaEncryption;
  alt?: string;
  spoiler: boolean;
}

export interface TrayPending {
  kind: "pending";
  id: string;
  label: string;
  previewUrl?: string;
  phase: "processing" | "uploading";
  /** 0..1 while a video transcodes; absent when the work can't be measured. */
  progress?: number;
}

export type TrayItem = TrayAttachment | TrayPending;

interface AttachmentTrayProps {
  items: TrayItem[];
  /** Touch: a tap opens the edit sheet rather than the lightbox, as on Discord mobile. */
  isTouch: boolean;
  onPreview: (url: string) => void;
  onRemove: (url: string) => void;
  onCancel: (id: string) => void;
  onUpdate: (url: string, patch: { alt?: string; spoiler?: boolean }) => void;
}

/**
 * Attachments staged above the composer. The spoiler toggle is always visible
 * on image/video cards: it's needed BEFORE sending, so it can't hide behind hover.
 */
export function AttachmentTray({ items, isTouch, onPreview, onRemove, onCancel, onUpdate }: AttachmentTrayProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const editingItem = items.find((i): i is TrayAttachment => i.kind === "attachment" && i.url === editing);

  if (items.length === 0) return null;

  return (
    <>
      <ul
        aria-label="Attachments"
        className="flex gap-2 overflow-x-auto px-3 pt-2 pb-1 animate-in slide-in-from-top-2 fade-in-0 duration-200 [scrollbar-width:thin]"
      >
        {items.map((item) =>
          item.kind === "pending" ? (
            <PendingCard key={item.id} item={item} onCancel={onCancel} />
          ) : (
            <AttachmentCard
              key={item.url}
              item={item}
              isTouch={isTouch}
              onPreview={onPreview}
              onRemove={onRemove}
              onEdit={setEditing}
              onUpdate={onUpdate}
            />
          ),
        )}
      </ul>
      <AttachmentEditDialog
        item={editingItem}
        onClose={() => setEditing(null)}
        onPreview={onPreview}
        onRemove={onRemove}
        onSave={onUpdate}
      />
    </>
  );
}

/** A bare thumbnail, Signal-style: no caption (documents name themselves inside). */
const cardClass = "group/att relative size-24 shrink-0 md:size-28";
const squareClass = "relative size-full overflow-hidden rounded-lg bg-secondary/60";

function AttachmentCard({
  item,
  isTouch,
  onPreview,
  onRemove,
  onEdit,
  onUpdate,
}: {
  item: TrayAttachment;
  isTouch: boolean;
  onPreview: (url: string) => void;
  onRemove: (url: string) => void;
  onEdit: (url: string) => void;
  onUpdate: (url: string, patch: { alt?: string; spoiler?: boolean }) => void;
}) {
  const previewable = item.isImage || item.isVideo;
  const open = () => {
    if (isTouch) onEdit(item.url);
    else if (previewable) onPreview(item.url);
    else onEdit(item.url);
  };

  return (
    <li className={cardClass}>
      <button
        type="button"
        onClick={open}
        aria-label={isTouch ? `Edit ${item.label}` : previewable ? `Preview ${item.label}` : `Edit ${item.label}`}
        title={item.label}
        className={cn(squareClass, previewable && !isTouch && "cursor-zoom-in")}
      >
        <CardPreview item={item} />
        {item.spoiler && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-xl">
            <span className="rounded-full bg-black/70 px-2 py-0.5 text-3xs font-bold tracking-wide text-white">SPOILER</span>
          </span>
        )}
        {item.alt && (
          <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-3xs font-bold text-white">ALT</span>
        )}
        {isTouch && (
          <span aria-hidden className="absolute bottom-1 left-1 flex size-6 items-center justify-center rounded-full bg-black/60 text-white">
            <Pencil className="size-3" />
          </span>
        )}
      </button>

      {previewable && (
        <SpoilerToggle
          label={item.label}
          spoiler={item.spoiler}
          onToggle={() => onUpdate(item.url, { spoiler: !item.spoiler })}
        />
      )}

      {isTouch ? (
        <CornerButton label={`Remove ${item.label}`} onClick={() => onRemove(item.url)} />
      ) : (
        <div className="absolute right-1 top-1 flex overflow-hidden rounded-md bg-background/95 opacity-0 shadow-sm transition-opacity group-hover/att:opacity-100 focus-within:opacity-100">
          <ToolbarButton label="Edit attachment" onClick={() => onEdit(item.url)}>
            <Pencil className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Remove attachment" destructive onClick={() => onRemove(item.url)}>
            <Trash2 className="size-3.5" />
          </ToolbarButton>
        </div>
      )}
    </li>
  );
}

/** Always-visible spoiler switch; a 44px target on touch. */
function SpoilerToggle({ label, spoiler, onToggle }: { label: string; spoiler: boolean; onToggle: () => void }) {
  const action = spoiler ? "Remove spoiler" : "Mark as spoiler";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${action}: ${label}`}
          aria-pressed={spoiler}
          onClick={onToggle}
          className="absolute -bottom-1 -right-1 flex size-8 items-center justify-center touch:size-11"
        >
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-full shadow-sm transition-colors",
              spoiler ? "bg-primary text-primary-foreground" : "bg-black/65 text-white hover:bg-black/80",
            )}
          >
            {spoiler ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{action}</TooltipContent>
    </Tooltip>
  );
}

function PendingCard({ item, onCancel }: { item: TrayPending; onCancel: (id: string) => void }) {
  const percent = item.phase === "processing" && item.progress !== undefined
    ? Math.round(Math.min(1, Math.max(0, item.progress)) * 100)
    : undefined;
  return (
    <li className={cardClass} aria-busy="true" title={item.label}>
      <div className={squareClass}>
        {item.previewUrl && <img src={item.previewUrl} alt="" className="size-full object-cover opacity-60" />}
        <span className="absolute inset-0 flex items-center justify-center">
          <span
            role="status"
            aria-label={`${item.label}: ${item.phase === "uploading" ? "Uploading" : "Preparing"}${percent !== undefined ? ` ${percent}%` : ""}`}
            className="relative flex size-11 items-center justify-center rounded-full bg-black/55"
          >
            {percent !== undefined ? (
              <>
                <ProgressRing fraction={percent / 100} />
                <span className="text-3xs font-semibold tabular-nums text-white">{percent}%</span>
              </>
            ) : (
              <Loader2 className="size-6 animate-spin text-white" />
            )}
          </span>
        </span>
      </div>
      <CornerButton label={`Cancel ${item.label}`} onClick={() => onCancel(item.id)} alwaysVisible />
    </li>
  );
}

function ProgressRing({ fraction }: { fraction: number }) {
  const r = 19;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 44 44" className="absolute inset-0 size-full -rotate-90" aria-hidden>
      <circle cx="22" cy="22" r={r} fill="none" strokeWidth="3" className="stroke-white/25" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - fraction)}
        className="stroke-white transition-[stroke-dashoffset] duration-200"
      />
    </svg>
  );
}

/** The corner X — a 44px target on touch around a small visible disc. */
function CornerButton({ label, onClick, alwaysVisible = false }: { label: string; onClick: () => void; alwaysVisible?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "absolute -right-1 -top-1 flex size-8 items-center justify-center touch:size-11",
        !alwaysVisible && "opacity-0 group-hover/att:opacity-100 focus-visible:opacity-100 touch:opacity-100",
      )}
    >
      <span className="flex size-6 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm hover:text-foreground">
        <X className="size-3.5" />
      </span>
    </button>
  );
}

function ToolbarButton({
  label,
  onClick,
  destructive = false,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={cn(
            "flex size-7 items-center justify-center text-muted-foreground transition-colors hover:bg-secondary",
            destructive ? "hover:text-destructive" : "hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CardPreview({ item }: { item: TrayAttachment }) {
  if (item.isImage) {
    return <AttachmentPreviewImage url={item.url} mime={item.mime} encryption={item.encryption} alt={item.alt} />;
  }
  if (item.isVideo) {
    return (
      <span className="relative block size-full bg-black/40">
        {item.icon && (
          <AttachmentPreviewImage url={item.icon} mime="image/jpeg" encryption={companionEncryption(item.encryption)} />
        )}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-black/55 p-1.5">
            <Play className="size-4 text-white" fill="currentColor" />
          </span>
        </span>
      </span>
    );
  }
  if (item.isAudio) return <AudioCardPreview item={item} />;
  if (item.isWebxdc) {
    const icon = sanitizeImageSrc(item.icon);
    const placeholder = <Blocks className="size-8 text-primary" />;
    return (
      <span className="flex size-full items-center justify-center">
        {icon ? (
          <FallbackImage src={icon} className="size-10 rounded-lg object-cover" fallback={placeholder} />
        ) : (
          placeholder
        )}
      </span>
    );
  }
  if (item.icon && modelFormat(item.mime)) {
    return <AttachmentPreviewImage url={item.icon} mime="image/png" encryption={companionEncryption(item.encryption)} alt="" />;
  }
  return (
    <span className="flex size-full flex-col items-center justify-center gap-1.5 px-1.5 text-muted-foreground">
      <FileIcon className="size-7 shrink-0" />
      <span className="line-clamp-2 break-all text-center text-3xs font-medium leading-tight">{item.label}</span>
    </span>
  );
}

/** Cover art/title read at pick time; a restored draft shows its name over a glyph. */
function AudioCardPreview({ item }: { item: TrayAttachment }) {
  const meta = useAudioMetadata(item.url);
  return (
    <span className="relative block size-full">
      {meta?.coverUrl ? (
        <img src={meta.coverUrl} alt="" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center pb-6 text-muted-foreground">
          <Music className="size-8" />
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-left text-white">
        <span className="block truncate text-3xs font-semibold leading-tight">{meta?.title ?? item.label}</span>
        {meta?.artist && <span className="block truncate text-3xs leading-tight opacity-80">{meta.artist}</span>}
      </span>
    </span>
  );
}

/**
 * Resolved like the message render path ({@link useMediaWithFallback}): Concord
 * uploads are decrypted, plain URLs load under the media policy (a forwarded
 * chip would otherwise leak the forwarder's address to the original host).
 */
function AttachmentPreviewImage({
  url,
  mime,
  encryption,
  alt,
}: {
  url: string;
  mime: string;
  encryption?: ImetaEncryption;
  alt?: string;
}) {
  const { resolved, onError, failed } = useMediaWithFallback({ url, encryption, mime });
  if (resolved.status !== "ready" || failed) {
    return (
      <span className="flex size-full items-center justify-center bg-secondary/40">
        {resolved.status === "loading" && !failed ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <Paperclip className="size-5 text-muted-foreground" />
        )}
      </span>
    );
  }
  return <img src={resolved.src} alt={alt ?? "attachment"} onError={onError} className="size-full object-cover" />;
}

/** Alt text (imeta `alt`), spoiler and remove; the touch home for a card's actions. */
function AttachmentEditDialog({
  item,
  onClose,
  onPreview,
  onRemove,
  onSave,
}: {
  item: TrayAttachment | undefined;
  onClose: () => void;
  onPreview: (url: string) => void;
  onRemove: (url: string) => void;
  onSave: (url: string, patch: { alt?: string; spoiler?: boolean }) => void;
}) {
  const [alt, setAlt] = useState("");
  const [spoiler, setSpoiler] = useState(false);
  // Seeded when a different attachment is opened, not on every edit to it.
  const [seededFor, setSeededFor] = useState<string | undefined>(undefined);
  if (item?.url !== seededFor) {
    setSeededFor(item?.url);
    setAlt(item?.alt ?? "");
    setSpoiler(item?.spoiler ?? false);
  }

  const previewable = !!item && (item.isImage || item.isVideo);

  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{item?.label ?? "Attachment"}</DialogTitle>
          <DialogDescription>Describe it for people who can't see it, or hide it behind a spoiler.</DialogDescription>
        </DialogHeader>
        {item && (
          <div className="space-y-4">
            {previewable && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onPreview(item.url);
                }}
                className="relative mx-auto block aspect-square w-40 cursor-zoom-in overflow-hidden rounded-lg bg-secondary/50"
                aria-label={`Preview ${item.label}`}
              >
                <CardPreview item={item} />
              </button>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="attachment-alt">Description (alt text)</Label>
              <Textarea
                id="attachment-alt"
                value={alt}
                onChange={(e) => setAlt(e.target.value.replace(/[\r\n]+/g, " "))}
                maxLength={MAX_ALT_CHARS}
                rows={3}
                placeholder="What's in this attachment?"
              />
            </div>
            {previewable && (
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="attachment-spoiler" className="flex flex-col gap-0.5">
                  <span>Mark as spoiler</span>
                  <span className="text-xs font-normal text-muted-foreground">Blurred until someone taps it.</span>
                </Label>
                <Switch id="attachment-spoiler" checked={spoiler} onCheckedChange={setSpoiler} />
              </div>
            )}
          </div>
        )}
        <DialogFooter className="flex-row gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => {
              if (item) onRemove(item.url);
              onClose();
            }}
          >
            <Trash2 className="size-4" />
            Remove
          </Button>
          <Button
            type="button"
            className="ml-auto sm:ml-0"
            onClick={() => {
              if (item) onSave(item.url, { alt: alt.trim(), spoiler });
              onClose();
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
