import { Hash, Lock, MessageCircle, MessagesSquare } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useNavigate } from "react-router-dom";

import { ChatContent } from "@/components/chat/ChatContent";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { EventStoreContext } from "@/contexts/EventStoreContext";
import { useCommunity, useCommunityList } from "@/concord/hooks/useCommunityList";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { openedToStored, queryRumorsByIds } from "@/concord/lib/rumorStore";
import { useAuthor } from "@/hooks/useAuthor";
import { shortTimeAgo } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { KIND_GROUP_METADATA, parseGroupMetadata } from "@/lib/nip29";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";

import type { ComponentType, ReactNode } from "react";
import type { ChatRoute, Concord2Route, DmRoute, Nip29Route } from "@/lib/routes";
import type { NostrRumor } from "@/lib/nostrRumor";

interface ChatRouteEmbedProps {
  /** The full own-origin URL as it appeared in the message. */
  url: string;
  /** The parsed destination (see `parseSelfLink`). */
  route: ChatRoute;
  /** The in-app router path to navigate to. */
  path: string;
  className?: string;
}

/**
 * In-app preview card for a link back into this app (a copied message link, a
 * channel/server share). Clicking navigates with the router — the whole point
 * over the external `<a>` these links used to get.
 *
 * What it shows is decided by what the READER can already see, and it is
 * resolved from LOCAL state only. Every surface Armada links to is either
 * end-to-end encrypted (Concord, DMs) or behind a relay's own membership check,
 * so a preview that reached the network would either come back empty or ask a
 * relay for something the reader has no key to read anyway. The destination
 * page does the real resolution after the click; this card's job is to say
 * where the link goes, and to fill in the parts the reader is already holding.
 *
 * The three surfaces are separate components because they resolve from
 * different places: DMs from the `main` store, NIP-29 from that relay's tenant,
 * and Concord from the community's own tenant — which is why a community
 * message rendered blank when this was one component reading `main`.
 */
export function ChatRouteEmbed({ url, route, path, className }: ChatRouteEmbedProps) {
  switch (route.kind) {
    case "dm":
      return <DmRouteCard url={url} route={route} path={path} className={className} />;
    case "concord":
      return <ConcordRouteCard url={url} route={route} path={path} className={className} />;
    case "nip29":
      return <Nip29RouteCard url={url} route={route} path={path} className={className} />;
  }
}

// ── The shell ────────────────────────────────────────────────────────────────

/**
 * The clickable card body every destination shares. `role="link"` rather than
 * an `<a>`: the whole card navigates through the router, and an anchor would
 * put the URL back on the status bar and in the context menu's "open in new
 * tab" — the behavior this replaced.
 */
function RouteCardShell({
  url,
  path,
  className,
  children,
}: {
  url: string;
  path: string;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const open = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    navigate(path);
  };
  return (
    <div
      role="link"
      tabIndex={0}
      title={url}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter") open(e);
      }}
      className={cn(
        "block max-w-md w-full rounded-2xl border border-border overflow-hidden cursor-pointer",
        "transition-colors hover:bg-secondary/40 my-1.5",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
    >
      <div className="px-3 py-2 space-y-1 min-w-0">{children}</div>
    </div>
  );
}

/** The card's kicker: what KIND of place this link names. */
function CardLabel({
  Icon,
  label,
}: {
  Icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground min-w-0">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </p>
  );
}

/** The room this link points into: icon + name, and the channel within it. */
function PlaceRow({
  name,
  iconUrl,
  channel,
}: {
  name: string;
  iconUrl?: string | null;
  channel?: string;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Avatar className="size-5 clip-corner shrink-0">
        {iconUrl && <AvatarImage src={iconUrl} alt="" className="object-cover" />}
        <AvatarFallback className="clip-corner bg-primary/20 text-primary text-[10px]">
          {name.trim().charAt(0).toUpperCase() || "·"}
        </AvatarFallback>
      </Avatar>
      <span className="text-sm font-semibold truncate">{name}</span>
      {channel && <span className="text-xs text-muted-foreground truncate">· #{channel}</span>}
    </div>
  );
}

/** The linked message itself, when the reader already holds it. */
function MessageBody({ rumor }: { rumor: NostrRumor }) {
  return (
    <>
      <SenderRow rumor={rumor} />
      <ChatContent
        event={rumor}
        className="text-sm leading-relaxed"
        disableNoteEmbeds
        clampLines={3}
      />
    </>
  );
}

function SenderRow({ rumor }: { rumor: NostrRumor }) {
  const author = useAuthor(rumor.pubkey);
  const name = getDisplayName(author.data?.metadata, rumor.pubkey);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-sm font-semibold truncate">{name}</span>
      <span className="text-xs text-muted-foreground shrink-0">
        · {shortTimeAgo(rumor.created_at)}
      </span>
    </div>
  );
}

/** Said when the link names a message the reader can reach but hasn't cached. */
function NotCachedNote() {
  return <p className="text-sm text-muted-foreground">Open to load this message.</p>;
}

// ── Direct messages ──────────────────────────────────────────────────────────

function DmRouteCard({
  url,
  route,
  path,
  className,
}: {
  url: string;
  route: DmRoute;
  path: string;
  className?: string;
}) {
  const rumor = useMainStoreRumor(route.messageId);
  return (
    <RouteCardShell url={url} path={path} className={className}>
      <CardLabel
        Icon={MessageCircle}
        label={route.messageId ? "Direct message" : "Direct messages"}
      />
      {rumor ? <MessageBody rumor={rumor} /> : route.messageId ? <NotCachedNote /> : null}
    </RouteCardShell>
  );
}

/**
 * A rumor from the `main` tenant by id — where NIP-17 plaintext is stored once
 * it has been opened on this device. Nullable context on purpose: `ChatContent`
 * is deliberately mountable without providers, and this card degrades to the
 * unresolved form there rather than throwing.
 */
function useMainStoreRumor(id: string | undefined, relay?: string): NostrRumor | undefined {
  const storePromise = useContext(EventStoreContext);
  const { data } = useQuery<NostrRumor | null>({
    queryKey: ["self-link-rumor", id ?? "", relay ?? ""],
    enabled: !!storePromise && !!id,
    queryFn: async () => {
      const store = await storePromise!;
      const [found] = await store.query([{ ids: [id!], limit: 1 }], relay ? { relay } : undefined);
      return found ?? null;
    },
    staleTime: 5 * 60 * 1000,
  });
  return data ?? undefined;
}

// ── Concord communities ──────────────────────────────────────────────────────

/**
 * A Concord destination.
 *
 * Membership in Concord is possession of keys, held in the account's own
 * kind-33302 vault — so "is this reader a member" is a purely local question,
 * and it is the same question as "may they see anything about this at all".
 * A member gets the community's folded name and icon, the channel name, and
 * the message out of the community's own tenant; a non-member is TOLD they
 * aren't one and shown nothing else, for the same reason `CommunityNoAccess`
 * names nothing: the card would otherwise be reporting another account's vault
 * contents to whoever is signed in now.
 *
 * Membership is only asserted once the list has genuinely resolved and
 * decrypted — an unread list, or one whose decrypt is waiting on a remote
 * signer, is indistinguishable from an empty one, and calling that "not a
 * member" would tell a member they'd been kicked out of their own community.
 */
function ConcordRouteCard({
  url,
  route,
  path,
  className,
}: {
  url: string;
  route: Concord2Route;
  path: string;
  className?: string;
}) {
  const community = useCommunity(route.communityId);
  const { data: listData, isLoading: listLoading } = useCommunityList();
  const membershipResolved = Boolean(listData && !listData.decryptFailed && !listLoading);

  // `active: false` — the rail's own no-network variant. A pasted link must not
  // arm a control sweep for a community the reader is not looking at.
  const { data: folded } = useControlFold(community, false);
  const channels = useChannels(community, false);
  const iconUrl = useDecryptedImage(folded?.metadata?.icon);

  const targetId = route.messageId ?? route.threadRoot;
  const idHex = community?.idHex;
  const { data: rumor } = useQuery<NostrRumor | null>({
    queryKey: ["self-link-c2-rumor", idHex ?? "", targetId ?? ""],
    enabled: !!idHex && !!targetId,
    queryFn: async ({ signal }) => {
      const [found] = await queryRumorsByIds(idHex!, [targetId!], { signal });
      return found ? openedToStored(found) : null;
    },
    staleTime: 5 * 60 * 1000,
  });

  const label = route.messageId
    ? "Community message"
    : route.channelId
      ? "Community channel"
      : "Encrypted community";

  if (!community) {
    return (
      <RouteCardShell url={url} path={path} className={className}>
        <CardLabel Icon={MessagesSquare} label="Encrypted community" />
        {membershipResolved ? (
          <div className="flex items-start gap-2 min-w-0 text-muted-foreground">
            <Lock className="mt-0.5 size-4 shrink-0" />
            <p className="text-sm">
              You're not a member of this community, so it holds nothing you can read. Ask a
              member for an invite link.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Open</p>
        )}
      </RouteCardShell>
    );
  }

  const channelName = route.channelId
    ? channels.find((c) => c.idHex === route.channelId)?.name
    : undefined;

  return (
    <RouteCardShell url={url} path={path} className={className}>
      <CardLabel Icon={MessagesSquare} label={label} />
      <PlaceRow
        name={folded?.metadata?.name || community.name}
        iconUrl={iconUrl}
        channel={channelName}
      />
      {rumor ? <MessageBody rumor={rumor} /> : targetId ? <NotCachedNote /> : null}
    </RouteCardShell>
  );
}

// ── NIP-29 relay groups ──────────────────────────────────────────────────────

/**
 * A NIP-29 destination. The group's metadata (kind 39000) is relay-signed and
 * plaintext, so unlike Concord there is no membership question to answer here —
 * but it is still read from the relay's OWN tenant rather than fetched, both
 * because a group id means nothing without its relay (see `relayScope.ts`) and
 * because a pasted link should not open a socket.
 */
function Nip29RouteCard({
  url,
  route,
  path,
  className,
}: {
  url: string;
  route: Nip29Route;
  path: string;
  className?: string;
}) {
  const group = useNip29GroupMeta(route.relayUrl, route.groupId);
  const rumor = useMainStoreRumor(route.messageId ?? route.threadRoot, route.relayUrl);

  let host = route.relayUrl;
  try {
    host = new URL(route.relayUrl).host;
  } catch {
    // parseChatRoute vetted the relay param; the host is a nicety only.
  }

  const label = route.messageId ? "Group message" : route.groupId ? "Group" : "Server";

  return (
    <RouteCardShell url={url} path={path} className={className}>
      <CardLabel Icon={Hash} label={`${label} · ${host}`} />
      {route.groupId && (
        <PlaceRow
          name={group?.name || route.groupId}
          iconUrl={sanitizeImageSrc(group?.picture)}
        />
      )}
      {rumor ? <MessageBody rumor={rumor} /> : route.messageId ? <NotCachedNote /> : null}
    </RouteCardShell>
  );
}

/** The cached kind-39000 for a group, from its own relay tenant. No network. */
function useNip29GroupMeta(relayUrl: string, groupId: string | undefined) {
  const storePromise = useContext(EventStoreContext);
  const { data } = useQuery({
    queryKey: ["self-link-nip29-meta", relayUrl, groupId ?? ""],
    enabled: !!storePromise && !!groupId,
    queryFn: async ({ signal }) => {
      const store = await storePromise!;
      const events = await store.query(
        [{ kinds: [KIND_GROUP_METADATA], "#d": [groupId!], limit: 1 }],
        { relay: relayUrl, signal },
      );
      return events[0] ? parseGroupMetadata(events[0], relayUrl) : null;
    },
    staleTime: 5 * 60 * 1000,
  });
  return data ?? undefined;
}
