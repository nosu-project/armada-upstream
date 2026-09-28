import { AppWindow, ArrowLeft, Check, Copy, Download, Globe, Laptop, RefreshCw, Smartphone, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { AsciiSea } from "@/components/landing/AsciiSea";
import { Button } from "@/components/ui/button";
import { useBackOrHome } from "@/hooks/useBackOrHome";
import { useReleases } from "@/hooks/useReleases";
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
import { featuredRelease, type Release, type ReleaseArtifact } from "@/lib/releases";

/**
 * The downloads deck, in the landing's visual language over the
 * {@link AsciiSea}. Every file comes from a kind-30622 release event
 * (`docs/releases.md`): verifiable links, at the cost of a spinner on a cold pool.
 */

const OS_ICON: Record<DownloadOs, LucideIcon> = {
  linux: Terminal,
  windows: AppWindow,
  macos: Laptop,
  android: Smartphone,
  ios: Smartphone,
};

/** A note the user needs BEFORE the download, not after it fails to open. */
const OS_CAVEAT: Partial<Record<DownloadOs, string>> = {
  macos: "Ad-hoc signed rather than notarized, so the first launch needs Control-click → Open, then Open Anyway.",
  android: "Sideloading the APK asks Android to allow installs from your browser.",
};

/** True when the user has asked the OS to keep motion to a minimum. */
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The release's artifacts by platform card. `.deb`/`.flatpak` are omitted:
 * they're served via pkg.soapbox.pub ({@link PACKAGE_MANAGERS}) but stay in
 * the release event for npkg.
 */
function groupByOs(release: Release | undefined): Map<DownloadOs, ReleaseArtifact[]> {
  const grouped = new Map<DownloadOs, ReleaseArtifact[]>();
  for (const artifact of release?.artifacts ?? []) {
    if (!artifact.os) continue;
    if (isRepublishedPackage(artifact.filename)) continue;
    const existing = grouped.get(artifact.os);
    if (existing) existing.push(artifact);
    else grouped.set(artifact.os, [artifact]);
  }
  return grouped;
}

/** The pkg.soapbox.pub install commands for a platform, if it has any. */
function PackageManagers({ os }: { os: DownloadOs }) {
  const managers = PACKAGE_MANAGERS.filter((manager) => manager.os === os);
  if (managers.length === 0) return null;

  return (
    <div className="space-y-3">
      {managers.map((manager) => (
        <div key={manager.label} className="space-y-1.5">
          <p className="font-mono text-xs lowercase tracking-wide text-muted-foreground">{manager.label}</p>
          {manager.setup.map((command) => (
            <CommandLine key={command} command={command} />
          ))}
          <CommandLine command={manager.install} />
        </div>
      ))}
      <p className="text-xs text-muted-foreground/70 leading-relaxed">
        Packages are republished from Nostr by{" "}
        <a
          href={`https://${NPKG_HOST}`}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          {NPKG_HOST}
        </a>
        , which verifies each build against the hash its signed release names.
      </p>
    </div>
  );
}

/** A copyable CLI command; the command scrolls so the copy button stays visible. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const copy = async () => {
    try {
      await writeClipboardText(command);
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

  return (
    <div className="flex items-center gap-1 clip-corner-lg bg-background/60 pl-2.5 pr-1">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
        <span aria-hidden="true" className="select-none text-[hsl(var(--accent2)/0.75)]">$ </span>
        {command}
      </code>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy command"}
        className="size-7 touch:size-9 shrink-0 text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}

/** One artifact: the button, and the shell line it needs afterwards if any. */
function ArtifactButton({ artifact, primary }: { artifact: ReleaseArtifact; primary?: boolean }) {
  const command = installCommand(artifact.filename);
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        asChild
        variant={primary ? "default" : "secondary"}
        className="h-auto py-2.5 touch:py-3 justify-start text-left clip-corner-lg"
      >
        {/* Cross-origin `download` is ignored (Blossom); kept for same-origin mirrors. */}
        <a href={artifact.url} download={artifact.filename}>
          <Download className="size-4 shrink-0" />
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className="font-medium leading-tight">
              {artifact.label}
              {artifact.size ? <span className="font-normal opacity-70"> · {formatBytes(artifact.size)}</span> : null}
            </span>
            <span className="text-xs font-normal opacity-70 leading-tight whitespace-normal break-all">
              {artifact.filename}
            </span>
          </span>
        </a>
      </Button>
      {command && <CommandLine command={command} />}
    </div>
  );
}

function TargetCard({ platform, artifacts, version, channel, featured }: {
  platform: DownloadPlatform;
  artifacts: ReleaseArtifact[];
  version?: string;
  channel?: string;
  featured?: boolean;
}) {
  const Icon = OS_ICON[platform.os];
  const caveat = OS_CAVEAT[platform.os];
  const hasPackageManagers = PACKAGE_MANAGERS.some((manager) => manager.os === platform.os);

  return (
    // Translucent so the swell shows through; the featured card is more solid.
    <section
      className={`clip-corner-lg p-4 space-y-3 ${featured ? "bg-background/60" : "bg-background/40"}`}
    >
      <header className="flex items-center gap-2">
        <Icon className={`size-5 shrink-0 ${featured ? "text-primary" : "text-muted-foreground"}`} />
        <h2 className="font-mono font-bold lowercase tracking-tight leading-tight">{platform.name}</h2>
        {featured && (
          <span className="font-mono text-[10px] lowercase tracking-wide text-primary/80">your platform</span>
        )}
        {artifacts.length > 0 && version && (
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            {/* Only shown when nothing stable was ever tagged (`featuredRelease` prefers stable). */}
            {channel && channel !== "main" && (
              <span className="font-mono text-[10px] lowercase tracking-wide text-primary/80">{channel}</span>
            )}
            <span className="font-mono text-xs text-muted-foreground">{version}</span>
          </span>
        )}
      </header>

      {/* Package repos lead: recommended, and the only path that auto-updates. */}
      <PackageManagers os={platform.os} />

      {artifacts.length > 0 || platform.os === "android" ? (
        <div className="space-y-2">
          {hasPackageManagers && artifacts.length > 0 && (
            <p className="font-mono text-xs lowercase tracking-wide text-muted-foreground">or download directly</p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
          {artifacts.map((artifact, i) => (
            <ArtifactButton key={artifact.hash || artifact.url} artifact={artifact} primary={featured && i === 0} />
          ))}
          {platform.os === "android" &&
            ANDROID_STORES.map((store) => (
              <Button
                key={store.url}
                asChild
                variant="secondary"
                className="h-auto py-2.5 touch:py-3 justify-start text-left clip-corner-lg"
              >
                <a href={store.url} target="_blank" rel="noreferrer">
                  <img src={store.icon} alt="" className="size-4 shrink-0" />
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium leading-tight">{store.label}</span>
                    <span className="text-xs font-normal opacity-70 leading-tight whitespace-normal">{store.hint}</span>
                  </span>
                </a>
              </Button>
            ))}
          </div>
        </div>
      ) : (
        // iOS: no App Store build yet; the web app (Add to Home Screen) is presented as a real install.
        <div className="space-y-2">
          {platform.empty && (
            <p className="font-mono text-xs lowercase tracking-wide text-primary/80">{platform.empty}</p>
          )}
          <p className="text-sm text-muted-foreground leading-relaxed">
            {APP_NAME} already installs as a full-screen web app that lives on your Home
            Screen like any other: open it in Safari, tap Share, then{" "}
            <strong className="text-foreground/80">Add to Home Screen</strong>.
          </p>
          <Button asChild variant="secondary" className="h-auto py-2.5 touch:py-3 clip-corner-lg">
            <Link to="/">
              <Globe className="size-4 shrink-0" />
              Open {APP_NAME} in this browser
            </Link>
          </Button>
        </div>
      )}

      {caveat && artifacts.length > 0 && <p className="text-xs text-muted-foreground leading-relaxed">{caveat}</p>}
    </section>
  );
}

/** Placeholder cards while the relays are answering. */
function TargetSkeleton() {
  return (
    <section className="clip-corner-lg bg-background/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="size-5 shrink-0 animate-pulse rounded bg-muted-foreground/20" />
        <div className="h-4 w-24 animate-pulse rounded bg-muted-foreground/20" />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="h-14 animate-pulse clip-corner-lg bg-muted-foreground/10" />
        <div className="h-14 animate-pulse clip-corner-lg bg-muted-foreground/10" />
      </div>
    </section>
  );
}

/** One past version, collapsed. Its artifacts are already in hand. */
function OlderRelease({ release }: { release: Release }) {
  return (
    <details className="clip-corner-lg bg-background/30 px-4 py-3">
      <summary className="flex cursor-pointer items-center gap-2 font-mono text-sm text-muted-foreground marker:content-none hover:text-foreground">
        <span className="font-bold">{release.version}</span>
        {release.channel !== "main" && (
          <span className="font-mono text-[10px] lowercase tracking-wide text-primary/70">{release.channel}</span>
        )}
        <span className="ml-auto text-xs opacity-70">
          {new Date(release.createdAt * 1000).toLocaleDateString()}
        </span>
      </summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {release.artifacts
          .filter((artifact) => !isRepublishedPackage(artifact.filename))
          .map((artifact) => (
            <ArtifactButton key={artifact.hash || artifact.url} artifact={artifact} />
          ))}
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

  const releases = useReleases();
  // Newest STABLE leads, so a release candidate doesn't become everyone's download.
  const latest = useMemo(() => featuredRelease(releases.data ?? []), [releases.data]);
  const older = (releases.data ?? []).filter((release) => release !== latest);
  const byOs = useMemo(() => groupByOs(latest), [latest]);

  const platforms = useMemo(() => {
    const ordered = [...DOWNLOAD_PLATFORMS];
    ordered.sort((a, b) => Number(b.os === detected) - Number(a.os === detected));
    return ordered;
  }, [detected]);

  // On iOS the primary action is the web app; with no detection, the hero cues the list.
  const featured = platforms.find((platform) => platform.os === detected);
  const heroArtifact = featured ? byOs.get(featured.os)?.[0] : undefined;

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
        <section className="mx-auto flex min-h-[100svh] max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center safe-area-top">
          <ArmadaCrest size={130} />
          <div className="space-y-2.5">
            <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground sm:text-3xl">
              get {APP_NAME.toLowerCase()}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
              The same {APP_NAME} on every deck: desktop, phone, and this browser.
              Every build is published to Nostr and fetched by its hash, so what you
              download is exactly what was released.
            </p>
          </div>

          <div className="w-full max-w-sm">
            {heroArtifact && featured ? (
              <Button size="lg" asChild className="h-12 w-full clip-corner-lg text-base font-medium">
                <a href={heroArtifact.url} download={heroArtifact.filename}>
                  <Download className="size-5" />
                  Download for {featured.name}
                </a>
              </Button>
            ) : featured?.os === "ios" ? (
              <Button size="lg" asChild className="h-12 w-full clip-corner-lg text-base font-medium">
                <Link to="/">
                  <Globe className="size-5" />
                  Open {APP_NAME} in this browser
                </Link>
              </Button>
            ) : releases.isPending ? (
              <div className="h-12 w-full animate-pulse clip-corner-lg bg-muted-foreground/15" />
            ) : null}
            <button
              type="button"
              onClick={scrollToTargets}
              className="group mt-5 flex w-full flex-col items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              All platforms
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

        <section ref={targetsRef} className="mx-auto max-w-2xl scroll-mt-6 space-y-4 px-6 pb-12 pt-4">
          {releases.isPending ? (
            <>
              <TargetSkeleton />
              <TargetSkeleton />
              <TargetSkeleton />
            </>
          ) : latest ? (
            <>
              {platforms.map((platform) => (
                <TargetCard
                  key={platform.os}
                  platform={platform}
                  artifacts={byOs.get(platform.os) ?? []}
                  version={latest.version}
                  channel={latest.channel}
                  featured={platform.os === detected}
                />
              ))}

              {older.length > 0 && (
                <section className="space-y-2 pt-2">
                  <h2 className="font-mono text-sm lowercase tracking-tight text-muted-foreground">
                    earlier releases
                  </h2>
                  {older.map((release) => (
                    <OlderRelease key={release.id} release={release} />
                  ))}
                </section>
              )}

              <p className="text-xs text-muted-foreground/70 leading-relaxed">
                See{" "}
                <Link to="/changelog" className="text-primary hover:underline">
                  the changelog
                </Link>{" "}
                for what shipped in each version.
              </p>
            </>
          ) : (
            // No compiled-in fallback list; explain rather than render an empty page.
            <section className="clip-corner-lg bg-background/50 p-6 text-center space-y-3">
              <p className="font-mono text-sm lowercase tracking-tight text-foreground">
                no releases found
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed">
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
                <RefreshCw className={`size-4 ${releases.isFetching ? "animate-spin" : ""}`} />
                Try again
              </Button>
            </section>
          )}
        </section>

        {/* Sign-off: the landing's terminal prompt (`armada-caret` from the crest's keyframes). */}
        <section className="mx-auto flex min-h-[50svh] max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center safe-area-bottom">
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
