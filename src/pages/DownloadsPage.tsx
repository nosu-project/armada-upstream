import { useQuery } from "@tanstack/react-query";
import { AppWindow, ArrowLeft, Download, Globe, Laptop, Smartphone, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";

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
  android: "Sideloading asks Android to allow installs from your browser. Zapstore and Google Play are the alternatives.",
  linux: "Mark an AppImage executable before running it: chmod +x Armada.AppImage",
};

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
    <section className={`clip-corner-lg p-4 space-y-3 ${featured ? "bg-chrome ring-1 ring-primary/30" : "bg-muted/30"}`}>
      <header className="flex items-center gap-2">
        <Icon className={`size-5 shrink-0 ${featured ? "text-primary" : "text-muted-foreground"}`} />
        <h2 className="font-semibold leading-tight">{target.name}</h2>
        {featured && <span className="text-[10px] uppercase tracking-wide text-primary/80">Detected</span>}
        {manifest?.version && (
          <span className="ml-auto text-xs text-muted-foreground shrink-0">v{manifest.version}</span>
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
                className="h-auto py-2.5 touch:py-3 justify-start text-left"
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
        </div>
      ) : (
        // iOS: no build is published, so the honest answer is the web app.
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            There's no App Store build yet. {APP_NAME} runs as a full-screen web app instead — open it in Safari,
            tap Share, then <strong className="text-foreground/80">Add to Home Screen</strong>.
          </p>
          <Button asChild variant="secondary" className="h-auto py-2.5 touch:py-3">
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

  return (
    <main className="flex-1 min-w-0 flex flex-col safe-area-top">
      {/* Header — a detached floating command bar matching the settings page chrome. */}
      <header className="relative h-12 touch:h-14 mx-2 mt-3 w-[calc(100%-1rem)] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="Back" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="font-semibold truncate leading-tight">Downloads</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto safe-area-bottom">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 pb-16 pt-3 space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {APP_NAME} on your desktop and your phone. Every link here points at the latest release and keeps
            working across versions, so you can bookmark or share it.
          </p>

          {targets.map((target) => (
            <TargetCard
              key={target.os}
              target={target}
              manifest={manifestFor(target)}
              featured={target.os === detected}
            />
          ))}

          <p className="text-xs text-muted-foreground/70 leading-relaxed">
            Older releases stay where they were published, each under its own version — the same names with the
            version in them, like <code className="text-foreground/60">Armada-v1.2.3.AppImage</code>. See{" "}
            <Link to="/changelog" className="text-primary hover:underline">
              the changelog
            </Link>{" "}
            for what shipped in each.
          </p>
        </div>
      </div>
    </main>
  );
}
