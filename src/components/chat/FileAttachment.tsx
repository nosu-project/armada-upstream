import { Capacitor } from "@capacitor/core";
import { Download, File, FileArchive, FileAudio, FileImage, FileText, FileVideo, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import { useBlossomCandidates } from "@/hooks/useBlossomCandidates";
import { toast } from "@/hooks/useToast";
import { downloadBinaryFile } from "@/lib/downloadFile";
import {
  decryptBuffer,
  fetchCapped,
  MAX_EXPLICIT_DECRYPT_BYTES,
  verifyPlaintextHash,
} from "@/lib/encryptedMedia";
import { formatBytes, safeFilename } from "@/lib/fileBytes";
import { cn } from "@/lib/utils";

import type { ImetaEncryption } from "@/lib/imeta";

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
 * Download-only card for non-media attachments.
 * SECURITY: bytes are never rendered or opened. Web: octet-stream object URL
 * + `download`; native: written to Documents (the anchor silently fails in the
 * WebView). `safeFilename` guards the name; the sender's MIME only picks an icon.
 */
export function FileAttachment({ url, mime, name, size, encryption, fallbacks, className }: FileAttachmentProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  const displayName = safeFilename(name);
  const Icon = iconFor(mime);
  const kind = typeLabel(displayName, mime);
  // Mirrors on the viewer's other Blossom servers. Fetched directly, not via the
  // image proxy (that's for passive display).
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
    }
  }, [status, candidates, encryption, displayName]);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void download();
      }}
      className={cn(
        "group my-1.5 flex items-center gap-3 max-w-sm rounded-2xl border border-border bg-secondary/30 px-3 py-2.5 text-left hover:bg-secondary/50 transition-colors",
        className,
      )}
    >
      <span className="size-10 shrink-0 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{displayName}</span>
        <span className="block text-[11px] text-muted-foreground tabular-nums">
          {status === "error"
            ? "Download failed — tap to retry"
            : [kind, size ? formatBytes(size) : null, "Tap to download"].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="size-8 shrink-0 rounded-full flex items-center justify-center text-muted-foreground group-hover:text-foreground">
        {status === "loading" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
      </span>
    </button>
  );
}
