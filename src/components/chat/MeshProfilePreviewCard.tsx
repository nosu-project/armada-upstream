import { AtSign, Check, Copy, MessageSquare } from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { writeClipboardText } from "@/lib/clipboard";

import type { MessageIdentity } from "@/components/chat/MessageRow";

interface MeshProfilePreviewCardProps {
  /** A mesh peer id, not a Nostr pubkey. */
  peerID: string;
  identity: MessageIdentity;
  /** Hides the action buttons. */
  isSelf?: boolean;
  /** Open the Noise XX DM with this peer. Omitted when already in that DM. */
  onMessage?: (peerID: string) => void;
  onMention?: (peerID: string) => void;
  children: React.ReactNode;
}

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
      <div
        className="h-16 relative"
        style={color ? { backgroundColor: `${color}33` } : undefined}
      />

      <div className="px-4 pb-4">
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
 * Popover preview for a mesh peer (no Nostr profile), mirroring
 * `ProfilePreviewCard`, with Message (Noise XX DM) and Mention actions.
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
