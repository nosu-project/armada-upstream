import { Blocks, EyeOff, Eye, FileIcon, Loader2, Paperclip, Pencil, Play, Trash2, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";
import { companionEncryption } from "@/lib/imeta";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";

import type { ImetaEncryption } from "@/lib/imeta";

/** The longest description the edit dialog accepts. */
export const MAX_ALT_CHARS = 1000;

/** An uploaded attachment, ready to send. */
export interface TrayAttachment {
  kind: "attachment";
  url: string;
  mime: string;
  /** The file's name where known — the card's tooltip and accessible name. */
  label: string;
  /** A webxdc icon, or a video's poster frame. */
  icon?: string;
  isImage: boolean;
  isVideo: boolean;
  isWebxdc: boolean;
  encryption?: ImetaEncryption;
  alt?: string;
  spoiler: boolean;
}

/** An attachment still being processed or uploaded. */
export interface TrayPending {
  kind: "pending";
  id: string;
  label: string;
  /** A local object URL of the picked image, shown while it uploads. */
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
 * The attachments staged above the composer: a row of thumbnails that scrolls
 * sideways, uploads spinning in place, and every card carrying its own
 * actions — spoiler, description, remove. The spoiler toggle sits on every
 * image and video card at all times, on touch and desktop alike: it is the one
 * action a sender needs BEFORE sending, and one hidden behind hover or an
 * unmarked tap is one nobody finds.
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

/**
 * A bare thumbnail, Signal-style: the picture is the identification, so no
 * caption. (A document, which has no picture, names itself inside the square.)
 */
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
            <span className="rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold tracking-wide text-white">SPOILER</span>
          </span>
        )}
        {item.alt && (
          <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[9px] font-bold text-white">ALT</span>
        )}
        {/* The tap opens the editor on touch; say so on the card itself. */}
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

/**
 * The always-visible spoiler switch in a card's bottom-right corner: a small
 * disc, inside a 44px target on touch. Filled with the accent while on, so the
 * state reads at a glance as well as from the SPOILER veil.
 */
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
                <span className="text-[10px] font-semibold tabular-nums text-white">{percent}%</span>
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

/** A determinate ring around the pending card's percentage. */
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

/** What fills a card's square: the image, the video's poster, or a file glyph. */
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
  if (item.isWebxdc) {
    const icon = sanitizeImageSrc(item.icon);
    return (
      <span className="flex size-full items-center justify-center">
        {icon ? <img src={icon} alt="" className="size-10 rounded-lg object-cover" /> : <Blocks className="size-8 text-primary" />}
      </span>
    );
  }
  return (
    <span className="flex size-full flex-col items-center justify-center gap-1.5 px-1.5 text-muted-foreground">
      <FileIcon className="size-7 shrink-0" />
      <span className="line-clamp-2 break-all text-center text-[10px] font-medium leading-tight">{item.label}</span>
    </span>
  );
}

/**
 * Composer attachment thumbnail. Plain uploads point an <img> at the URL;
 * encrypted (Concord) uploads are ciphertext on Blossom, so this resolves them
 * through {@link useResolvedMediaSrc} (fetch + AES-GCM decrypt to an object URL)
 * exactly like the message render path, so the local preview isn't a broken img.
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
  const resolved = useResolvedMediaSrc(encryption ? { url, encryption, mime } : url);
  if (resolved.status !== "ready") {
    return (
      <span className="flex size-full items-center justify-center bg-secondary/40">
        {resolved.status === "loading" ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <Paperclip className="size-5 text-muted-foreground" />
        )}
      </span>
    );
  }
  return <img src={resolved.src} alt={alt ?? "attachment"} className="size-full object-cover" />;
}

/**
 * Discord's attachment editor: a description (alt text, sent as the imeta
 * `alt`) and the spoiler switch, plus remove — the one place all of a card's
 * actions live on touch, where there is no hover toolbar.
 */
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
