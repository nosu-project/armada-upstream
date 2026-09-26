import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";

interface DisplayNameProps {
  /** The user whose display name to render. */
  pubkey: string | undefined;
  /**
   * Overrides the resolved name (mesh peers, or a name the caller already
   * resolved). Custom emoji are still taken from the pubkey's kind-0 tags.
   */
  name?: string;
  /** CSS class for the inline custom emoji images. */
  imgClassName?: string;
  /**
   * The pubkey's kind-0 tags, when the caller already holds the profile. With
   * `name` also given there is nothing left to look up, so neither the profile
   * nor the server-profile query is subscribed — which matters on a timeline,
   * where every row's byline renders one of these.
   */
  tags?: string[][];
}

/**
 * Renders a user's scoped display name with NIP-30 custom emoji shortcodes
 * replaced by inline images, using the `emoji` tags on their kind-0 profile
 * event.
 *
 * Emits only text/images (no wrapper element), so it drops into whatever
 * element the call site already styles. Sites that need the name as a plain
 * string (an `alt`/`title` attribute, an avatar initial, a notification body)
 * keep using {@link useScopedDisplayName} — a shortcode that resolves to an
 * image here still reads as `:shortcode:` there.
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
