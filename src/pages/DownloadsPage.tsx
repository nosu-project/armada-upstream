import { ArrowLeft, Check, ChevronDown, Copy, Download, Globe, Info, RefreshCw } from "lucide-react";
import { type ComponentType, type ReactNode, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { AndroidMark, AppleMark, IosMark, LinuxMark, WindowsMark } from "@/components/brand/PlatformMarks";
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

type Icon = ComponentType<{ className?: string }>;

const OS_ICON: Record<DownloadOs, Icon> = {
  linux: LinuxMark,
  windows: WindowsMark,
  macos: AppleMark,
  android: AndroidMark,
  ios: IosMark,
};

/** A note the user needs BEFORE the download, not after it fails to open. */
const OS_CAVEAT: Partial<Record<DownloadOs, string>> = {
  macos: "First launch: Control-click the app, choose Open, then Open Anyway.",
  android: "Installing the APK asks Android to allow installs from your browser.",
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

/** A terminal block holding every line of one install; a single copy takes the lot. */
function CommandBlock({ commands }: { commands: string[] }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const copy = async () => {
    try {
      await writeClipboardText(commands.join("\n"));
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the commands and copy them manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="relative clip-corner-lg bg-black/45">
      <pre className="whitespace-pre-wrap break-all py-3 pl-3.5 pr-12 font-mono text-xs leading-relaxed text-foreground/85">
        {commands.map((command) => (
          <code key={command} className="block">
            <span aria-hidden="true" className="select-none text-[hsl(var(--accent2))]">$ </span>
            {command}
          </code>
        ))}
      </pre>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy commands"}
        className="absolute right-1.5 top-1.5 size-8 touch:size-11 text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

/** Small segmented control for choosing between install methods. */
function Segments<T extends string>({ options, value, onChange }: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
          className={cn(
            "h-8 clip-corner px-3 text-sm transition-colors touch:h-11",
            option.id === value
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A filled link tile: icon, name, and an optional muted trailing note. */
function Tile({ href, icon, title, note, external, download, primary }: {
  href: string;
  icon: ReactNode;
  title: string;
  note?: string;
  external?: boolean;
  download?: string;
  primary?: boolean;
}) {
  return (
    <a
      href={href}
      download={download}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={cn(
        "flex min-h-12 items-center gap-3 clip-corner-lg px-4 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring touch:min-h-14",
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1]",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {note && <span className={cn("shrink-0 text-xs font-normal", primary ? "opacity-80" : "text-muted-foreground")}>{note}</span>}
    </a>
  );
}

function ArtifactTile({ artifact, icon: Icon = Download, primary }: {
  artifact: ReleaseArtifact;
  icon?: Icon;
  primary?: boolean;
}) {
  return (
    // Cross-origin `download` is ignored (Blossom); kept for same-origin mirrors.
    <Tile
      href={artifact.url}
      download={artifact.filename}
      icon={<Icon className="size-4 shrink-0" />}
      title={artifact.label}
      note={artifact.size ? formatBytes(artifact.size) : undefined}
      primary={primary}
    />
  );
}

function Caveat({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      {children}
    </p>
  );
}

/** Linux: the auto-updating repositories first, the AppImage as the last option. */
function LinuxPanel({ artifacts }: { artifacts: ReleaseArtifact[] }) {
  const appImage = artifacts.find((artifact) => installCommand(artifact.filename));
  const options = [
    ...PACKAGE_MANAGERS.filter((manager) => manager.os === "linux").map((manager) => ({ id: manager.label, label: manager.label })),
    ...(appImage ? [{ id: "appimage", label: "AppImage" }] : []),
  ];
  const [method, setMethod] = useState(options[0]?.id ?? "appimage");
  const manager = PACKAGE_MANAGERS.find((m) => m.label === method);
  const others = artifacts.filter((artifact) => artifact !== appImage);

  return (
    <div className="space-y-4">
      <Segments options={options} value={method} onChange={setMethod} />
      {manager ? (
        <>
          <CommandBlock commands={[...manager.setup, manager.install]} />
          <p className="text-xs text-muted-foreground">
            Updates arrive through your package manager, from{" "}
            <a
              href={`https://${NPKG_HOST}`}
              target="_blank"
              rel="noreferrer"
              className="text-foreground/90 underline decoration-muted-foreground/30 underline-offset-4 transition-colors hover:decoration-current"
            >
              {NPKG_HOST}
            </a>
            .
          </p>
        </>
      ) : appImage ? (
        <>
          <ArtifactTile artifact={appImage} primary />
          <CommandBlock commands={[installCommand(appImage.filename)!]} />
        </>
      ) : null}
      {others.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {others.map((artifact) => <ArtifactTile key={artifact.id} artifact={artifact} />)}
        </div>
      )}
    </div>
  );
}

function AndroidPanel({ artifacts }: { artifacts: ReleaseArtifact[] }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        {ANDROID_STORES.map((store) => (
          <Tile
            key={store.url}
            href={store.url}
            external
            icon={<img src={store.icon} alt="" className="size-5 shrink-0" />}
            title={store.label}
          />
        ))}
      </div>
      {artifacts.length > 0 && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {artifacts.map((artifact) => <ArtifactTile key={artifact.id} artifact={artifact} />)}
          </div>
          <Caveat>{OS_CAVEAT.android}</Caveat>
        </>
      )}
    </div>
  );
}

/** iOS: no App Store build yet; the web app (Add to Home Screen) is presented as a real install. */
function IosPanel() {
  const steps = [
    <>Open {APP_NAME} in <strong className="font-medium text-foreground">Safari</strong></>,
    <>Tap <strong className="font-medium text-foreground">Share</strong></>,
    <>Choose <strong className="font-medium text-foreground">Add to Home Screen</strong></>,
  ];

  return (
    <div className="space-y-5">
      <ol className="space-y-2.5">
        {steps.map((step, i) => (
          <li key={i} className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="flex size-6 shrink-0 items-center justify-center clip-corner bg-primary/15 font-mono text-xs font-bold text-primary">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <Button asChild variant="secondary" className="h-auto py-2.5 touch:py-3 clip-corner-lg">
        <Link to="/">
          <Globe className="size-4 shrink-0" />
          Open {APP_NAME} in this browser
        </Link>
      </Button>
      <p className="text-xs text-muted-foreground">A native iPhone app is on its way.</p>
    </div>
  );
}

function PlatformPanel({ os, artifacts }: { os: DownloadOs; artifacts: ReleaseArtifact[] }) {
  if (os === "ios") return <IosPanel />;
  if (os === "linux") return <LinuxPanel artifacts={artifacts} />;
  if (os === "android") return <AndroidPanel artifacts={artifacts} />;

  const caveat = OS_CAVEAT[os];
  if (artifacts.length === 0) {
    return <p className="text-sm text-muted-foreground">This release has no build for this platform.</p>;
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {artifacts.map((artifact, i) => <ArtifactTile key={artifact.id} artifact={artifact} primary={i === 0} />)}
      </div>
      {caveat && <Caveat>{caveat}</Caveat>}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-8 w-48 animate-pulse clip-corner bg-muted-foreground/10" />
      <div className="h-24 animate-pulse clip-corner-lg bg-muted-foreground/10" />
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
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-3 clip-corner px-2 font-mono text-sm text-muted-foreground transition-colors marker:content-none hover:bg-foreground/[0.05] hover:text-foreground touch:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-4 shrink-0 -rotate-90 transition-transform group-open/release:rotate-0 motion-reduce:transition-none" />
        <span className="text-foreground/90">{displayVersion(release.version)}</span>
        {badge && <span className="text-3xs lowercase tracking-wide text-primary/80">{badge}</span>}
        <span className="ml-auto text-xs opacity-70">{displayDate(release.createdAt)}</span>
      </summary>
      <div className="grid gap-2 pb-3 pt-1 sm:grid-cols-2">
        {artifacts.isPending ? (
          <>
            <div className="h-12 animate-pulse clip-corner-lg bg-muted-foreground/10" />
            <div className="h-12 animate-pulse clip-corner-lg bg-muted-foreground/10" />
          </>
        ) : (artifacts.data ?? [])
          .filter((artifact) => !isRepublishedPackage(artifact.filename))
          .sort((a, b) => osOrder(a.os) - osOrder(b.os))
          .map((artifact) => (
            <ArtifactTile key={artifact.id} artifact={artifact} icon={artifact.os ? OS_ICON[artifact.os] : undefined} />
          ))}
      </div>
    </details>
  );
}

/** Collapsed to one line until asked for: most visitors want the current build. */
function OlderReleases({ releases }: { releases: Release[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? releases : releases.slice(0, OLDER_PREVIEW);

  return (
    <details className="group/older">
      <summary className="mx-auto flex w-fit cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-mono text-xs lowercase tracking-wide text-muted-foreground transition-colors marker:content-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        earlier releases
        <ChevronDown className="size-3.5 transition-transform group-open/older:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="vessel-lift mt-3">
        <section className={cn(PANEL, "p-3 sm:p-4")}>
          {shown.map((release) => (
            <OlderRelease key={release.id} release={release} />
          ))}
          <div className="mt-2 flex items-center justify-between px-2 font-mono text-xs lowercase tracking-wide text-muted-foreground">
            {releases.length > OLDER_PREVIEW ? (
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="py-2 transition-colors hover:text-foreground"
              >
                {showAll ? "show fewer" : `show all ${releases.length}`}
              </button>
            ) : <span />}
            <Link to="/changelog" className="py-2 transition-colors hover:text-foreground">
              changelog →
            </Link>
          </div>
        </section>
      </div>
    </details>
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

  // On iOS the primary action is the web app; with no detection, the hero cues the list.
  const featured = DOWNLOAD_PLATFORMS.find((platform) => platform.os === detected);
  const heroArtifact = featured ? byOs.get(featured.os)?.[0] : undefined;
  // Only shown when nothing stable was ever tagged (`featuredRelease` prefers stable).
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
            <p className="text-pretty text-sm text-muted-foreground sm:text-base">
              Desktop, phone or browser.
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
                  {heroArtifact.size > 0 && <> · {formatBytes(heroArtifact.size)}</>}
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
              {heroArtifact ? "Other platforms" : "All platforms"}
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

        <section ref={targetsRef} className="mx-auto max-w-2xl scroll-mt-6 space-y-4 px-4 pb-12 pt-4 sm:px-6">
          <div className="vessel-lift">
            <div className={cn(PANEL, "space-y-6 p-4 sm:p-6")}>
              <PillTabs<DownloadOs>
                tabs={platformTabs}
                value={selectedOs}
                onChange={setSelectedOs}
                className="sm:w-full [&>button]:sm:flex-auto"
              />

              {pending ? (
                <PanelSkeleton />
              ) : latest ? (
                <PlatformPanel key={selectedOs} os={selectedOs} artifacts={byOs.get(selectedOs) ?? []} />
              ) : (
                // No compiled-in fallback list; explain rather than render an empty page.
                <div className="space-y-3 py-4 text-center">
                  <p className="font-mono text-sm lowercase tracking-tight text-foreground">no releases found</p>
                  <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
                    The relays that carry {APP_NAME}'s releases didn't answer. This is
                    almost always a connection problem.
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
