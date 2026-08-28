import { Hash, MessageCircle, MessagesSquare } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useNavigate } from "react-router-dom";

import { ChatContent } from "@/components/chat/ChatContent";
import { EventStoreContext } from "@/contexts/EventStoreContext";
import { useAuthor } from "@/hooks/useAuthor";
import { shortTimeAgo } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

import type { ComponentType } from "react";
import type { ChatRoute } from "@/lib/routes";
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

/** Header label + icon for a chat destination, by what the path names. */
function routeMeta(route: ChatRoute): {
  label: string;
  Icon: ComponentType<{ className?: string }>;
  detail?: string;
} {
  switch (route.kind) {
    case "dm":
      return {
        label: route.messageId ? "Direct message" : "Direct messages",
        Icon: MessageCircle,
      };
    case "concord":
      return {
        label: route.messageId
          ? "Community message"
          : route.channelId
            ? "Community channel"
            : "Encrypted community",
        Icon: MessagesSquare,
      };
    case "nip29": {
      let detail: string | undefined;
      try {
        detail = new URL(route.relayUrl).host;
      } catch {
        // parseChatRoute vetted the relay param; a host is a nicety only
      }
      return {
        label: route.messageId ? "Group message" : route.groupId ? "Group" : "Server",
        Icon: Hash,
        detail,
      };
    }
  }
}

/**
 * In-app preview card for a link back into this app (a copied message link, a
 * channel/server share). Clicking navigates with the router — the whole point
 * over the external `<a>` these links used to get.
 *
 * When the link names a message and the LOCAL store has it, the card shows the
 * sender and a clamped body — "pretty when the reader has access". It resolves
 * from the local store only: for DMs and Concord the plaintext exists nowhere
 * but this device, and a message the reader can't already see is not this
 * card's to fetch — the destination page does the real resolution after the
 * click. A miss still renders a navigable card, never a tombstone.
 */
export function ChatRouteEmbed({ url, route, path, className }: ChatRouteEmbedProps) {
  const navigate = useNavigate();
  // Nullable on purpose: ChatContent is mountable bare (render-cost tests),
  // and this card must degrade to the unresolved form there, not throw.
  const storePromise = useContext(EventStoreContext);

  const targetId = route.kind === "dm" ? route.messageId : route.messageId ?? route.threadRoot;
  const relay = route.kind === "nip29" ? route.relayUrl : undefined;

  const { data: rumor } = useQuery<NostrRumor | null>({
    queryKey: ["self-link-rumor", targetId ?? "", relay ?? ""],
    enabled: !!storePromise && !!targetId,
    queryFn: async () => {
      const store = await storePromise!;
      const [found] = await store.query(
        [{ ids: [targetId!], limit: 1 }],
        relay ? { relay } : undefined,
      );
      return found ?? null;
    },
    staleTime: 5 * 60 * 1000,
  });

  const { label, Icon, detail } = routeMeta(route);

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
      <div className="px-3 py-2 space-y-1 min-w-0">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground min-w-0">
          <Icon className="size-3.5 shrink-0" />
          <span className="shrink-0">{label}</span>
          {detail && (
            <span className="normal-case font-normal tracking-normal truncate">· {detail}</span>
          )}
        </p>

        {rumor ? (
          <>
            <SenderRow rumor={rumor} />
            <ChatContent
              event={rumor}
              className="text-sm leading-relaxed"
              disableNoteEmbeds
              clampLines={3}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Open</p>
        )}
      </div>
    </div>
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
