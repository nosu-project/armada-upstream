import { useAuthor } from "@/hooks/useAuthor";
import { describeCurationList, type DiscoverCuration } from "@/lib/discoverSource";
import { tryNpubEncode } from "@/lib/safeNip19";

/** A pubkey's profile name, or a shortened npub while it has none. */
function OwnerName({ pubkey }: { pubkey: string }) {
  const { data } = useAuthor(pubkey);
  const name = data?.metadata?.name || data?.metadata?.display_name;
  if (name) return <span className="font-medium text-foreground">{name}</span>;
  const npub = tryNpubEncode(pubkey);
  return <span className="font-mono">{npub ? `${npub.slice(0, 12)}…` : pubkey.slice(0, 8)}</span>;
}

/**
 * The curation source as a phrase — "a follow pack by Soapbox", "the follow
 * list of alex" — naming whoever owns the list, since that person decides what
 * the curated view contains.
 */
export function CurationSourceText({ curation }: { curation: DiscoverCuration }) {
  switch (curation.type) {
    case "none":
      return <>{describeCurationList(curation)}</>;
    case "follows":
      return (
        <>
          {describeCurationList(curation)} of <OwnerName pubkey={curation.pubkey} />
        </>
      );
    case "list":
      return (
        <>
          {describeCurationList(curation)} by <OwnerName pubkey={curation.pubkey} />
        </>
      );
  }
}
