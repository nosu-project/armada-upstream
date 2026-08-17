import {
  ArrowLeft,
  AtSign,
  Check,
  Copy,
  Globe,
  Link as LinkIcon,
  MessageSquare,
  MoreHorizontal,
  Music,
  Palette,
  Pencil,
  UserCheck,
  UserMinus,
  UserX,
  Users,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { DittoIcon } from "@/components/brand/DittoIcon";
import { BotPill } from "@/components/BotPill";
import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { FollowButton } from "@/components/FollowButton";
import { ServerRail } from "@/components/layout/ServerRail";
import { ProfileThemeEditor } from "@/components/profile/ProfileThemeEditor";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSharedCommunities } from "@/concord/hooks/useSharedCommunities";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useFollowToggle } from "@/hooks/useFollowToggle";
import { useMuteToggle } from "@/hooks/useMuteList";
import { useNsite } from "@/hooks/useNsite";
import { useProfileBadges } from "@/hooks/useProfileBadges";
import { useProfileTheme } from "@/hooks/useProfileTheme";
import { isStatusExpired, useUserStatus } from "@/hooks/useUserStatus";
import { getAvatarShape } from "@/lib/avatarShape";
import { dittoProfileUrl } from "@/lib/dittoUrl";
import { loadThemeFont } from "@/lib/fontLoader";
import { getDisplayName } from "@/lib/getDisplayName";
import { resolvePubkey } from "@/lib/resolvePubkey";
import { tryNpubEncode } from "@/lib/safeNip19";
import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { writeClipboardText } from "@/lib/clipboard";
import { NotFound } from "@/pages/NotFound";
import { buildThemeVarStyle } from "@/themes";

import type { CSSProperties } from "react";
import type { ThemeBackground } from "@/lib/themeEvent";

/**
 * A person's full profile — `/u/<npub|nprofile>`. The Discord-style view of
 * everything they publish about themselves: kind-0 metadata (bio, custom
 * fields, website, lightning address), NIP-38 status, NIP-58 badges, and the
 * communities shared with the viewer. No content feed — that stays on Ditto.
 *
 * The whole page wears the owner's Ditto profile theme (kind 16767): colors as
 * scoped CSS vars, body/title fonts, and the background image — the same
 * takeover Ditto's ProfilePage does globally, but scoped to this page's
 * container so the rail keeps the app theme and nothing needs restoring on
 * unmount. Public data, so the page renders signed-out too.
 */
export function ProfilePage() {
  const { id: identifier = "" } = useParams<{ id: string }>();
  const pubkey = useMemo(() => resolvePubkey(identifier), [identifier]);

  if (!pubkey) return <NotFound />;
  return (
    <>
      <ServerRail />
      <ProfileView pubkey={pubkey} />
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

function backgroundStyle(bg: ThemeBackground): CSSProperties {
  return bg.mode === "tile"
    ? { backgroundImage: `url("${bg.url}")`, backgroundRepeat: "repeat", backgroundSize: "auto" }
    : {
        backgroundImage: `url("${bg.url}")`,
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
      };
}

function ProfileView({ pubkey }: { pubkey: string }) {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const themeResult = useProfileTheme(pubkey).data;
  const theme = themeResult?.theme;
  const nsite = useNsite(pubkey).data;
  const badges = useProfileBadges(pubkey).data ?? [];
  const shared = useSharedCommunities(pubkey).data ?? [];

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

  const [copied, setCopied] = useState(false);
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);

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
  // Over a background image the surfaces go translucent so it shows through.
  const card = background
    ? "bg-card/85 supports-[backdrop-filter]:bg-card/70 backdrop-blur-md"
    : "bg-card";

  const copyNpub = () => {
    if (!npub) return;
    writeClipboardText(npub).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };

  return (
    <main
      className="relative flex-1 min-w-0 overflow-hidden bg-background text-foreground"
      style={pageStyle}
    >
      {background && (
        <div aria-hidden className="absolute inset-0" style={backgroundStyle(background)} />
      )}

      <div className="relative h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-3 py-3 md:px-6 md:py-6">
          {/* Back — profiles are always reached from somewhere. */}
          <Button
            size="sm"
            variant="ghost"
            className={cn("mb-2 h-9 touch:h-11 gap-1.5", background && "bg-background/50 hover:bg-background/70")}
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>

          {/* Header card: banner, avatar, identity, actions. */}
          <section className={cn("clip-corner-lg overflow-hidden border border-border", card)}>
            <div className="h-32 md:h-44 bg-secondary relative">
              {metadata?.banner && (
                <img src={metadata.banner} alt="" className="w-full h-full object-cover" loading="lazy" />
              )}
            </div>

            <div className="px-4 pb-4 md:px-6 md:pb-6">
              <div className="flex items-end justify-between gap-2">
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
                      <Button size="sm" variant="secondary" className="clip-corner-lg h-9 touch:h-11" asChild>
                        <Link to="/settings">
                          <Pencil className="size-4 mr-1.5" />
                          Edit profile
                        </Link>
                      </Button>
                    </>
                  ) : (
                    <>
                      {user && npub && (
                        <Button size="sm" className="clip-corner-lg h-9 touch:h-11" onClick={() => navigate(`/dm/${npub}`)}>
                          <MessageSquare className="size-4 mr-1.5" />
                          Message
                        </Button>
                      )}
                      <FollowButton pubkey={pubkey} className="h-9 touch:h-11" />
                      {user && (isFollowing || mute.canMute) && (
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
                            {isFollowing && (
                              <DropdownMenuItem disabled={followPending} onSelect={() => void toggleFollow()}>
                                <UserMinus className="mr-2 size-4" />
                                Unfollow
                              </DropdownMenuItem>
                            )}
                            {mute.canMute && (
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
                            )}
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

          {/* Below the header: fields on the left, badges/communities beside. */}
          <div className="mt-3 md:mt-4 grid gap-3 md:gap-4 lg:grid-cols-[1fr_18rem] items-start">
            <div className="space-y-3 md:space-y-4 min-w-0">
              {(fields.length > 0 || website || metadata?.lud16) && (
                <section className={cn("clip-corner-lg border border-border p-4 md:p-5", card)}>
                  <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                    About
                  </h2>
                  <dl className="space-y-2">
                    {website && (
                      <ProfileFieldRow label="Website">
                        <a href={website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">
                          <LinkIcon className="inline size-3.5 mr-1 align-[-2px]" />
                          {website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                        </a>
                      </ProfileFieldRow>
                    )}
                    {metadata?.lud16 && (
                      <ProfileFieldRow label="Lightning">
                        <span className="break-all">
                          <Zap className="inline size-3.5 mr-1 align-[-2px] text-primary" />
                          {metadata.lud16}
                        </span>
                      </ProfileFieldRow>
                    )}
                    {fields.map(([label, value], i) => {
                      const href = sanitizeUrl(value);
                      return (
                        <ProfileFieldRow key={`${label}-${i}`} label={label}>
                          {href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">
                              {value}
                            </a>
                          ) : (
                            <span className="break-words">{value}</span>
                          )}
                        </ProfileFieldRow>
                      );
                    })}
                  </dl>
                </section>
              )}
            </div>

            <div className="space-y-3 md:space-y-4 min-w-0">
              {badges.length > 0 && (
                <section className={cn("clip-corner-lg border border-border p-4", card)}>
                  <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                    Badges
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {badges.map((badge) => (
                      <div
                        key={badge.addr}
                        className="flex items-center gap-1.5 rounded-full bg-secondary pl-1 pr-2.5 py-1"
                        title={badge.description ? `${badge.name} — ${badge.description}` : badge.name}
                      >
                        {(badge.thumb || badge.image) ? (
                          <img
                            src={badge.thumb || badge.image}
                            alt=""
                            className="size-6 rounded-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <span className="flex size-6 items-center justify-center rounded-full bg-primary/20 text-primary text-[10px] font-bold">
                            {badge.name[0]?.toUpperCase()}
                          </span>
                        )}
                        <span className="text-xs font-medium truncate max-w-32">{badge.name}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {!isSelf && shared.length > 0 && (
                <section className={cn("clip-corner-lg border border-border p-4", card)}>
                  <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Users className="size-3.5" />
                    Shared communities
                  </h2>
                  <ul className="space-y-1">
                    {shared.map((c) => (
                      <li key={c.idHex}>
                        <Link
                          to={`/c/${c.idHex}`}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 touch:py-2.5 hover:bg-secondary transition-colors min-w-0"
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center clip-corner-lg bg-primary/15 text-primary text-xs font-bold">
                            {c.name[0]?.toUpperCase() ?? "#"}
                          </span>
                          <span className="text-sm truncate">{c.name}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>
        </div>
      </div>

      {isSelf && (
        <ProfileThemeEditor
          open={themeEditorOpen}
          onOpenChange={setThemeEditorOpen}
          current={theme}
        />
      )}
    </main>
  );
}

function ProfileFieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 text-sm items-baseline">
      <dt className="text-muted-foreground truncate" title={label}>{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export default ProfilePage;
