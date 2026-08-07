import { ReplyContextLine, ReplyPreview, ReplyThumbnail } from "@/components/chat/ChatMessage";
import { firstImageRef } from "@/components/chat/messageHelpers";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";

import type { ChatMsg } from "@/components/chat/transport";

/**
 * The "replying to …" line above an inline reply, for a parent the caller has
 * ALREADY resolved.
 *
 * Concord V1/V2 and DMs all resolve it the same way — a by-id lookup over the
 * decoded set, because a sealed rumor is not relay-fetchable — so the only
 * thing left is to name the author and preview the content, which is this.
 * (NIP-29's parent lives on a relay, so {@link GroupChat} keeps its own
 * fetching wrapper around the same {@link ReplyContextLine} chrome.)
 *
 * Renders nothing when the parent isn't in the loaded set: a reply whose target
 * has scrolled out of history is still a readable message, and a placeholder
 * bar naming nothing is worse than no bar.
 */
export function ReplyContext({
  parent,
  onJump,
}: {
  parent: ChatMsg | undefined;
  onJump: (id: string) => void;
}) {
  const author = useAuthor(parent?.pubkey);
  const name = useScopedDisplayName(parent?.pubkey, author.data?.metadata);
  if (!parent) return null;
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
