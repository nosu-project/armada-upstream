import { Capacitor } from "@capacitor/core";
import { Download, File, FileArchive, FileText, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import { toast } from "@/hooks/useToast";
import { downloadBinaryFile } from "@/lib/downloadFile";
import {
  decryptBuffer,
  fetchCapped,
  MAX_EXPLICIT_DECRYPT_BYTES,
  verifyPlaintextHash,
} from "@/lib/encryptedMedia";
import { formatBytes } from "@/lib/fileBytes";
import { cn } from "@/lib/utils";

import type { ImetaEncryption } from "@/lib/imeta";

interface FileAttachmentProps {
  url: string;
  /** Sender-declared MIME — an ICON HINT ONLY. Never used to render the bytes. */
  mime?: string;
  /** Original filename (sender-declared, untrusted). */
  name?: string;
  /** Sender-declared byte size, for the label. */
  size?: number;
  /** AES-GCM decryption params for client-encrypted (Concord/Vector) blobs. */
  encryption?: ImetaEncryption;
  className?: string;
}

/**
 * Sanitize a sender-supplied filename for display and for the `download`
 * attribute. The `name` field is attacker-controlled, so strip path separators
 * (no directory traversal), control chars, and leading dots; cap the length.
 * Returns a safe fallback when nothing usable remains.
 */
function safeFilename(name: string | undefined): string {
  if (!name) return "download";
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return cleaned || "download";
}

/** Pick a coarse icon from the MIME family. Cosmetic only. */
function iconFor(mime: string | undefined) {
  const m = (mime ?? "").toLowerCase();
  if (/(zip|tar|gzip|rar|7z|compress)/.test(m)) return FileArchive;
  if (m.startsWith("text/") || /(pdf|json|xml|csv|msword|document|spreadsheet|presentation)/.test(m)) {
    return FileText;
  }
  return File;
}

/**
 * Download-only card for a non-media attachment (PDF, zip, arbitrary document).
 *
 * SECURITY: the bytes are never rendered, previewed, embedded, or opened
 * in-tab — a hostile PDF/HTML/SVG can't execute or be displayed here. On click
 * the blob is fetched (and AES-GCM-decrypted for encrypted Concord/Vector
 * attachments), then handed to {@link downloadBinaryFile} as a forced *save*.
 * On the web that is an `application/octet-stream` object URL + a `download`
 * filename, so even a stray navigation downloads rather than renders; on native
 * the bytes go to the app's Documents directory, because the anchor pattern
 * silently fails in the WebView — it reported success here while saving
 * nothing. Only the filename survives to name the file, so what keeps a
 * traversal or control-char name from escaping is `safeFilename`. The sender's
 * MIME is used only to choose an icon.
 */
export function FileAttachment({ url, mime, name, size, encryption, className }: FileAttachmentProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  const displayName = safeFilename(name);
  const Icon = iconFor(mime);

  const download = useCallback(async () => {
    if (status === "loading") return;
    setStatus("loading");
    try {
      // The ceiling is enforced while READING, not after: checking a fully
      // buffered body has already spent the memory it was meant to protect,
      // and a `size` field is sender-controlled so it proves nothing.
      const raw = await fetchCapped(url, { maxBytes: MAX_EXPLICIT_DECRYPT_BYTES });

      const bytes = encryption
        ? new Uint8Array(await decryptBuffer(raw, encryption.key, encryption.nonce))
        : new Uint8Array(raw);
      // A swapped blob fails closed rather than being saved to the user's disk
      // under the sender's filename.
      if (encryption) verifyPlaintextHash(bytes, encryption.ox);

      // Force a save, never a render. The sender's real MIME is deliberately
      // discarded: the web branch of `downloadBinaryFile` hands the bytes over
      // as octet-stream, and on native they are written to disk unopened.
      await downloadBinaryFile(displayName, bytes);
      if (Capacitor.isNativePlatform()) {
        toast({ title: "Saved", description: "You'll find it in the Armada folder in Files." });
      }
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }, [status, url, encryption, displayName]);

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
            : [size ? formatBytes(size) : null, "Tap to download"].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="size-8 shrink-0 rounded-full flex items-center justify-center text-muted-foreground group-hover:text-foreground">
        {status === "loading" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
      </span>
    </button>
  );
}
