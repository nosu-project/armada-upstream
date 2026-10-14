import {
  AppWindow,
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Download,
  Globe,
  Info,
  Laptop,
  Package,
  RefreshCw,
  Share,
  Smartphone,
  SquarePlus,
  TabletSmartphone,
  Terminal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { AsciiSea } from "@/components/landing/AsciiSea";
import { Button } from "@/components/ui/button";
import { type PillTab, PillTabs } from "@/components/ui/pill-tabs";
import { useBackOrHome } from "@/hooks/useBackOrHome";
import { useReleaseArtifacts, useReleases } from "@/hooks/useReleases";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import {
  ANDROID_STORES,
  DOWNLOAD_PLATFORMS,
  type DownloadOs,
  type DownloadPlatform,
  NPKG_HOST,
  PACKAGE_MANAGERS,
  detectCurrentOs,
  installCommand,
  isRepublishedPackage,
} from "@/lib/downloads";
import { formatBytes } from "@/lib/fileBytes";
import { APP_NAME } from "@/lib/platform";
import { featuredRelease, isStable, type Release, type ReleaseArtifact } from "@/lib/releases";
import { cn } from "@/lib/utils";

/**
 * The downloads deck, in the landing's visual language over the
 * {@link AsciiSea}. Every file comes from a NIP-82 release and its asset events
 * (`docs/releases.md`): verifiable links, at the cost of a spinner on a cold pool.
 */

const OS_ICON: Record<DownloadOs, LucideIcon> = {
  linux: Terminal,
  windows: AppWindow,
  macos: Laptop,
  android: Smartphone,
  ios: TabletSmartphone,
};

/** A note the user needs BEFORE the download, not after it fails to open. */
const OS_CAVEAT: Partial<Record<DownloadOs, string>> = {
  macos: "Ad-hoc signed rather than notarized, so the first launch needs Control-click → Open, then Open Anyway.",
  android: "Sideloading the APK asks Android to allow installs from your browser.",
};

/** Earlier releases shown before "show all". */
const OLDER_PREVIEW = 5;

/** Opaque enough to read over the sea; the blur keeps the swell as texture. */
const PANEL = "vessel backdrop-blur-md [--vessel-fill:hsl(var(--background)/0.86)]";

/** True when the user has asked the OS to keep motion to a minimum. */
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** NIP-82 versions drop the tag's `v`; the page shows the tag. */
function displayVersion(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

function displayDate(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Tab order; unplaceable artifacts sort last. */
function osOrder(os: DownloadOs | undefined): number {
  const index = DOWNLOAD_PLATFORMS.findIndex((platform) => platform.os === os);
  return index === -1 ? DOWNLOAD_PLATFORMS.length : index;
}

/** The badge a prerelease wears; undefined for a stable release. */
function prereleaseBadge(release: Release): string | undefined {
  if (isStable(release)) return undefined;
  return release.channel === "main" ? "prerelease" : release.channel;
}

/**
 * The release's artifacts by platform. `.deb`/`.flatpak` are omitted:
 * they're served via pkg.soapbox.pub ({@link PACKAGE_MANAGERS}) but stay in
 * the release event for npkg.
 */
function groupByOs(artifacts: readonly ReleaseArtifact[] | undefined): Map<DownloadOs, ReleaseArtifact[]> {
  const grouped = new Map<DownloadOs, ReleaseArtifact[]>();
  for (const artifact of artifacts ?? []) {
    if (!artifact.os) continue;
    if (isRepublishedPackage(artifact.filename)) continue;
    const existing = grouped.get(artifact.os);
    if (existing) existing.push(artifact);
    else grouped.set(artifact.os, [artifact]);
  }
  return grouped;
}

/** Copy-to-clipboard with a transient "copied" state. */
function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const copy = async () => {
    try {
      await writeClipboardText(text);
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the command and copy it manually.",
        variant: "destructive",
      });
    }
  };

  return { copied, copy };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      className="size-7 touch:size-9 shrink-0 text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

/** A copyable shell line. Long URLs wrap rather than hide behind a scrollbar. */
function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex items-start gap-1 py-0.5">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all py-1.5 font-mono text-xs leading-relaxed text-foreground/85">
        <span aria-hidden="true" className="select-none text-[hsl(var(--accent2))]">$ </span>
        {command}
      </code>
      <CopyButton text={command} label="Copy command" />
    </div>
  );
}

/** A terminal-styled block of commands; `tabs` swaps between alternatives. */
function TerminalBlock({ children, tabs, copyAll }: {
  children: React.ReactNode;
  tabs?: React.ReactNode;
  copyAll?: string;
}) {
  return (
    <div className="clip-corner-lg bg-black/45">
      {(tabs || copyAll) && (
        <div className="flex items-center gap-2 bg-foreground/[0.04] px-2 py-1.5">
          {tabs ?? <Terminal className="ml-1 size-3.5 text-muted-foreground" />}
          {copyAll && (
            <span className="ml-auto">
              <CopyButton text={copyAll} label="Copy all commands" />
            </span>
          )}
        </div>
      )}
      <div className="px-3 py-2">{children}</div>
    </div>
  );
}

/** A section heading inside the panel, with an optional chip. */
function SectionLabel({ children, chip }: { children: React.ReactNode; chip?: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <h3 className="font-mono text-xs lowercase tracking-wide text-muted-foreground">{children}</h3>
      {chip && (
        <span className="clip-corner bg-[hsl(var(--accent2)/0.12)] px-1.5 py-0.5 font-mono text-3xs lowercase tracking-wide text-[hsl(var(--accent2))]">
          {chip}
        </span>
      )}
    </div>
  );
}

function Caveat({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2.5 clip-corner-lg bg-amber-300/[0.07] px-3.5 py-3 text-xs leading-relaxed text-foreground/75">
      <Info className="mt-px size-4 shrink-0 text-amber-300/90" />
      <span>{children}</span>
    </p>
  );
}

/** A filled download tile: icon, label, and the line beneath it. */
function Tile({ href, icon, title, meta, detail, external, download }: {
  href: string;
  icon: React.ReactNode;
  title: string;
  meta?: string;
  detail: string;
  external?: boolean;
  download?: string;
}) {
  return (
    <a
      href={href}
      download={download}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="group flex min-h-16 items-center gap-3 clip-corner-lg bg-foreground/[0.05] px-3.5 py-3 transition-colors hover:bg-foreground/[0.09] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="flex size-9 shrink-0 items-center justify-center clip-corner bg-primary/10 text-primary transition-colors group-hover:bg-primary/20">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-tight text-foreground">
          {title}
          {meta && <span className="font-normal text-muted-foreground"> · {meta}</span>}
        </span>
        <span className="break-all font-mono text-2xs leading-tight text-muted-foreground/80">{detail}</span>
      </span>
    </a>
  );
}

/** One artifact, plus the shell line it needs afterwards if any. */
function ArtifactTile({ artifact, icon, compact }: { artifact: ReleaseArtifact; icon?: LucideIcon; compact?: boolean }) {
  const Icon = icon ?? Download;
  const command = compact ? undefined : installCommand(artifact.filename);
  return (
    <div className={cn("flex flex-col gap-2", command && "sm:col-span-2")}>
      {/* Cross-origin `download` is ignored (Blossom); kept for same-origin mirrors. */}
      <Tile
        href={artifact.url}
        download={artifact.filename}
        icon={<Icon className="size-4" />}
        title={artifact.label}
        meta={artifact.size ? formatBytes(artifact.size) : undefined}
        detail={artifact.filename}
      />
      {command && (
        <TerminalBlock>
          <CommandLine command={command} />
        </TerminalBlock>
      )}
    </div>
  );
}

/** The pkg.soapbox.pub repositories for a platform, as one tabbed terminal. */
function PackageManagers({ os }: { os: DownloadOs }) {
  const managers = PACKAGE_MANAGERS.filter((manager) => manager.os === os);
  const [selected, setSelected] = useState(managers[0]?.label);
  const manager = managers.find((m) => m.label === selected) ?? managers[0];
  if (!manager) return null;
  const commands = [...manager.setup, manager.install];

  return (
    <section>
      <SectionLabel chip="auto-updates">package repository</SectionLabel>
      <TerminalBlock
        copyAll={commands.join("\n")}
        tabs={
          managers.length > 1 ? (
            <div className="flex min-w-0 flex-wrap gap-1">
              {managers.map((m) => (
                <button
                  key={m.label}
                  type="button"
                  aria-pressed={m === manager}
                  onClick={() => setSelected(m.label)}
                  className={cn(
                    "flex h-7 items-center gap-1.5 clip-corner px-2.5 font-mono text-xs transition-colors touch:h-9",
                    m === manager
                      ? "bg-foreground/10 text-foreground"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                  )}
                >
                  <Package className="size-3.5 shrink-0" />
                  {m.label}
                </button>
              ))}
            </div>
          ) : (
            <Package className="ml-1 size-3.5 text-muted-foreground" />
          )
        }
      >
        {commands.map((command) => (
          <CommandLine key={command} command={command} />
        ))}
      </TerminalBlock>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground/80">
        Republished from Nostr by{" "}
        <a
          href={`https://${NPKG_HOST}`}
          target="_blank"
          rel="noreferrer"
          className="text-foreground/90 underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:decoration-current"
        >
          {NPKG_HOST}
        </a>
        , which verifies each build against the hash its signed release names.
      </p>
    </section>
  );
}

function AndroidStores() {
  return (
    <section>
      <SectionLabel chip="auto-updates">app stores</SectionLabel>
      <div className="grid gap-2 sm:grid-cols-3">
        {ANDROID_STORES.map((store) => (
          <Tile
            key={store.url}
            href={store.url}
            external
            icon={<img src={store.icon} alt="" className="size-5" />}
            title={store.label}
            detail={store.hint}
          />
        ))}
      </div>
    </section>
  );
}

/** iOS: no App Store build yet; the web app (Add to Home Screen) is presented as a real install. */
function IosInstructions({ platform }: { platform: DownloadPlatform }) {
  const steps: { icon: LucideIcon; text: React.ReactNode }[] = [
    { icon: Globe, text: <>Open {APP_NAME} in <strong className="text-foreground">Safari</strong></> },
    { icon: Share, text: <>Tap the <strong className="text-foreground">Share</strong> button</> },
    { icon: SquarePlus, text: <>Choose <strong className="text-foreground">Add to Home Screen</strong></> },
  ];

  return (
    <section className="space-y-4">
      <div>
        <SectionLabel chip={platform.empty}>install the web app</SectionLabel>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {APP_NAME} installs as a full-screen web app that lives on your Home Screen like any other.
        </p>
      </div>
      <ol className="grid gap-2 sm:grid-cols-3">
        {steps.map((step, i) => (
          <li key={i} className="flex items-center gap-3 clip-corner-lg bg-foreground/[0.05] px-3.5 py-3 text-sm text-muted-foreground">
            <span className="flex size-9 shrink-0 items-center justify-center clip-corner bg-primary/10 font-mono text-sm font-bold text-primary">
              {i + 1}
            </span>
            <span className="leading-snug">{step.text}</span>
          </li>
        ))}
      </ol>
      <Button asChild variant="secondary" className="h-auto py-2.5 touch:py-3 clip-corner-lg">
        <Link to="/">
          <Globe className="size-4 shrink-0" />
          Open {APP_NAME} in this browser
        </Link>
      </Button>
    </section>
  );
}

function PlatformPanel({ platform, artifacts }: { platform: DownloadPlatform; artifacts: ReleaseArtifact[] }) {
  const caveat = OS_CAVEAT[platform.os];
  const hasPackageManagers = PACKAGE_MANAGERS.some((manager) => manager.os === platform.os);

  if (platform.os === "ios") return <IosInstructions platform={platform} />;

  return (
    <div className="space-y-6">
      {/* Package repos and stores lead: recommended, and the only paths that auto-update. */}
      {hasPackageManagers && <PackageManagers os={platform.os} />}
      {platform.os === "android" && <AndroidStores />}

      {artifacts.length > 0 ? (
        <section>
          <SectionLabel>{hasPackageManagers || platform.os === "android" ? "or download directly" : "download"}</SectionLabel>
          <div className="grid gap-2 sm:grid-cols-2">
            {artifacts.map((artifact) => (
              <ArtifactTile key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          This release has no {platform.name} build.
        </p>
      )}

      {caveat && artifacts.length > 0 && <Caveat>{caveat}</Caveat>}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2.5">
        <div className="h-3 w-32 animate-pulse rounded bg-muted-foreground/20" />
        <div className="h-28 animate-pulse clip-corner-lg bg-muted-foreground/10" />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="h-16 animate-pulse clip-corner-lg bg-muted-foreground/10" />
        <div className="h-16 animate-pulse clip-corner-lg bg-muted-foreground/10" />
      </div>
    </div>
  );
}

/** One past version, collapsed. Its artifacts are fetched on first expand. */
function OlderRelease({ release }: { release: Release }) {
  const [opened, setOpened] = useState(false);
  const artifacts = useReleaseArtifacts(opened ? release : undefined);
  const badge = prereleaseBadge(release);

  return (
    <details
      className="group/release"
      onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 clip-corner px-3 font-mono text-sm text-muted-foreground transition-colors marker:content-none hover:bg-foreground/[0.05] hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-4 shrink-0 -rotate-90 transition-transform group-open/release:rotate-0 motion-reduce:transition-none" />
        <span className="font-bold text-foreground/90">{displayVersion(release.version)}</span>
        {badge && <span className="text-3xs lowercase tracking-wide text-primary/80">{badge}</span>}
        <span className="ml-auto text-xs opacity-70">{displayDate(release.createdAt)}</span>
      </summary>
      <div className="grid gap-2 px-1 pb-3 pt-1 sm:grid-cols-2">
        {artifacts.isPending ? (
          <>
            <div className="h-16 animate-pulse clip-corner-lg bg-muted-foreground/10" />
            <div className="h-16 animate-pulse clip-corner-lg bg-muted-foreground/10" />
          </>
        ) : (artifacts.data ?? [])
          .filter((artifact) => !isRepublishedPackage(artifact.filename))
          .sort((a, b) => osOrder(a.os) - osOrder(b.os))
          .map((artifact) => (
            <ArtifactTile
              key={artifact.id}
              artifact={artifact}
              icon={artifact.os ? OS_ICON[artifact.os] : undefined}
              compact
            />
          ))}
      </div>
    </details>
  );
}

function OlderReleases({ releases }: { releases: Release[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? releases : releases.slice(0, OLDER_PREVIEW);

  return (
    <div className="vessel-lift">
      <section className={cn(PANEL, "p-4 sm:p-5")}>
        <header className="mb-2 flex items-baseline gap-2 px-1">
          <h2 className="font-mono text-sm font-bold lowercase tracking-tight text-foreground">earlier releases</h2>
          <span className="font-mono text-xs text-muted-foreground">{releases.length}</span>
          <Link
            to="/changelog"
            className="ml-auto font-mono text-xs lowercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
          >
            changelog →
          </Link>
        </header>
        <div className="divide-y divide-border/30">
          {shown.map((release) => (
            <OlderRelease key={release.id} release={release} />
          ))}
        </div>
        {releases.length > OLDER_PREVIEW && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowAll((value) => !value)}
            className="mt-2 w-full clip-corner-lg font-mono text-xs lowercase tracking-wide text-muted-foreground"
          >
            {showAll ? "show fewer" : `show all ${releases.length}`}
            <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} />
          </Button>
        )}
      </section>
    </div>
  );
}

export function DownloadsPage() {
  const back = useBackOrHome();
  // The sea reads scrollTop imperatively, so a ref, never state.
  const scrollRef = useRef<HTMLElement>(null);
  const targetsRef = useRef<HTMLElement>(null);
  // Detected once: a featured card moving between renders is worse than a wrong guess.
  const detected = useMemo(() => detectCurrentOs(), []);
  const [selectedOs, setSelectedOs] = useState<DownloadOs>(detected ?? DOWNLOAD_PLATFORMS[0].os);

  const releases = useReleases();
  // Newest STABLE leads, so a release candidate doesn't become everyone's download.
  const latest = useMemo(() => featuredRelease(releases.data ?? []), [releases.data]);
  const older = (releases.data ?? []).filter((release) => release !== latest);
  const artifacts = useReleaseArtifacts(latest);
  const byOs = useMemo(() => groupByOs(artifacts.data), [artifacts.data]);
  const pending = releases.isPending || (!!latest && artifacts.isPending);

  const platformTabs = useMemo(
    (): PillTab<DownloadOs>[] =>
      DOWNLOAD_PLATFORMS.map((platform) => ({ id: platform.os, label: platform.name, icon: OS_ICON[platform.os] })),
    [],
  );
  const selected = DOWNLOAD_PLATFORMS.find((platform) => platform.os === selectedOs) ?? DOWNLOAD_PLATFORMS[0];

  // On iOS the primary action is the web app; with no detection, the hero cues the list.
  const featured = DOWNLOAD_PLATFORMS.find((platform) => platform.os === detected);
  const heroArtifact = featured ? byOs.get(featured.os)?.[0] : undefined;
  const channel = latest ? prereleaseBadge(latest) : undefined;

  const scrollToTargets = () => {
    targetsRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  };

  return (
    <main ref={scrollRef} className="relative flex-1 min-w-0 overflow-y-auto">
      {/* Viewport-locked sea: `sticky` pins it, `-mb-[100svh]` cancels its scroll height. */}
      <div className="pointer-events-none sticky top-0 z-0 -mb-[100svh] h-[100svh]">
        <AsciiSea scrollRef={scrollRef} />
      </div>

      <Button
        variant="ghost"
        size="icon"
        aria-label="Back"
        onClick={back}
        className="absolute left-2 top-2 z-20 size-9 touch:size-11 text-muted-foreground hover:text-foreground safe-area-top"
      >
        <ArrowLeft className="size-5" />
      </Button>

      <div className="relative z-10">
        <section className="mx-auto flex min-h-[88svh] max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center safe-area-top">
          <ArmadaCrest size={130} />
          <div className="space-y-3">
            <h1 className="font-mono text-3xl font-bold lowercase tracking-tight text-foreground sm:text-4xl">
              get {APP_NAME.toLowerCase()}
            </h1>
            <p className="text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
              Desktop, phone or browser. Every build is published to Nostr and fetched
              by its hash, so what you download is exactly what was released.
            </p>
          </div>

          <div className="flex w-full max-w-sm flex-col items-center">
            {heroArtifact && featured ? (
              <>
                <Button size="lg" asChild className="h-12 w-full clip-corner-lg text-base font-medium">
                  <a href={heroArtifact.url} download={heroArtifact.filename}>
                    <Download className="size-5" />
                    Download for {featured.name}
                  </a>
                </Button>
                <p className="mt-3 font-mono text-xs text-muted-foreground">
                  {latest && displayVersion(latest.version)}
                  {channel && <span className="text-primary/80"> {channel}</span>}
                  <span className="text-muted-foreground/50"> · </span>
                  {heroArtifact.label}
                  {heroArtifact.size > 0 && (
                    <>
                      <span className="text-muted-foreground/50"> · </span>
                      {formatBytes(heroArtifact.size)}
                    </>
                  )}
                </p>
              </>
            ) : featured?.os === "ios" ? (
              <Button size="lg" asChild className="h-12 w-full clip-corner-lg text-base font-medium">
                <Link to="/">
                  <Globe className="size-5" />
                  Open {APP_NAME} in this browser
                </Link>
              </Button>
            ) : pending ? (
              <div className="h-12 w-full animate-pulse clip-corner-lg bg-muted-foreground/15" />
            ) : null}
            <button
              type="button"
              onClick={scrollToTargets}
              className="group mt-6 flex w-full flex-col items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {heroArtifact ? "Other formats & platforms" : "All platforms"}
              {/* U+2193: WGL4 core, so every system font has a glyph. */}
              <span
                aria-hidden="true"
                className="animate-[armada-bob_2.4s_ease-in-out_infinite] text-base leading-none text-[hsl(var(--accent2)/0.75)] group-hover:text-[hsl(var(--accent2))]"
              >
                &#8595;
              </span>
            </button>
          </div>
        </section>

        <section ref={targetsRef} className="mx-auto max-w-3xl scroll-mt-6 space-y-5 px-4 pb-12 pt-4 sm:px-6">
          <div className="vessel-lift">
            <div className={cn(PANEL, "p-4 sm:p-6")}>
              <PillTabs<DownloadOs>
                tabs={platformTabs}
                value={selected.os}
                onChange={setSelectedOs}
                className="sm:w-full [&>button]:sm:flex-auto"
              />

              {pending ? (
                <div className="mt-6"><PanelSkeleton /></div>
              ) : latest ? (
                <>
                  <header className="mb-6 mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h2 className="font-mono text-xl font-bold tracking-tight text-foreground">
                      <span className="lowercase">{APP_NAME}</span>
                      <span className="text-muted-foreground"> for </span>
                      {selected.name}
                    </h2>
                    {selected.os !== "ios" && (
                      <p className="font-mono text-xs text-muted-foreground">
                        <span className="text-foreground/80">{displayVersion(latest.version)}</span>
                        {/* Only shown when nothing stable was ever tagged (`featuredRelease` prefers stable). */}
                        {channel && <span className="text-primary/80"> {channel}</span>}
                        <span className="text-muted-foreground/50"> · </span>
                        {displayDate(latest.createdAt)}
                      </p>
                    )}
                  </header>
                  <PlatformPanel platform={selected} artifacts={byOs.get(selected.os) ?? []} />
                </>
              ) : (
                // No compiled-in fallback list; explain rather than render an empty page.
                <div className="mt-6 space-y-3 py-4 text-center">
                  <p className="font-mono text-sm lowercase tracking-tight text-foreground">no releases found</p>
                  <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
                    {APP_NAME}'s builds are published to Nostr relays, and none of them
                    answered just now. This is almost always a connection problem rather
                    than a missing release.
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => releases.refetch()}
                    disabled={releases.isFetching}
                    className="clip-corner-lg"
                  >
                    <RefreshCw className={cn("size-4", releases.isFetching && "animate-spin")} />
                    Try again
                  </Button>
                </div>
              )}
            </div>
          </div>

          {!pending && older.length > 0 && <OlderReleases releases={older} />}
        </section>

        {/* Sign-off: the landing's terminal prompt (`armada-caret` from the crest's keyframes). */}
        <section className="mx-auto flex min-h-[40svh] max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center safe-area-bottom">
          <p className="font-mono text-xl text-[hsl(var(--primary))] sm:text-2xl">
            <span className="text-[hsl(var(--accent2,180_90%_55%))]">$ </span>
            anchors aweigh
            <span className="animate-[armada-caret_1s_step-end_infinite]">_</span>
          </p>

          <div className="w-full max-w-sm">
            <Button size="lg" asChild className="h-12 w-full clip-corner-lg text-base font-medium">
              <Link to="/">Return home</Link>
            </Button>
          </div>
        </section>

        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent via-black/45 to-black/90"
        />
      </div>

      <ArmadaCrestKeyframes />
      <DownloadsKeyframes />
    </main>
  );
}

/** Page-local keyframes, scoped the way the landing page's are. */
function DownloadsKeyframes() {
  return (
    <style>{`
      /* The scroll cue riding the swell. Transform only. */
      @keyframes armada-bob {
        0%, 100% { transform: translateY(0); opacity: 0.55; }
        50%      { transform: translateY(0.4rem); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        [class*="animate-[armada-bob"] { animation: none !important; }
      }
    `}</style>
  );
}
