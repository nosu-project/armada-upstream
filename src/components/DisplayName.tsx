import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";

interface DisplayNameProps {
  pubkey: string | undefined;
  /** Overrides the resolved name. Custom emoji still come from the pubkey's kind-0 tags. */
  name?: string;
  imgClassName?: string;
  /** The caller's kind-0 tags; with `name` too, no profile queries subscribe (matters on timelines). */
  tags?: string[][];
}

/**
 * Scoped display name with NIP-30 emoji shortcodes rendered as images. Emits
 * no wrapper element. For plain strings use {@link useScopedDisplayName}.
 */
export function DisplayName(props: DisplayNameProps) {
  if (props.name !== undefined && (props.tags !== undefined || props.pubkey === undefined)) {
    return (
      <EmojifiedText tags={props.tags ?? NO_TAGS} imgClassName={props.imgClassName}>
        {props.name}
      </EmojifiedText>
    );
  }
  return <ResolvedDisplayName {...props} />;
}

const NO_TAGS: string[][] = [];

function ResolvedDisplayName({ pubkey, name, imgClassName }: DisplayNameProps) {
  const author = useAuthor(pubkey);
  const scoped = useScopedIdentity(pubkey, author.data?.metadata);

  return (
    <EmojifiedText tags={author.data?.event?.tags ?? []} imgClassName={imgClassName}>
      {name ?? scoped.displayName}
    </EmojifiedText>
  );
}
