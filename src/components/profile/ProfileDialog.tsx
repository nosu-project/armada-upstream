import {
  AtSign,
  Award,
  Check,
  Copy,
  Globe,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Music,
  Palette,
  Pencil,
  UserCheck,
  UserPlus,
  UserX,
  Users,
  X,
  Zap,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { DittoIcon } from "@/components/brand/DittoIcon";
import { BotPill } from "@/components/BotPill";
import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FallbackImage } from "@/components/ui/FallbackImage";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCommunity } from "@/concord/hooks/useCommunityList";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { useSharedCommunities, type SharedCommunity } from "@/concord/hooks/useSharedCommunities";
import { useAcceptedDms } from "@/hooks/useAcceptedDms";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useClosedDms } from "@/hooks/useClosedDms";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useFollowList } from "@/hooks/useFollowList";
import { useFollowerCount, useFollowingOf, useSharedFollowers } from "@/hooks/useFollowStats";
import { useFollowToggle } from "@/hooks/useFollowToggle";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { useMuteToggle } from "@/hooks/useMuteList";
import { useNsite } from "@/hooks/useNsite";
import { useOpenProfile } from "@/hooks/useOpenProfile";
import { useProfileBadges, type ProfileBadge } from "@/hooks/useProfileBadges";
import { useProfileTheme } from "@/hooks/useProfileTheme";
import { useStartedDms } from "@/hooks/useStartedDms";
import { isStatusExpired, useUserStatus } from "@/hooks/useUserStatus";
import { getAvatarShape } from "@/lib/avatarShape";
import { dittoNip19Url, dittoProfileUrl } from "@/lib/dittoUrl";
import { faviconUrl } from "@/lib/faviconUrl";
import { loadThemeFont } from "@/lib/fontLoader";
import { getDisplayName } from "@/lib/getDisplayName";
import { tryNaddrEncode, tryNpubEncode } from "@/lib/safeNip19";
import { isLocalNetworkUrl, sanitizeImageSrc, sanitizeUrl } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { writeClipboardText } from "@/lib/clipboard";
import { lazyWithReload } from "@/lib/chunkReload";
import { buildThemeVarStyle } from "@/themes";

import type { CSSProperties } from "react";
import type { ThemeBackground } from "@/lib/themeEvent";

/**
 * Both editors are reachable from exactly one profile in the world — the
 * viewer's own — and only behind a click. Imported statically they rode along
 * with every profile anyone opened: the whole WYSIWYG profile editor and the
 * theme builder's Blossom upload path, fetched and parsed before the first
 * paint of a screen that is usually somebody else's.
 */
const ProfileSettings = lazy(
  lazyWithReload(() =>
    import("@/components/ProfileSettings").then((m) => ({ default: m.ProfileSettings })),
  ),
);
const ProfileThemeEditor = lazy(
  lazyWithReload(() =>
    import("@/components/profile/ProfileThemeEditor").then((m) => ({
      default: m.ProfileThemeEditor,
    })),
  ),
);

/**
 * A person's full profile — `/<npub|nprofile|name@domain>`, opened by
 * `UserPage`. The Discord-style view of everything they publish about
 * themselves: kind-0 metadata (bio, custom fields, website, lightning
 * address), NIP-38 status, follow counts, NIP-58 badges, and — for the viewer
 * — shared communities and shared followers. No content feed; that stays on
 * Ditto.
 *
 * Presented as a dialog, but a ROUTED one: it keeps a real URL (the bare
 * NIP-19 path every Nostr client shares), while closing is a step back through
 * history rather than a destination this has to guess at. That's what the
 * close button is — `onClose` is the caller's history step — and why there's
 * no Back button of its own.
 *
 * Deliberately NOT a Radix `Dialog`, though it reads as one. A Radix dialog
 * portals to `document.body` and, in modal mode, drops pointer events on
 * everything else — which would put this over the community rail and kill it,
 * when the rail is exactly what should stay live: it is how you leave. So this
 * is an overlay INSIDE the main pane, filling it bar a margin, positioned
 * against the `relative` `<main>` that renders it. What Radix would have given
 * for free and is hand-wired below: Escape to close, and the backdrop as a
 * dismiss target. Focus is deliberately not trapped — nothing outside is
 * inert, so there is nothing to trap it from.
 *
 * The view inside wears the owner's Ditto profile theme (kind 16767): colors
 * as scoped CSS vars, body/title fonts, and the background image — the same
 * takeover Ditto's profile does globally, but scoped to this container, so the
 * app around it keeps its own theme and nothing needs restoring on unmount.
 */
export function ProfileDialog({ pubkey, onClose }: { pubkey: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Anything stacked ON this owns Escape first — the self-profile's Edit
      // profile / Edit theme dialogs, and the moderation dropdown. They portal
      // to the body, so they're outside this subtree and would otherwise be
      // dismissed alongside the profile they were opened from.
      if (document.querySelector("[data-radix-dialog-overlay], [data-radix-menu-content]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <>
      {/* The backdrop reaches the edges of the pane and no further, so the
          rail beside it stays lit and clickable. */}
      <div
        aria-hidden
        className="absolute inset-0 z-20 bg-black/50 backdrop-blur-sm animate-in fade-in-0"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="false"
        aria-label="Profile"
        className="absolute inset-2 md:inset-4 z-30 clip-corner-lg overflow-hidden border border-border bg-chrome shadow-lg animate-in fade-in-0 zoom-in-95"
      >
        <ProfileView pubkey={pubkey} onClose={onClose} />
      </div>
    </>
  );
}

/** The custom `fields` array ProfileSettings writes into kind-0 content. */
function parseProfileFields(content: string | undefined): [string, string][] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as { fields?: unknown };
    if (!Array.isArray(parsed.fields)) return [];
    return parsed.fields.filter(
      (f): f is [string, string] =>
        Array.isArray(f) && typeof f[0] === "string" && typeof f[1] === "string" && !!f[1],
    );
  } catch {
    return [];
  }
}

/**
 * `src` is the background's URL as the media policy resolved it (proxied for
 * a stranger's host), not `bg.url` — a CSS `url()` is a fetch like any other.
 */
function backgroundStyle(bg: ThemeBackground, src: string): CSSProperties {
  return bg.mode === "tile"
    ? { backgroundImage: `url("${src}")`, backgroundRepeat: "repeat", backgroundSize: "auto" }
    : {
        backgroundImage: `url("${src}")`,
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
      };
}

const compactFormat = new Intl.NumberFormat(undefined, { notation: "compact" });

/**
 * False for the first render, true from the frame after it paints.
 *
 * A commit is all-or-nothing, so the panel can't appear until React has
 * rendered everything in it. This splits that in two: the identity everyone
 * came to see (avatar, name, theme) commits on its own, and the rest — which
 * is mostly empty boxes waiting on relays anyway — arrives a frame later.
 *
 * The QUERIES deliberately don't move with it. They're declared at the top of
 * `ProfileView` and stay there, because gating a hook is gating the fetch it
 * starts, and delaying those by a frame would trade a faster paint for slower
 * data — the opposite of the problem.
 */
function useAfterPaint(): boolean {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPainted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return painted;
}

function ProfileView({ pubkey, onClose }: { pubkey: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  // kind-0 is whatever its author typed.
  const banner = sanitizeImageSrc(metadata?.banner);
  const theme = useProfileTheme(pubkey).data?.theme;
  const nsite = useNsite(pubkey).data;
  const badgesQuery = useProfileBadges(pubkey);
  const sharedQuery = useSharedCommunities(pubkey);
  const badges = badgesQuery.data ?? [];
  const shared = sharedQuery.data ?? [];

  const status = useUserStatus(pubkey).data?.status;
  const rawMusicStatus = useUserStatus(pubkey, "music").data?.status;
  const musicStatus = isStatusExpired(rawMusicStatus) ? undefined : rawMusicStatus;

  const isSelf = user?.pubkey === pubkey;
  const displayName = getDisplayName(metadata, pubkey);
  const npub = tryNpubEncode(pubkey);
  const shortNpub = npub ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : "";
  const fields = useMemo(() => parseProfileFields(author.data?.event?.content), [author.data?.event]);
  const website = sanitizeUrl(metadata?.website);
  const dittoHref = dittoProfileUrl(pubkey);
  const mute = useMuteToggle(pubkey);
  const { isFollowing, isPending: followPending, toggle: toggleFollow } = useFollowToggle(pubkey);
  const { accept } = useAcceptedDms();
  const { reopen } = useClosedDms();
  const { start } = useStartedDms();

  // Counts: following from their own kind 3, followers from the NIP-85 stats
  // provider (the same source Ditto reads).
  const followingQuery = useFollowingOf(pubkey);
  const followerQuery = useFollowerCount(pubkey);
  const followingData = followingQuery.data;
  const followerCount = followerQuery.data;

  // "Followed by people you follow" — viewer-relative, so never for self.
  const { data: viewerFollows } = useFollowList();
  const sharedFollowersQuery = useSharedFollowers(
    user && !isSelf ? pubkey : undefined,
    viewerFollows?.pubkeys,
  );
  const sharedFollowers = sharedFollowersQuery.data;

  // `isLoading`, not `isPending`: a disabled query is forever "pending" (it has
  // no data and never will), which would leave a skeleton on screen for a
  // section that is switched off — self has no shared anything.
  const countsLoading = followingQuery.isLoading || followerQuery.isLoading;
  // One skeleton for the whole sidebar rather than three. Each of these
  // sections is legitimately empty for most people, so a per-section skeleton
  // is mostly a placeholder for something that will never arrive — it would
  // draw three cards and then take them away again.
  const sidebarLoading =
    badgesQuery.isLoading || sharedQuery.isLoading || sharedFollowersQuery.isLoading;
  const sidebarEmpty =
    badges.length === 0 && shared.length === 0 && !sharedFollowers?.count;

  const painted = useAfterPaint();
  const [copied, setCopied] = useState(false);
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  // The owner's theme, scoped to this container: color vars + fonts. The
  // fonts load by URL (fontLoader) and apply as plain inline CSS, so
  // unmounting simply stops using them.
  const pageStyle = useMemo(() => {
    if (!theme) return undefined;
    const style: Record<string, string> = buildThemeVarStyle(theme.colors);
    const bodyFont = loadThemeFont(theme.font);
    // The title font falls back to the body font, so a display name inherits
    // the theme's face rather than the default (matching Ditto).
    const titleFont = loadThemeFont(theme.titleFont) ?? bodyFont;
    if (bodyFont) style.fontFamily = bodyFont;
    if (titleFont) style["--title-font-family"] = titleFont;
    return style as CSSProperties;
  }, [theme]);

  const background = theme?.background;
  // A kind-16767 theme is whatever its author published; its background is
  // loaded under the same media policy as their avatar.
  const backgroundSrc = useMediaSrc(background?.url);
  // Over a background image the surfaces go translucent so it shows through.
  const card = background
    ? "bg-card/85 supports-[backdrop-filter]:bg-card/70 backdrop-blur-md"
    : "bg-card";

  // Opening the conversation from here is the same commitment picking someone
  // in the compose pane is — out of the request tier, out of the closed pile —
  // plus keeping the row afterwards, so a person messaged from their profile
  // is still in the DM list tomorrow. This is where the public chat link used
  // to make that commitment, back when `/<npub>` redirected signed-in viewers
  // straight into the thread.
  const openDm = () => {
    if (!npub) return;
    reopen(pubkey);
    accept(pubkey);
    start(pubkey);
    navigate(`/dm/${npub}`);
  };

  const copyNpub = () => {
    if (!npub) return;
    writeClipboardText(npub).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };

  return (
    <div
      className="relative h-full overflow-hidden bg-background text-foreground"
      style={pageStyle}
    >
      {background && backgroundSrc && (
        <div aria-hidden className="absolute inset-0" style={backgroundStyle(background, backgroundSrc)} />
      )}

      {/* Closing IS the back step — outside the scroller so it stays put, and
          on its own scrim so it reads over the banner it floats on. */}
      <Button
        size="icon"
        variant="ghost"
        aria-label="Close profile"
        className="absolute right-3 top-3 z-10 size-9 touch:size-11 rounded-full bg-background/60 backdrop-blur-sm hover:bg-background/80"
        onClick={onClose}
      >
        <X className="size-5" />
      </Button>

      <div className="relative h-full overflow-y-auto">
        {/* The panel fills the pane, the content doesn't: a bio and an About
            card stretched across a wide monitor is a line length nobody
            reads. Capped and centred, so the width the panel gained becomes
            margin rather than measure. */}
        <div className="mx-auto w-full max-w-4xl px-3 py-3 md:px-6 md:py-6">
          {/* Header card: banner, avatar, identity, actions. */}
          <section className={cn("clip-corner-lg overflow-hidden border border-border", card)}>
            <div className="h-32 md:h-44 bg-secondary relative">
              <FallbackImage src={banner} className="w-full h-full object-cover" loading="lazy" decoding="async" />
            </div>

            <div className="px-4 pb-4 md:px-6 md:pb-6">
              <div className="flex items-end justify-between gap-2 flex-wrap">
                <div className="-mt-10 md:-mt-12">
                  <Avatar shape={getAvatarShape(metadata)} className="size-20 md:size-24 border-4 border-background">
                    <AvatarImage src={metadata?.picture} alt={displayName} />
                    <AvatarFallback className="bg-primary/20 text-primary text-2xl">
                      {displayName[0]?.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </div>

                {/* Action row, right of the avatar. */}
                <div className="flex items-center gap-2 pt-2">
                  {isSelf ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="clip-corner-lg h-9 touch:h-11"
                        onClick={() => setThemeEditorOpen(true)}
                      >
                        <Palette className="size-4 mr-1.5" />
                        Edit theme
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="clip-corner-lg h-9 touch:h-11"
                        onClick={() => setEditOpen(true)}
                      >
                        <Pencil className="size-4 mr-1.5" />
                        Edit profile
                      </Button>
                    </>
                  ) : (
                    <>
                      {user && npub && !config.dmsDisabled && (
                        <Button size="sm" className="clip-corner-lg h-9 touch:h-11" onClick={openDm}>
                          <MessageSquare className="size-4 mr-1.5" />
                          Message
                        </Button>
                      )}
                      {/* Follow toggles in place (Ditto-style): Follow when
                          not following, Following (click to unfollow) when
                          already there. */}
                      {user && (
                        <Button
                          size="sm"
                          variant={isFollowing ? "secondary" : "default"}
                          className="clip-corner-lg h-9 touch:h-11"
                          disabled={followPending}
                          onClick={() => void toggleFollow()}
                        >
                          {isFollowing
                            ? <><UserCheck className="size-4 mr-1.5" />Following</>
                            : <><UserPlus className="size-4 mr-1.5" />Follow</>}
                        </Button>
                      )}
                      {user && mute.canMute && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="secondary"
                              aria-label="More actions"
                              className="size-9 touch:size-11 clip-corner-lg"
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              disabled={mute.pending}
                              className={!mute.muted ? "text-destructive focus:text-destructive" : undefined}
                              onSelect={() => void mute.toggle()}
                            >
                              {mute.muted
                                ? <UserCheck className="mr-2 size-4" />
                                : <UserX className="mr-2 size-4" />}
                              {mute.label}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </>
                  )}

                  {/* Off-ramps: this person on ditto.pub, and their nsite. */}
                  {dittoHref && (
                    <Button
                      size="icon"
                      variant="secondary"
                      className="size-9 touch:size-11 clip-corner-lg"
                      asChild
                    >
                      <a href={dittoHref} target="_blank" rel="noopener noreferrer" title="View on Ditto" aria-label="View on Ditto">
                        <DittoIcon className="size-4" />
                      </a>
                    </Button>
                  )}
                  {nsite && (
                    <Button
                      size="icon"
                      variant="secondary"
                      className="size-9 touch:size-11 clip-corner-lg"
                      asChild
                    >
                      <a
                        href={nsite.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={nsite.title ?? `${displayName}'s site`}
                        aria-label="View website"
                      >
                        <Globe className="size-4" />
                      </a>
                    </Button>
                  )}
                </div>
              </div>

              {/* Name + identity lines. */}
              <div className="mt-2 flex items-center gap-2 min-w-0">
                <h1
                  className="text-xl md:text-2xl font-bold truncate"
                  style={{ fontFamily: "var(--title-font-family, inherit)" }}
                >
                  {author.data?.event
                    ? <EmojifiedText tags={author.data.event.tags}>{displayName}</EmojifiedText>
                    : displayName}
                </h1>
                <BotPill metadata={metadata} />
              </div>

              {metadata?.nip05 && (
                <div className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground truncate">
                  <AtSign className="size-3.5 shrink-0" />
                  <span className="truncate">{metadata.nip05.replace(/^_@/, "")}</span>
                </div>
              )}

              {npub && (
                <button
                  type="button"
                  onClick={copyNpub}
                  className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  title="Copy npub"
                >
                  <span className="font-mono">{shortNpub}</span>
                  {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
                </button>
              )}

              {/* Follow counts. The lists themselves live on Ditto's profile
                  (its followers/following views), so both link out there.
                  Nearly everyone has these, so unlike the sidebar they're
                  worth holding space for while they resolve. */}
              {countsLoading && !followingData && followerCount == null && (
                <div className="mt-2 flex items-center gap-4">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-24" />
                </div>
              )}
              {(followingData || followerCount != null) && dittoHref && (
                <div className="mt-2 flex items-center gap-4 text-sm">
                  {followingData && (
                    <a href={dittoHref} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      <span className="font-bold tabular-nums">{compactFormat.format(followingData.count)}</span>{" "}
                      <span className="text-muted-foreground">Following</span>
                    </a>
                  )}
                  {followerCount != null && followerCount > 0 && (
                    <a href={dittoHref} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      <span className="font-bold tabular-nums">{compactFormat.format(followerCount)}</span>{" "}
                      <span className="text-muted-foreground">Followers</span>
                    </a>
                  )}
                </div>
              )}

              {/* NIP-38 status + now playing. */}
              {status?.content && (
                <div className="mt-2 text-sm text-muted-foreground" title={status.content}>
                  {status.link ? (
                    <a href={status.link} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
                      <EmojifiedText tags={status.event.tags}>{status.content}</EmojifiedText>
                    </a>
                  ) : (
                    <EmojifiedText tags={status.event.tags}>{status.content}</EmojifiedText>
                  )}
                </div>
              )}
              {musicStatus?.content && (
                <div className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground" title={musicStatus.content}>
                  <Music className="size-3.5 shrink-0" />
                  {musicStatus.link ? (
                    <a href={musicStatus.link} target="_blank" rel="noopener noreferrer" className="truncate hover:text-foreground transition-colors">
                      <EmojifiedText tags={musicStatus.event.tags}>{musicStatus.content}</EmojifiedText>
                    </a>
                  ) : (
                    <span className="truncate">
                      <EmojifiedText tags={musicStatus.event.tags}>{musicStatus.content}</EmojifiedText>
                    </span>
                  )}
                </div>
              )}

              {/* Bio — full, no clamp. */}
              {metadata?.about && (
                <p className="mt-3 text-sm whitespace-pre-wrap break-words">{metadata.about}</p>
              )}
            </div>
          </section>

          {/* Below the header: fields on the left, badges/communities beside.
              Held back one frame so the identity above commits — and paints —
              without waiting for any of this to render. It is all below the
              fold on a phone and mostly empty until the relays answer, so a
              frame costs nothing here and buys the panel its first paint. */}
          {painted && (
          <div className="mt-3 md:mt-4 grid gap-3 md:gap-4 lg:grid-cols-[1fr_18rem] items-start">
            <div className="space-y-3 md:space-y-4 min-w-0">
              {(fields.length > 0 || website || metadata?.lud16) && (
                <section className={cn("clip-corner-lg border border-border p-4 md:p-5", card)}>
                  <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
                    About
                  </h2>
                  <div className="space-y-4">
                    {metadata?.lud16 && (
                      <div>
                        <div className="text-sm font-semibold">Lightning</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-sm">
                          <Zap className="size-4 shrink-0 text-primary" />
                          <span className="break-all">{metadata.lud16}</span>
                        </div>
                      </div>
                    )}
                    {website && (
                      <div>
                        <div className="text-sm font-semibold">Website</div>
                        <FieldValue value={website} />
                      </div>
                    )}
                    {fields.map(([label, value], i) => (
                      <div key={`${label}-${i}`}>
                        {label && <div className="text-sm font-semibold break-words">{label}</div>}
                        <FieldValue value={value} />
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>

            <div className="space-y-3 md:space-y-4 min-w-0">
              {/* One card standing in for whichever of badges, shared
                  followers and shared communities turn out to exist — drawn
                  only while nothing has arrived yet, so it gives way to real
                  content rather than stacking above it. */}
              {sidebarLoading && sidebarEmpty && (
                <section className={cn("clip-corner-lg border border-border p-4", card)}>
                  <Skeleton className="h-3 w-28" />
                  <div className="mt-3 space-y-2">
                    <Skeleton className="h-7 w-full" />
                    <Skeleton className="h-7 w-full" />
                    <Skeleton className="h-7 w-2/3" />
                  </div>
                </section>
              )}

              {badges.length > 0 && (
                <section className={cn("clip-corner-lg border border-border p-4", card)}>
                  <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
                    Badges
                  </h2>
                  <div className="grid grid-cols-3 gap-3">
                    {badges.map((badge) => (
                      <BadgeTile key={badge.addr} badge={badge} />
                    ))}
                  </div>
                </section>
              )}

              {!isSelf && sharedFollowers && sharedFollowers.count > 0 && (
                <SharedFollowersCard shared={sharedFollowers.pubkeys} dittoHref={dittoHref} cardClass={card} />
              )}

              {!isSelf && shared.length > 0 && (
                <section className={cn("clip-corner-lg border border-border p-4", card)}>
                  <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Users className="size-3.5" />
                    {shared.length} shared {shared.length === 1 ? "community" : "communities"}
                  </h2>
                  <ul className="space-y-1">
                    {shared.map((c) => (
                      <SharedCommunityRow key={c.idHex} entry={c} />
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>
          )}
        </div>
      </div>

      {/* Both editors are mounted only once opened, and both are lazy. They
          are reachable from ONE profile in the world — the viewer's own,
          behind a click — but statically imported they rode along with every
          profile anyone opened, which put the entire WYSIWYG profile editor
          and the theme builder's upload path in front of the first paint. */}
      {isSelf && themeEditorOpen && (
        <Suspense fallback={null}>
          <ProfileThemeEditor open onOpenChange={setThemeEditorOpen} current={theme} />
        </Suspense>
      )}
      {isSelf && (
        /* Edit the profile right here — the same WYSIWYG editor Settings
           hosts, in a dialog, so nothing navigates away from the page it
           is editing. */
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <ChromeDialogContent
            title="Edit profile"
            className="sm:max-w-xl"
            contentClassName="max-h-[85dvh] overflow-y-auto"
          >
            {editOpen && (
              <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                <ProfileSettings onSaved={() => setEditOpen(false)} />
              </Suspense>
            )}
          </ChromeDialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Custom field rendering ───────────────────────────────────────────────────

const IMAGE_EXT = /\.(gif|png|jpe?g|webp|avif)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|opus|flac|aac)(\?|#|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A custom field's value, rendered by what it IS (Ditto's profile-fields
 * treatment): images/gifs inline, audio as a player, video as a player,
 * emails as mailto, URLs as favicon links, anything else as text. Media only
 * embeds from public http(s) origins — a local-network URL in event data must
 * never become an <img>/<audio> fetch (see isLocalNetworkUrl).
 */
function FieldValue({ value }: { value: string }) {
  const url = sanitizeUrl(value);
  const embeddable = url && !isLocalNetworkUrl(url) ? url : undefined;

  if (embeddable && IMAGE_EXT.test(embeddable)) {
    return (
      <a href={embeddable} target="_blank" rel="noopener noreferrer" className="block mt-1.5">
        <img src={embeddable} alt="" className="w-full rounded-lg object-cover" loading="lazy" decoding="async" />
      </a>
    );
  }
  if (embeddable && AUDIO_EXT.test(embeddable)) {
    return <audio controls preload="none" src={embeddable} className="mt-1.5 w-full h-10" />;
  }
  if (embeddable && VIDEO_EXT.test(embeddable)) {
    return (
      <video controls preload="metadata" src={embeddable} className="mt-1.5 w-full rounded-lg" />
    );
  }
  if (!url && EMAIL_RE.test(value.trim())) {
    return (
      <a
        href={`mailto:${value.trim()}`}
        className="mt-0.5 flex items-center gap-1.5 text-sm text-primary hover:underline min-w-0"
      >
        <Mail className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{value.trim()}</span>
      </a>
    );
  }
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 flex items-center gap-1.5 text-sm text-primary hover:underline min-w-0"
      >
        <Favicon url={url} />
        <span className="truncate">{url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
      </a>
    );
  }
  return <p className="mt-0.5 text-sm break-words">{value}</p>;
}

/** The site's favicon beside a link, vanishing (not breaking) on error. */
function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(url);
  if (!src || failed) return <Globe className="size-4 shrink-0 text-muted-foreground" />;
  return (
    <img
      src={src}
      alt=""
      className="size-4 shrink-0 rounded-sm"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

// ── Sidebar pieces ───────────────────────────────────────────────────────────

/**
 * One badge, Ditto-showcase style: the artwork as a rounded square with the
 * name beneath, linking out to the badge's page on ditto.pub.
 */
function BadgeTile({ badge }: { badge: ProfileBadge }) {
  const naddr = tryNaddrEncode({ kind: 30009, pubkey: badge.issuer, identifier: badge.identifier });
  const href = naddr ? dittoNip19Url(naddr) : undefined;
  // Badge art is usually a content-addressed Blossom blob the issuer uploaded,
  // so it is walked across the viewer's servers before the placeholder shows.
  const placeholder = (
    <div className="size-14 mx-auto rounded-lg border border-border bg-gradient-to-br from-primary/10 via-primary/5 to-transparent flex items-center justify-center">
      <Award className="size-7 text-primary/30" />
    </div>
  );
  const inner = (
    <>
      <FallbackImage
        src={badge.thumb || badge.image || undefined}
        alt={badge.name}
        className="size-14 rounded-lg object-cover mx-auto"
        loading="lazy"
        decoding="async"
        fallback={placeholder}
      />
      <div className="mt-1 text-xs text-center truncate">{badge.name}</div>
    </>
  );
  const title = badge.description ? `${badge.name} — ${badge.description}` : badge.name;
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title} className="block min-w-0 hover:opacity-80 transition-opacity">
      {inner}
    </a>
  ) : (
    <div title={title} className="min-w-0">{inner}</div>
  );
}

/**
 * Shared followers ("followed by people you follow"), best-ranked first per
 * the NIP-85 stats provider. Shows the top few; View all expands in place.
 */
function SharedFollowersCard({
  shared,
  dittoHref,
  cardClass,
}: {
  shared: string[];
  dittoHref?: string;
  cardClass: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? shared : shared.slice(0, 5);
  return (
    <section className={cn("clip-corner-lg border border-border p-4", cardClass)}>
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
        <UserCheck className="size-3.5" />
        {shared.length} shared {shared.length === 1 ? "follower" : "followers"}
      </h2>
      <ul className="space-y-1">
        {visible.map((pk) => (
          <PersonRow key={pk} pubkey={pk} />
        ))}
      </ul>
      {!showAll && shared.length > 5 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1.5 text-xs text-primary hover:underline"
        >
          View all {shared.length}
        </button>
      ) : dittoHref ? (
        <a
          href={dittoHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-block text-xs text-primary hover:underline"
        >
          View more on Ditto
        </a>
      ) : null}
    </section>
  );
}

/** A compact person row linking to their profile view. */
function PersonRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);
  const npub = tryNpubEncode(pubkey);
  const openProfile = useOpenProfile();
  return (
    <li>
      {/* A button rather than a <Link>: opening this keeps the page behind the
          profile mounted, which is a navigation STATE the href can't carry. */}
      <button
        type="button"
        onClick={() => openProfile(npub ?? pubkey)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 touch:py-2.5 hover:bg-secondary transition-colors min-w-0 text-left"
      >
        <Avatar shape={getAvatarShape(metadata)} className="size-7 shrink-0">
          <AvatarImage src={metadata?.picture} alt="" />
          <AvatarFallback className="bg-primary/20 text-primary text-xs">
            {name[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="text-sm truncate">{name}</span>
      </button>
    </li>
  );
}

/**
 * One shared community, wearing its real icon: the encrypted metadata icon
 * from the community's control fold (the same source the rail's icons use),
 * with the folded name preferred over the join-time preview name.
 */
function SharedCommunityRow({ entry }: { entry: SharedCommunity }) {
  const community = useCommunity(entry.idHex);
  const { data: folded } = useControlFold(community, false);
  const iconUrl = useDecryptedImage(folded?.metadata?.icon);
  const name = folded?.metadata?.name || entry.name;
  return (
    <li>
      <Link
        to={`/c/${entry.idHex}`}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 touch:py-2.5 hover:bg-secondary transition-colors min-w-0"
      >
        <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden clip-corner-lg bg-primary/15 text-primary text-xs font-bold">
          {iconUrl ? (
            <img src={iconUrl} alt="" className="size-full object-cover" decoding="async" />
          ) : (
            name.trim()[0]?.toUpperCase() ?? "#"
          )}
        </span>
        <span className="text-sm truncate">{name}</span>
      </Link>
    </li>
  );
}

export default ProfileDialog;
