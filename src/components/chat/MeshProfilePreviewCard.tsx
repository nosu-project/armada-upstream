import { AtSign, Check, Copy, MessageSquare } from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { writeClipboardText } from "@/lib/clipboard";

import type { MessageIdentity } from "@/components/chat/MessageRow";

interface MeshProfilePreviewCardProps {
  /** The peer id of the author (a mesh peer id, not a Nostr pubkey). */
  peerID: string;
  /** The resolved mesh identity (name/color/suffix) of the author. */
  identity: MessageIdentity;
  /** Whether this author is the local user (hides the action buttons). */
  isSelf?: boolean;
  /** Open the Noise XX DM with this peer. Omitted when already in that DM. */
  onMessage?: (peerID: string) => void;
  /** Insert an @-mention of this peer into the composer. */
  onMention?: (peerID: string) => void;
  /** The trigger element (the avatar or name). Rendered as the popover trigger. */
  children: React.ReactNode;
}

/** The body of the mesh peer preview — avatar, name, peer id, and actions. */
function MeshProfilePreviewBody({
  peerID,
  identity,
  isSelf,
  onMessage,
  onMention,
  onAction,
}: Omit<MeshProfilePreviewCardProps, "children"> & { onAction: () => void }) {
  const [copied, setCopied] = useState(false);
  const name = identity.name;
  const color = identity.color;
  const suffix = identity.suffix;

  const copyPeerID = () => {
    writeClipboardText(peerID).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };

  const message = () => {
    onAction();
    onMessage?.(peerID);
  };

  const mention = () => {
    onAction();
    onMention?.(peerID);
  };

  return (
    <>
      {/* Mini banner tinted with the peer's deterministic color. */}
      <div
        className="h-16 relative"
        style={color ? { backgroundColor: `${color}33` } : undefined}
      />

      <div className="px-4 pb-4">
        {/* Avatar overlapping the banner. */}
        <div className="-mt-8 mb-2">
          <Avatar className="size-16 border-[3px] border-background">
            <AvatarFallback
              className="text-lg"
              style={color ? { backgroundColor: `${color}33`, color } : undefined}
            >
              {name[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </div>

        {/* Name + #suffix. */}
        <div className="font-bold text-[15px] truncate inline-flex items-baseline gap-1 max-w-full">
          <span className="truncate" style={color ? { color } : undefined}>
            {name}
          </span>
          {suffix && (
            <span className="text-[11px] font-normal text-muted-foreground/70 shrink-0">
              #{suffix}
            </span>
          )}
        </div>

        {/* Peer id (copyable). */}
        <button
          type="button"
          onClick={copyPeerID}
          className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title="Copy peer id"
        >
          <span className="font-mono">{peerID}</span>
          {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
        </button>

        <p className="text-xs text-muted-foreground/70 mt-2">
          Nearby mesh peer
        </p>

        {/* Actions. */}
        {!isSelf && (
          <div className="mt-3 flex items-center gap-2">
            {onMessage && (
              <Button size="sm" className="flex-1 clip-corner-lg h-8" onClick={message}>
                <MessageSquare className="size-3.5 mr-1.5" />
                Message
              </Button>
            )}
            {onMention && (
              <Button
                size="sm"
                variant="secondary"
                className="flex-1 clip-corner-lg h-8"
                onClick={mention}
              >
                <AtSign className="size-3.5 mr-1.5" />
                Mention
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Wraps a trigger element (an avatar or author name) with a click-triggered
 * popover showing a compact preview of a Bluetooth-mesh peer. Mirrors
 * `ProfilePreviewCard`, but for mesh peers (which are NOT Nostr identities, so
 * there's no profile/npub): it shows the peer's mesh identity and offers two
 * mesh-native actions — "Message" opens the existing Noise XX DM with the peer,
 * and "Mention" inserts an `@name#suffix` token into the composer.
 */
export function MeshProfilePreviewCard({
  peerID,
  identity,
  isSelf,
  onMessage,
  onMention,
  children,
}: MeshProfilePreviewCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-72 p-0 rounded-2xl overflow-hidden border border-border shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {open && (
          <MeshProfilePreviewBody
            peerID={peerID}
            identity={identity}
            isSelf={isSelf}
            onMessage={onMessage}
            onMention={onMention}
            onAction={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
