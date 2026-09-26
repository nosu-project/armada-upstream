import { useMemo } from "react";
import { Compass, FileQuestion, Palette, Smile } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { EmbeddedEventCard } from "@/components/chat/EmbeddedNote";
import { EmojiPackCard } from "@/components/chat/EmojiPackCard";
import { ThemeDiscoverCard } from "@/components/discover/ThemeDiscoverCard";
import { DetailPage } from "@/components/layout/DetailPage";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDiscoverRelays } from "@/hooks/useDiscover";
import { KIND_EMOJI_SET, emojiPackName } from "@/hooks/useEmojiPacks";
import { publicRelayHints, useAddrEvent } from "@/hooks/useEvent";
import { parseNaddr } from "@/lib/naddrLink";
import { THEME_DEFINITION_KIND, parseDittoTheme } from "@/lib/themeEvent";
import { NotFound } from "@/pages/NotFound";
import { coreToTokens } from "@/themes";

import type { ReactNode } from "react";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { ThemeTokens } from "@/themes";

const ICON_CLASS = "size-4 shrink-0 text-primary";

/**
 * A shared addressable event at a bare `/<naddr>` — the target of a theme or
 * emoji pack card's "Copy link", dispatched here by `Nip19Route`. Public like
 * Discover: a signed-out visitor can preview a theme and apply it; the actions
 * that publish are simply absent until they sign in. Any other kind falls back
 * to the generic event card chat uses.
 */
export function NaddrPage() {
  const { user: segment } = useParams<{ user: string }>();
  const address = useMemo(() => parseNaddr(segment), [segment]);
  const discoverRelays = useDiscoverRelays();
  // Our own relays first, so a link's hints can't crowd them out of the
  // fallback's five slots; the hints are the link author's choice of where the
  // viewer connects, so only public `wss:` ones survive.
  const relays = useMemo(
    () => [...new Set([...discoverRelays, ...publicRelayHints(address?.relays)])],
    [address, discoverRelays],
  );
  const { data: event, isLoading } = useAddrEvent(address?.addr, relays);

  if (!address) return <NotFound />;

  const kind = address.addr.kind;
  const icon =
    kind === THEME_DEFINITION_KIND ? <Palette className={ICON_CLASS} />
    : kind === KIND_EMOJI_SET ? <Smile className={ICON_CLASS} />
    : null;
  const noun = kind === THEME_DEFINITION_KIND ? "theme" : kind === KIND_EMOJI_SET ? "emoji pack" : "event";

  if (isLoading) {
    return (
      <DetailPage title={<Skeleton className="h-4 w-32" />} icon={icon}>
        <Skeleton className="h-56 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </DetailPage>
    );
  }

  if (!event) {
    return (
      <DetailPage title={`Missing ${noun}`} icon={icon}>
        <div className="flex flex-col items-center gap-4 pt-12 text-center">
          <FileQuestion className="size-10 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground max-w-sm">
            Couldn't find this {noun}. It may have been deleted, or its relays are unreachable.
          </p>
          <Button asChild variant="secondary">
            <Link to="/discover">
              <Compass className="size-4" />
              Browse Discover
            </Link>
          </Button>
        </div>
      </DetailPage>
    );
  }

  return <NaddrView event={event} icon={icon} />;
}

function NaddrView({ event, icon }: { event: NostrRumor; icon: ReactNode }) {
  const theme = useMemo(
    () => (event.kind === THEME_DEFINITION_KIND ? parseDittoTheme(event) : null),
    [event],
  );
  const tokens = useMemo(() => (theme ? coreToTokens(theme.colors) : null), [theme]);

  if (theme && tokens) {
    return (
      <DetailPage title={theme.title} icon={icon}>
        <ThemePreview title={theme.title} tokens={tokens} />
        <ThemeDiscoverCard event={event} />
      </DetailPage>
    );
  }

  if (event.kind === KIND_EMOJI_SET) {
    return (
      <DetailPage title={emojiPackName(event)} icon={icon}>
        <EmojiPackCard event={event} expanded className="my-0 max-w-none" />
      </DetailPage>
    );
  }

  const title = event.tags.find(([n]) => n === "title")?.[1];
  return (
    <DetailPage title={title || "Shared event"} icon={icon}>
      <EmbeddedEventCard event={event} />
    </DetailPage>
  );
}

/**
 * A mock of the app drawn in the theme's palette — chrome, a message, and a
 * primary action — so it can be judged before it's applied.
 */
function ThemePreview({ title, tokens }: { title: string; tokens: ThemeTokens }) {
  const hsl = (v: string) => `hsl(${v})`;
  return (
    <div
      className="rounded-xl overflow-hidden border border-border/60 flex h-56"
      style={{ backgroundColor: hsl(tokens.background), color: hsl(tokens.foreground) }}
      aria-label={`Preview of ${title}`}
    >
      <div className="w-12 shrink-0 flex flex-col items-center gap-2 py-3" style={{ backgroundColor: hsl(tokens.chromeDeep) }}>
        <span className="size-7 rounded-lg" style={{ backgroundColor: hsl(tokens.primary) }} />
        <span className="size-7 rounded-lg" style={{ backgroundColor: hsl(tokens.secondary) }} />
        <span className="size-7 rounded-lg" style={{ backgroundColor: hsl(tokens.muted) }} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-10 px-3 flex items-center text-sm font-semibold" style={{ backgroundColor: hsl(tokens.chrome) }}>
          # general
        </div>
        <div className="flex-1 min-h-0 p-3 space-y-3 text-sm">
          <div className="flex gap-2">
            <span className="size-8 shrink-0 rounded-full" style={{ backgroundColor: hsl(tokens.accent) }} />
            <div className="min-w-0">
              <p className="font-semibold" style={{ color: hsl(tokens.primary) }}>Ana</p>
              <p>Trying out a new theme — what do you think?</p>
            </div>
          </div>
          <div className="flex gap-2">
            <span className="size-8 shrink-0 rounded-full" style={{ backgroundColor: hsl(tokens.secondary) }} />
            <div className="min-w-0">
              <p className="font-semibold">Ben</p>
              <p style={{ color: hsl(tokens.mutedForeground) }}>Looks great.</p>
            </div>
          </div>
        </div>
        <div className="p-3 flex items-center gap-2">
          <span className="flex-1 h-8 rounded-md" style={{ backgroundColor: hsl(tokens.input) }} />
          <span
            className="clip-corner-lg px-3 py-1.5 text-xs font-medium"
            style={{ backgroundColor: hsl(tokens.primary), color: hsl(tokens.primaryForeground) }}
          >
            Send
          </span>
        </div>
      </div>
    </div>
  );
}
