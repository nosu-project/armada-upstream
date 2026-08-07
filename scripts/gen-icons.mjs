#!/usr/bin/env node
// Fan the single master mark (public/logo.svg) out to every platform's app
// icon / splash raster. Run after changing the mark:
//
//   npm run gen:icons
//
// Requires `inkscape` (SVG -> PNG) and ImageMagick `magick` (compose/mask) on
// PATH — both are provided by the CI image; on a dev box install them from your
// package manager. No sharp / @capacitor/assets dependency.
//
// The mark itself is frameless and transparent; icons that need an opaque
// backdrop are composited onto the brand background (#100b15) here, so the one
// SVG stays the source of truth for geometry and color.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BG = "#100b15"; // brand background (matches manifest / capacitor / android colors)
const LOGO = join(ROOT, "public", "logo.svg");
const FAVICON_SVG = join(ROOT, "public", "favicon.svg");
const OG_SVG = join(ROOT, "public", "og.svg");

const TMP = mkdtempSync(join(tmpdir(), "armada-icons-"));
const MASTER = join(TMP, "master.png"); // high-res transparent render of the mark

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
const inkscape = (svg, w, h, out) => sh("inkscape", [svg, "-w", String(w), "-h", String(h), "-o", out]);

/** Compose the mark centered at `frac` of an SxS canvas. */
function icon(out, size, { frac = 0.72, bg = BG, round = false, flatten = false } = {}) {
  const m = Math.round(size * frac);
  const c = size / 2;
  const args = ["-size", `${size}x${size}`, bg ? `xc:${bg}` : "xc:none",
    "(", MASTER, "-resize", `${m}x${m}`, ")", "-gravity", "center", "-composite"];
  if (round) {
    args.push("(", "-size", `${size}x${size}`, "xc:black", "-fill", "white",
      "-draw", `circle ${c},${c} ${c},0`, ")", "-alpha", "off", "-compose", "CopyOpacity", "-composite");
  }
  if (flatten) args.push("-background", bg || BG, "-alpha", "remove", "-alpha", "off");
  mkdirSync(dirname(out), { recursive: true });
  sh("magick", [...args, out]);
  console.log("  " + out.replace(ROOT + "/", ""));
}

// Android density buckets -> px, for a given base dp size.
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const androidRes = (name) => join(ROOT, "android/app/src/main/res", name);

console.log("Rendering master mark…");
inkscape(LOGO, 2048, 2048, MASTER);

console.log("public/ (PWA + favicons):");
icon(join(ROOT, "public/logo-192.png"), 192, { frac: 0.72 });
icon(join(ROOT, "public/logo-512.png"), 512, { frac: 0.72 });
icon(join(ROOT, "public/maskable-192.png"), 192, { frac: 0.56 });
icon(join(ROOT, "public/maskable-512.png"), 512, { frac: 0.56 });
icon(join(ROOT, "public/apple-touch-icon.png"), 180, { frac: 0.72 });
// favicon.png / og.png carry their own composition (chip / wordmark) — render direct.
inkscape(FAVICON_SVG, 256, 256, join(ROOT, "public/favicon.png"));
console.log("  public/favicon.png");
inkscape(OG_SVG, 1200, 630, join(ROOT, "public/og.png"));
console.log("  public/og.png");

console.log("android/ (launcher + splash):");
for (const [d, k] of Object.entries(DENSITIES)) {
  icon(androidRes(`mipmap-${d}/ic_launcher.png`), Math.round(48 * k), { frac: 0.70 });
  icon(androidRes(`mipmap-${d}/ic_launcher_round.png`), Math.round(48 * k), { frac: 0.70, round: true });
  icon(androidRes(`mipmap-${d}/ic_launcher_foreground.png`), Math.round(108 * k), { frac: 0.42, bg: null });
  icon(androidRes(`drawable-${d}/splash_logo.png`), Math.round(160 * k), { frac: 0.62, bg: null });
}

console.log("ios/ (AppIcon + splash):");
const IOS = join(ROOT, "ios/App/App/Assets.xcassets");
icon(join(IOS, "AppIcon.appiconset/AppIcon-512@2x.png"), 1024, { frac: 0.66, flatten: true });
for (const s of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
  icon(join(IOS, `Splash.imageset/${s}`), 2732, { frac: 0.16 });
}

console.log("electron/:");
icon(join(ROOT, "electron/build/icon.png"), 1024, { frac: 0.72 });
// A transparent, full-canvas raster for the small Linux tray slot. The normal
// app icon has an opaque near-black background and generous launcher padding,
// which makes it look like an empty square when reduced to ~22 px.
inkscape(LOGO, 64, 64, join(ROOT, "electron/build/tray.png"));
console.log("  electron/build/tray.png");

console.log("Done.");
