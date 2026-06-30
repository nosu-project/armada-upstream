import { Fragment } from "react";

import { MESH_MENTION_REGEX, meshSuffix } from "@/lib/meshIdentity";
import { cn } from "@/lib/utils";

import type { MeshPeer } from "@/lib/bluetoothMesh";

interface MeshContentProps {
  /** The message body (plain mesh text). */
  content: string;
  /** Nearby peers, used to color a mention chip by the mentioned peer's id. */
  peers: MeshPeer[];
  /** Our own peer id, so a mention of us is highlighted. */
  myPeerID: string | null;
  className?: string;
}

/**
 * Renders a Bluetooth-mesh message body. Mesh content is plain text (no Nostr
 * tokens), so this is deliberately lighter than `ChatContent`: it only turns
 * `@name#suffix` mesh-mention tokens into colored chips. A mention of the local
 * user (matched by the unique peer-id suffix) is emphasized.
 */
export function MeshContent({ content, peers, myPeerID, className }: MeshContentProps) {
  // Color a mention by the mentioned peer's id when that peer is nearby; the
  // suffix (peer-id tail) is the stable key. Falls back to the primary color.
  const colorBySuffix = new Map<string, string>();
  for (const p of peers) colorBySuffix.set(meshSuffix(p.peerID), p.peerID);
  const mySuffix = myPeerID ? meshSuffix(myPeerID) : null;

  const nodes: React.ReactNode[] = [];
  const re = new RegExp(MESH_MENTION_REGEX.source, "giu");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = re.exec(content)) !== null) {
    const [token, name, suffix] = match;
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={key++}>{content.slice(lastIndex, match.index)}</Fragment>);
    }
    const lowerSuffix = suffix.toLowerCase();
    const isMe = mySuffix !== null && lowerSuffix === mySuffix;
    nodes.push(
      <span
        key={key++}
        className={cn(
          "rounded px-1 font-medium",
          isMe ? "bg-primary/20 text-primary" : "bg-secondary/60 text-foreground",
        )}
        title={token}
      >
        @{name}
      </span>,
    );
    lastIndex = match.index + token.length;
  }
  if (lastIndex < content.length) {
    nodes.push(<Fragment key={key++}>{content.slice(lastIndex)}</Fragment>);
  }

  return <span className={cn("whitespace-pre-wrap break-words", className)}>{nodes}</span>;
}
