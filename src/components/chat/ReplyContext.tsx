import { ReplyContextLine, ReplyContextUnavailable, ReplyPreview, ReplyThumbnail } from "@/components/chat/ChatMessage";
import { firstImageRef } from "@/components/chat/messageHelpers";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";

import type { ChatMsg } from "@/components/chat/transport";

/**
 * "Replying to …" line for a parent the caller already resolved (Concord and
 * DMs; NIP-29 fetches in {@link GroupChat}). An unresolved parent still gets a
 * line, whose jump pages back to it.
 */
export function ReplyContext({
  parentId,
  parent,
  onJump,
}: {
  parentId: string;
  parent: ChatMsg | undefined;
  onJump: (id: string) => void;
}) {
  const author = useAuthor(parent?.pubkey);
  const name = useScopedDisplayName(parent?.pubkey, author.data?.metadata);
  if (!parent) return <ReplyContextUnavailable onClick={() => onJump(parentId)} />;
  const image = firstImageRef(parent);
  return (
    <ReplyContextLine
      name={name}
      pubkey={parent.pubkey}
      preview={<ReplyPreview content={parent.content} tags={parent.tags} hideMediaPlaceholder={!!image} />}
      thumbnail={image ? <ReplyThumbnail image={image} /> : undefined}
      onClick={() => onJump(parent.id)}
    />
  );
}
