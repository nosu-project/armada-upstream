import QRCode from "qrcode";
import { Check, Copy, Link2, Loader2, Share2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { writeClipboardText } from "@/lib/clipboard";
import { getThemedQRColors } from "@/lib/qrColors";
import { tryNpubEncode } from "@/lib/safeNip19";
import { canShare, share as nativeShare } from "@/lib/share";
import { shareOrigin } from "@/lib/shareOrigin";

interface ProfileShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Share your profile": a QR code and a copyable link that open the current
 * account's profile in Armada (the bare-`/<npub>` route `UserPage` serves).
 * Built on {@link shareOrigin} so the link resolves to the public web
 * deployment even on native, where the WebView's own origin is unreachable.
 * The QR is tinted with the live theme's brand color via {@link getThemedQRColors},
 * darkened/lightened only as far as scannable contrast requires.
 */
export function ProfileShareDialog({ open, onOpenChange }: ProfileShareDialogProps) {
  const { user } = useCurrentUser();
  const author = useAuthor(user?.pubkey);
  const metadata = author.data?.metadata;
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");

  const npub = tryNpubEncode(user?.pubkey);
  const displayName = metadata?.name || metadata?.display_name || "your profile";
  const url = npub ? `${shareOrigin()}/${npub}` : "";

  useEffect(() => {
    if (!url || !open) return;
    // Read the theme's colors when the dialog opens (not at module load), so a
    // theme switch behind the dialog is reflected the next time it's shown.
    const { dark, light } = getThemedQRColors();
    // Render to an SVG rather than a canvas data URL: canvas-fingerprint
    // blockers (Brave, Tor Browser, resistFingerprinting) poison or refuse the
    // toDataURL/getImageData readback, which left this QR blank. SVG never
    // touches a canvas, so it is immune to any canvas policy. It's carried to
    // the <img> as a data URL (not innerHTML), so the browser script-sandboxes
    // it — and the QR content lives in path modules, never as markup anyway.
    QRCode.toString(url, {
      type: "svg",
      width: 400,
      margin: 2,
      color: { dark, light },
      errorCorrectionLevel: "M",
    })
      .then((svg) => setQrDataUrl(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`))
      .catch(() => setQrDataUrl(""));
  }, [url, open]);

  const copy = () => {
    if (!url) return;
    writeClipboardText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const share = () => {
    if (!url) return;
    void nativeShare({
      title: `${displayName} on Armada`,
      text: "Find me on Armada",
      url,
    });
  };

  const showShare = canShare();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title="Share your profile"
        // Radix otherwise auto-focuses the first control (the link button),
        // parking a focus ring on the npub the moment the dialog opens.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <Avatar shape={getAvatarShape(metadata)} className="size-14 ring-2 ring-primary/20">
            <AvatarImage src={metadata?.picture} alt={displayName} />
            <AvatarFallback className="text-lg font-semibold">
              {displayName.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            share your profile
          </h2>
          <p className="text-sm text-muted-foreground">
            Scan or share this link to open{" "}
            <span className="text-foreground">{displayName}</span> in Armada.
          </p>
        </div>

        <div className="mt-6 space-y-4 min-w-0">
          {!url ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Preparing your link…
            </div>
          ) : (
            <>
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Profile QR code"
                  className="mx-auto w-64 clip-corner-lg"
                  decoding="async"
                />
              ) : (
                <div className="mx-auto size-64 clip-corner-lg bg-muted animate-pulse" />
              )}

              {/* The link, front and center. */}
              <button
                type="button"
                onClick={copy}
                className="group w-full min-w-0 max-w-full overflow-hidden flex items-center gap-2 clip-corner-lg border-transparent bg-background/40 px-3 py-3 text-left transition-colors hover:bg-background/70"
              >
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 min-w-0 truncate font-mono text-sm">{url}</span>
                {copied
                  ? <Check className="size-4 shrink-0 text-primary" />
                  : <Copy className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />}
              </button>

              <div className="flex gap-2">
                <Button className="flex-1 clip-corner-lg" onClick={copy}>
                  {copied
                    ? <><Check className="size-4 mr-2" /> Copied!</>
                    : <><Copy className="size-4 mr-2" /> Copy link</>}
                </Button>
                {showShare && (
                  <Button variant="outline" className="clip-corner-lg" onClick={share} aria-label="Share">
                    <Share2 className="size-4" />
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
