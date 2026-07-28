import { Download, File, FileArchive, FileText, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import { decryptBytes } from "@/lib/encryptedMedia";
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

/** Hard ceiling on a decrypted download; guards against a hostile `size` lie
 *  turning a click into an unbounded fetch that OOMs the tab. */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** Human-readable byte size (1024-based). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
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
 * attachments), then handed to the browser as a forced *save* via an
 * `application/octet-stream` object URL + a `download` filename. octet-stream
 * means even a stray navigation downloads rather than renders. The sender's
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
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = new Uint8Array(await res.arrayBuffer());
      if (raw.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("attachment too large");

      const bytes = encryption
        ? await decryptBytes(raw, encryption.key, encryption.nonce)
        : raw;

      // Force a save, never a render: octet-stream + download attribute. The
      // sender's real MIME is deliberately discarded here.
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = displayName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a tick to start the save before revoking.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
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
