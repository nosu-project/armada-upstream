import { useQuery } from "@tanstack/react-query";
import { AppWindow, ArrowLeft, Download, ExternalLink, Globe, Laptop, Smartphone, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { AsciiSea } from "@/components/landing/AsciiSea";
import { Button } from "@/components/ui/button";
import {
  DOWNLOAD_TARGETS,
  type DownloadOs,
  type DownloadTarget,
  type DownloadsManifest,
  type ManifestName,
  detectCurrentOs,
  downloadUrl,
  formatBytes,
  manifestUrl,
} from "@/lib/downloads";
import { APP_NAME } from "@/lib/platform";

/**
 * The downloads deck: a headless page in the landing's visual language — the
 * crest and a mono heading over the {@link AsciiSea}, with the platform cards
 * floating on the water below. No command-bar header; the only chrome is a
 * ghost back arrow that scrolls away with the hero, the same way the landing
 * itself carries no bars.
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
  linux: "Mark an AppImage executable before running it: chmod +x Armada.AppImage",
};

/**
 * Where Android users can get the app without sideloading. External stores,
 * not CI-published files, which is why these live here rather than as assets
 * in `lib/downloads.ts`: the manifest/workflow test there asserts every asset
 * filename is something CI publishes.
 */
const ANDROID_STORES = [
  {
    label: "Google Play",
    hint: "Install from the Play Store",
    url: "https://play.google.com/store/apps/details?id=buzz.armada.app&hl=en-US",
  },
  {
    label: "Zapstore",
    hint: "The Nostr-native app store",
    url: "https://zapstore.dev/apps/buzz.armada.app",
  },
];

/** True when the user has asked the OS to keep motion to a minimum. */
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The version label and file sizes, fetched per platform family.
 *
 * Deliberately non-blocking: the download URLs are stable constants, so a
 * failed or slow fetch costs a label and nothing else. `retry: false` because
 * the only interesting failure is "CI hasn't published this platform yet",
 * which retrying cannot fix.
 */
function useManifest(name: ManifestName) {
  return useQuery({
    queryKey: ["downloads-manifest", name],
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await fetch(manifestUrl(name), { signal });
      if (!res.ok) throw new Error(`manifest ${name}: ${res.status}`);
      return (await res.json()) as DownloadsManifest;
    },
  });
}

function TargetCard({ target, manifest, featured }: {
  target: DownloadTarget;
  manifest?: DownloadsManifest;
  featured?: boolean;
}) {
  const Icon = OS_ICON[target.os];
  const caveat = OS_CAVEAT[target.os];

  return (
    // A borderless translucent panel, so the swell stays faintly visible
    // underneath instead of being walled off. The featured card is simply a
    // shade more solid.
    <section
      className={`clip-corner-lg p-4 space-y-3 ${featured ? "bg-background/60" : "bg-background/40"}`}
    >
      <header className="flex items-center gap-2">
        <Icon className={`size-5 shrink-0 ${featured ? "text-primary" : "text-muted-foreground"}`} />
        <h2 className="font-mono font-bold lowercase tracking-tight leading-tight">{target.name}</h2>
        {featured && (
          <span className="font-mono text-[10px] lowercase tracking-wide text-primary/80">your platform</span>
        )}
        {manifest?.version && (
          <span className="ml-auto font-mono text-xs text-muted-foreground shrink-0">v{manifest.version}</span>
        )}
      </header>

      {target.assets.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {target.assets.map((asset, i) => {
            const size = manifest?.files?.[asset.id]?.size;
            return (
              <Button
                key={asset.id}
                asChild
                variant={featured && i === 0 ? "default" : "secondary"}
                className="h-auto py-2.5 touch:py-3 justify-start text-left clip-corner-lg"
              >
                {/* `download` only binds same-origin — on armada.buzz it forces a
                    save and names the file even if the server's content type is
                    wrong. Cross-origin (the native shells) it is ignored and the
                    link opens normally, which is the desired behavior there. */}
                <a href={downloadUrl(asset.file)} download>
                  <Download className="size-4 shrink-0" />
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium leading-tight">
                      {asset.label}
                      {size ? <span className="font-normal opacity-70"> · {formatBytes(size)}</span> : null}
                    </span>
                    <span className="text-xs font-normal opacity-70 leading-tight whitespace-normal">{asset.hint}</span>
                  </span>
                </a>
              </Button>
            );
          })}
          {target.os === "android" &&
            ANDROID_STORES.map((store) => (
              <Button
                key={store.url}
                asChild
                variant="secondary"
                className="h-auto py-2.5 touch:py-3 justify-start text-left clip-corner-lg"
              >
                <a href={store.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4 shrink-0" />
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium leading-tight">{store.label}</span>
                    <span className="text-xs font-normal opacity-70 leading-tight whitespace-normal">{store.hint}</span>
                  </span>
                </a>
              </Button>
            ))}
        </div>
      ) : (
        // iOS: no App Store build is published yet, so tease it. The web app
        // is presented as a good install in its own right, not a stopgap:
        // Safari's Add to Home Screen gives a full-screen app on the Home
        // Screen today.
        <div className="space-y-2">
          <p className="font-mono text-xs lowercase tracking-wide text-primary/80">
            official app coming soon
          </p>
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

      {caveat && <p className="text-xs text-muted-foreground leading-relaxed">{caveat}</p>}
    </section>
  );
}

export function DownloadsPage() {
  const navigate = useNavigate();
  // The page's own scroll container: the sea reads its scrollTop imperatively,
  // so it is a ref handed down, never state.
  const scrollRef = useRef<HTMLElement>(null);
  const targetsRef = useRef<HTMLElement>(null);
  // Detected once: re-running per render can't change, and a featured card that
  // moved between renders would be worse than a wrong guess.
  const detected = useMemo(() => detectCurrentOs(), []);

  const desktop = useManifest("desktop");
  const android = useManifest("android");
  const manifestFor = (target: DownloadTarget) =>
    target.manifest === "android" ? android.data : target.manifest === "desktop" ? desktop.data : undefined;

  // The visitor's platform first, everything else in declaration order. An
  // unrecognized agent simply gets the flat list.
  const targets = useMemo(() => {
    const ordered = [...DOWNLOAD_TARGETS];
    ordered.sort((a, b) => Number(b.os === detected) - Number(a.os === detected));
    return ordered;
  }, [detected]);

  // The hero's one-click answer: the detected platform's primary asset. On iOS
  // (no installable build) the honest primary action is the web app itself, and
  // with no detection at all the hero just cues the list below.
  const featured = targets.find((t) => t.os === detected);
  const heroAsset = featured?.assets[0];

  const scrollToTargets = () => {
    targetsRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  };

  return (
    <main ref={scrollRef} className="relative flex-1 min-w-0 overflow-y-auto">
      {/* Viewport-locked sea, exactly as the landing mounts it: `sticky` pins
          it while `-mb-[100svh]` cancels its scroll height, so the content
          scrolls straight over the water. */}
      <div className="pointer-events-none sticky top-0 z-0 -mb-[100svh] h-[100svh]">
        <AsciiSea scrollRef={scrollRef} />
      </div>

      {/* The one piece of chrome: a way back that scrolls away with the hero
          rather than riding a bar across the page. */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Back"
        onClick={() => navigate(-1)}
        className="absolute left-2 top-2 z-20 size-9 touch:size-11 text-muted-foreground hover:text-foreground safe-area-top"
      >
        <ArrowLeft className="size-5" />
      </Button>

      <div className="relative z-10">
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <section className="mx-auto flex min-h-[100svh] max-w-xl flex-col items-center justify-center gap-8 px-6 py-16 text-center safe-area-top">
          <ArmadaCrest size={130} />
          <div className="space-y-2.5">
            <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground sm:text-3xl">
              get {APP_NAME.toLowerCase()}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
              The same {APP_NAME} on every deck: desktop, phone, and this browser.
              Every link points at the latest release and keeps working across versions,
              so you can bookmark or share it.
            </p>
          </div>

          <div className="w-full max-w-sm">
            {heroAsset && featured ? (
              <Button size="lg" asChild className="h-12 w-full clip-corner-lg text-base font-medium">
                <a href={downloadUrl(heroAsset.file)} download>
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
            ) : null}
            {/* Cue and scroll target are one control, the landing's pattern:
                the list below IS the answer. */}
            <button
              type="button"
              onClick={scrollToTargets}
              className="group mt-5 flex w-full flex-col items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              All platforms
              {/* U+2193 (↓) for the same reason the landing's cue is: WGL4
                  core, so every system font has a real glyph instead of tofu. */}
              <span
                aria-hidden="true"
                className="animate-[armada-bob_2.4s_ease-in-out_infinite] text-base leading-none text-[hsl(var(--accent2)/0.75)] group-hover:text-[hsl(var(--accent2))]"
              >
                &#8595;
              </span>
            </button>
          </div>
        </section>

        {/* ── Every platform ───────────────────────────────────────────── */}
        <section ref={targetsRef} className="mx-auto max-w-2xl scroll-mt-6 space-y-4 px-6 pb-12 pt-4">
          {targets.map((target) => (
            <TargetCard
              key={target.os}
              target={target}
              manifest={manifestFor(target)}
              featured={target.os === detected}
            />
          ))}

          <p className="text-xs text-muted-foreground/70 leading-relaxed">
            Older releases stay where they were published, each under its own versioned name, like{" "}
            <code className="text-foreground/60">Armada-v1.2.3.AppImage</code>. See{" "}
            <Link to="/changelog" className="text-primary hover:underline">
              the changelog
            </Link>{" "}
            for what shipped in each.
          </p>
        </section>

        {/* ── The sign-off ─────────────────────────────────────────────────
            The landing's terminal prompt, so this page ends where that one
            does. `armada-caret` comes from the crest's keyframes below. */}
        {/* Tall enough that the prompt floats clear of the gradient floor
            below, rather than sitting inside its darkest band. */}
        <section className="mx-auto flex min-h-[50svh] max-w-xl flex-col items-center justify-center px-6 py-16 text-center safe-area-bottom">
          <p className="font-mono text-xl text-[hsl(var(--primary))] sm:text-2xl">
            <span className="text-[hsl(var(--accent2,180_90%_55%))]">$ </span>
            anchors aweigh
            <span className="animate-[armada-caret_1s_step-end_infinite]">_</span>
          </p>
        </section>

        {/* The floor of the page, as on the landing: darken the last stretch
            of sea so reaching the bottom reads as arriving somewhere. */}
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
