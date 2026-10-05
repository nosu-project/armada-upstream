import { Capacitor } from "@capacitor/core";
import { Box, Download, File, FileArchive, FileAudio, FileImage, FileText, FileVideo, Loader2, Rotate3d } from "lucide-react";
import { lazy, Suspense, useCallback, useState } from "react";

import { useBlossomCandidates } from "@/hooks/useBlossomCandidates";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { toast } from "@/hooks/useToast";
import { downloadBinaryFile } from "@/lib/downloadFile";
import {
  decryptBuffer,
  fetchCapped,
  MAX_EXPLICIT_DECRYPT_BYTES,
  verifyPlaintextHash,
} from "@/lib/encryptedMedia";
import { formatBytes, safeFilename } from "@/lib/fileBytes";
import { companionEncryption } from "@/lib/imeta";
import { modelFormat } from "@/lib/mediaUrls";
import { cn } from "@/lib/utils";

import type { ImetaEncryption } from "@/lib/imeta";

const ModelViewer = lazy(() => import("@/components/chat/ModelViewer"));

interface FileAttachmentProps {
  url: string;
  /** Sender-declared MIME — an ICON HINT ONLY. Never used to render the bytes. */
  mime?: string;
  /** Sender-declared, untrusted. */
  name?: string;
  size?: number;
  /** AES-GCM decryption params for client-encrypted (Concord/Vector) blobs. */
  encryption?: ImetaEncryption;
  /** Sender-declared alternative sources (imeta `fallback`), tried after `url`. */
  fallbacks?: string[];
  /**
   * imeta `thumb`/`image`, under the file's key when encrypted. Shown for 3D
   * models only; the caller passes none while the message's media is held.
   */
  thumbnail?: string;
  /** Always the plain download row, never the 3D card (e.g. the pin bar). */
  compact?: boolean;
  className?: string;
}

function iconFor(mime: string | undefined) {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("video/")) return FileVideo;
  if (m.startsWith("audio/")) return FileAudio;
  if (m.startsWith("image/")) return FileImage;
  if (/(zip|tar|gzip|rar|7z|compress)/.test(m)) return FileArchive;
  if (m.startsWith("text/") || /(pdf|json|xml|csv|msword|document|spreadsheet|presentation)/.test(m)) {
    return FileText;
  }
  return File;
}

/** Always-visible type token (e.g. "AVI"); hashed filenames hide the extension under truncation. */
function typeLabel(name: string, mime: string | undefined): string | null {
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase();
  const sub = (mime ?? "").split("/")[1];
  if (sub) return sub.replace(/^x-/, "").replace(/^vnd\./, "").toUpperCase();
  return null;
}

/**
 * Download card for non-media attachments.
 * SECURITY: bytes are never rendered as a document or opened. Web:
 * octet-stream object URL + `download`; native: written to Documents (the
 * anchor silently fails in the WebView). `safeFilename` guards the name; the
 * sender's MIME picks an icon, and for a 3D model the parser three.js draws it
 * with — on a tap, into a canvas, with no outside resources (`modelRenderer`).
 */
export function FileAttachment({ url, mime, name, size, encryption, fallbacks, thumbnail, compact, className }: FileAttachmentProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [viewing3d, setViewing3d] = useState(false);

  const displayName = safeFilename(name);
  const Icon = iconFor(mime);
  const kind = typeLabel(displayName, mime);
  const format = compact ? undefined : modelFormat(mime, name ?? url);
  // Mirrors on the viewer's other Blossom servers. Fetched directly, not via the
  // image proxy (that's for passive display): a download or a model is a deliberate open.
  const candidates = useBlossomCandidates(url, fallbacks);

  const download = useCallback(async () => {
    if (status === "loading") return;
    setStatus("loading");
    try {
      // Cap enforced while READING; the `size` field is sender-controlled.
      const raw = await fetchCapped(candidates, { maxBytes: MAX_EXPLICIT_DECRYPT_BYTES });

      const bytes = encryption
        ? new Uint8Array(await decryptBuffer(raw, encryption.key, encryption.nonce))
        : new Uint8Array(raw);
      // A swapped blob fails closed.
      if (encryption) await verifyPlaintextHash(bytes, encryption.ox);

      // Force a save, never a render; the sender's MIME is discarded.
      await downloadBinaryFile(displayName, bytes);
      if (Capacitor.isNativePlatform()) {
        toast({ title: "Saved", description: "You'll find it in the Armada folder in Files." });
      }
      setStatus("idle");
    } catch {
      setStatus("error");
      // A model card has no status line to say so.
      if (format) toast({ title: "Download failed", description: displayName, variant: "destructive" });
    }
  }, [status, candidates, encryption, displayName, format]);

  // A viewable model is its own card; its download lives in the viewer.
  if (format) {
    return (
      <div
        className={cn("my-1.5 w-full max-w-md overflow-hidden clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.3] [--fill-hover:var(--secondary)/0.3]", className)}
        onClick={(e) => e.stopPropagation()}
      >
        {viewing3d ? (
          <div className="relative">
            <Suspense
              fallback={
                <div className="flex aspect-[4/3] items-center justify-center bg-muted">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <ModelViewer candidates={candidates} format={format} encryption={encryption} />
            </Suspense>
            <button
              type="button"
              onClick={() => void download()}
              disabled={status === "loading"}
              aria-label={`Download ${displayName}`}
              className="absolute right-3 top-3 z-10 flex size-10 touch:size-11 items-center justify-center clip-corner-lg bg-background/90 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {status === "loading" ? <Loader2 className="size-5 animate-spin" /> : <Download className="size-5" />}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setViewing3d(true)}
            aria-label={`View ${displayName} in 3D`}
            className="relative block aspect-[4/3] w-full bg-gradient-to-b from-muted/40 to-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {thumbnail ? (
              <ModelPreview url={thumbnail} encryption={encryption} />
            ) : (
              <ModelPlaceholder />
            )}
            <span className="absolute inset-x-0 bottom-0 flex justify-center p-4">
              <span className="inline-flex items-center gap-2 clip-corner-lg bg-background/90 px-4 py-2 text-sm font-medium shadow-sm backdrop-blur transition-colors hover:bg-background">
                <Rotate3d className="size-4" />
                View in 3D
                {size ? <span className="text-muted-foreground tabular-nums">· {formatBytes(size)}</span> : null}
              </span>
            </span>
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void download();
      }}
      className={cn(
        "group my-1.5 flex w-full items-center gap-3 max-w-sm clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.3] [--fill-hover:var(--secondary)/0.5] px-3 py-2.5 text-left",
        className,
      )}
    >
      <span className="size-10 shrink-0 clip-corner-lg bg-primary/10 text-primary flex items-center justify-center">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{displayName}</span>
        <span className="block text-2xs text-muted-foreground tabular-nums">
          {status === "error"
            ? "Download failed. Tap to retry"
            : [kind, size ? formatBytes(size) : null, "Tap to download"].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="size-8 shrink-0 rounded-full flex items-center justify-center text-muted-foreground group-hover:text-foreground">
        {status === "loading" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
      </span>
    </button>
  );
}

function ModelPlaceholder() {
  return (
    <span className="flex size-full items-center justify-center">
      <Box className="size-16 text-muted-foreground/50" />
    </span>
  );
}

/** The sender's still of the model, through the media policy like any passive image. */
function ModelPreview({ url, encryption }: { url: string; encryption?: ImetaEncryption }) {
  const { resolved, onError, failed } = useMediaWithFallback({
    url,
    // NIP-17: a `thumb` shares the file's key and nonce, not its `ox`.
    encryption: companionEncryption(encryption),
    mime: "image/png",
  });
  if (failed || resolved.status !== "ready") return <ModelPlaceholder />;
  return <img src={resolved.src} alt="" decoding="async" onError={onError} className="block size-full object-contain" />;
}
