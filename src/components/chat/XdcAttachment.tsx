import { Blocks } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useApps } from "@/hooks/useApps";
import { useChatScope } from "@/hooks/useChatScope";
import { deriveUrlTopicId } from "@/lib/webxdcRealtime";
import { appScopeKey } from "@/contexts/AppsContext";
import type { ImetaEntry } from "@/lib/imeta";

/**
 * A `.xdc` (webxdc app) attachment rendered in a chat message. Shows a launch
 * card; clicking it opens the app in the top-of-chat app stage, joined to the
 * shared coordination session identified by the attachment's `webxdc` uuid (so
 * everyone who launches the same attachment shares state). Falls back to a
 * plain download link when there's no chat scope to launch into.
 */
export function XdcAttachment({
  url,
  imeta,
  messageId,
}: {
  url: string;
  imeta?: ImetaEntry;
  /** The rumor id of the message carrying this app, hex. */
  messageId?: string;
}) {
  const scope = useChatScope();
  const { activeApp, launchApp } = useApps();
  const name = imeta?.summary || "Webxdc app";
  // An uploaded app carries a minted topic; a pasted link has no file event to
  // carry one, so every client derives the same topic from the URL and the
  // message id. Without this a link opens into a session only this client is
  // in — which looks like working multiplayer with nobody else ever arriving.
  const sessionId = imeta?.webxdc ?? (messageId ? deriveUrlTopicId(url, messageId) : undefined);
  // A published game's icon is a plaintext URL; an encrypted attachment's thumb
  // is ciphertext (would render broken), so only show it when unencrypted.
  const icon = imeta?.encryption ? undefined : imeta?.thumbnail;

  const openHere = Boolean(
    activeApp &&
      scope &&
      appScopeKey(activeApp.scope) === appScopeKey(scope) &&
      activeApp.app.type === "webxdc" &&
      sessionId &&
      activeApp.sessionId === sessionId,
  );

  const handleLaunch = () => {
    if (!scope) return;
    launchApp(scope, { type: "webxdc", url, name, encryption: imeta?.encryption }, sessionId);
  };

  return (
    <div
      className="my-1.5 flex items-center gap-3 max-w-sm rounded-xl border border-border bg-secondary/30 px-3.5 py-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="size-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
        {/* A published game carries a plaintext icon URL; an encrypted
            attachment's thumb is ciphertext, so fall back to the glyph there. */}
        {icon ? (
          <img src={icon} alt="" className="size-full object-cover" />
        ) : (
          <Blocks className="size-4.5 text-primary" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold truncate">{name}</p>
        <p className="text-xs text-muted-foreground">Webxdc app</p>
      </div>
      {scope ? (
        <Button size="sm" className="h-8 shrink-0" onClick={handleLaunch} disabled={openHere}>
          {openHere ? "Open" : "Launch"}
        </Button>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline shrink-0"
        >
          Download
        </a>
      )}
    </div>
  );
}
