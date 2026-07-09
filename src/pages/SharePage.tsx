import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Copy, MessageSquareLock, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";

/**
 * Landing route for content shared into Armada via the Web Share Target API
 * (installed PWA). The browser delivers `title`, `text`, and `url` as separate
 * query params; which of them are populated varies by source app.
 *
 * Armada is group- and DM-centric — there's no global feed to post to — so
 * this page shows the shared content, lets the user copy it to the clipboard,
 * and offers a shortcut to their DMs where they can paste it.
 */
export function SharePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const rawText = params.get("text") ?? "";
  const title = params.get("title") ?? "";
  const url = params.get("url") ?? "";

  // Merge the separate Web Share Target params into one text blob, skipping
  // parts already present in `text` (some apps put the URL in both).
  const text = useMemo(() => {
    const parts: string[] = [];
    if (title && !rawText.includes(title)) parts.push(title);
    if (rawText) parts.push(rawText);
    if (url && !rawText.includes(url)) parts.push(url);
    return parts.join("\n");
  }, [title, rawText, url]);

  const handleCopy = async () => {
    try {
      await writeClipboardText(text);
      toast({ description: "Copied to clipboard" });
    } catch {
      toast({ description: "Could not copy — try selecting the text manually", variant: "destructive" });
    }
  };

  const handleDismiss = () => navigate("/", { replace: true });

  return (
    <main className="flex-1 min-w-0 overflow-y-auto safe-area-top safe-area-bottom">
      <div className="mx-auto flex min-h-full max-w-xl flex-col items-center justify-center gap-6 px-6 py-16">
        <div className="w-full space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold leading-tight">Shared content</h1>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Dismiss"
              onClick={handleDismiss}
            >
              <X className="size-4" />
            </Button>
          </div>

          {/* Shared text preview */}
          <div className="bg-chrome clip-corner-lg p-4">
            <p className="whitespace-pre-wrap break-words text-sm text-foreground/90 leading-relaxed">
              {text || <span className="text-muted-foreground italic">Nothing shared</span>}
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2.5">
            <Button
              size="lg"
              className="h-12 w-full clip-corner-lg text-base font-medium"
              onClick={handleCopy}
              disabled={!text}
            >
              <Copy className="size-4 mr-2" />
              Copy to clipboard
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="h-12 w-full clip-corner-lg text-base font-medium"
              onClick={() => navigate("/dms", { replace: true })}
            >
              <MessageSquareLock className="size-4 mr-2" />
              Go to DMs
            </Button>
            <button
              type="button"
              onClick={handleDismiss}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground text-center mt-1"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

export default SharePage;
