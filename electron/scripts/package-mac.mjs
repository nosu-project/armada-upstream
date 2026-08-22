// Cross-build the macOS .app bundles from any OS (CI runs it on Linux).
//
// electron-builder refuses to produce mac targets off darwin, and ngit-ci has
// no macOS runner (act runs Linux containers) — but the .app itself needs no
// Apple tooling to assemble: it is the prebuilt Electron darwin binary with our
// app.asar dropped into Contents/Resources and Info.plist rewritten, which is
// exactly what @electron/packager does.
//
// The asar is REUSED from the electron-builder run rather than built a second
// time, so the mac bundles ship byte-identical app code to the Linux/Windows
// installers and there is no second `files` list to drift. The only native
// integration in that asar, uiohook-napi, publishes N-API prebuilds for macOS,
// Windows and Linux together; electron-builder keeps those prebuilds unpacked
// and does not rebuild them. venmic is excluded at runtime outside Linux.
//
// The remaining Apple-only pieces are deliberately NOT faked here:
//   - signing: an arm64 Mac refuses to exec an unsigned binary, so CI ad-hoc
//     signs the output with rcodesign (see .ngit/act/workflows/release.yml).
//   - .dmg: the disk-image format needs HFS+ tooling; CI ships .zip, which is
//     the same format Electron's own mac autoupdater feeds on.
//
// Usage (from electron/): node scripts/package-mac.mjs [--arch x64,arm64]

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packager } from "@electron/packager";
import png2icons from "png2icons";
import plist from "plist";
import { load as loadYaml } from "js-yaml";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const archArg = process.argv.find((a) => a.startsWith("--arch="));
const arches = (archArg ? archArg.slice("--arch=".length) : "x64,arm64").split(",");

// electron-builder.yml stays the single source of truth for the app's identity
// and its Info.plist additions (the TCC usage strings macOS kills the process
// without), so the cross-build can't drift from the mac build a Mac would make.
const builderConfig = loadYaml(fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
const pkg = require(path.join(root, "package.json"));
const electronVersion = require(path.join(root, "node_modules/electron/package.json")).version;

// The app.asar electron-builder already staged for the Linux target.
const asar = path.join(root, "release/linux-unpacked/resources/app.asar");
if (!fs.existsSync(asar)) {
  throw new Error(`no ${asar} — run electron-builder --linux first`);
}
const unpackedUiohook = path.join(
  root,
  "release/linux-unpacked/resources/app.asar.unpacked/node_modules/uiohook-napi",
);
if (!fs.existsSync(unpackedUiohook)) {
  throw new Error(`no ${unpackedUiohook} — uiohook-napi was not staged for macOS`);
}

// electron-builder derives .icns from build/icon.png; packager wants the .icns.
const icns = path.join(root, "release/mac-icon.icns");
fs.mkdirSync(path.dirname(icns), { recursive: true });
fs.writeFileSync(
  icns,
  png2icons.createICNS(fs.readFileSync(path.join(root, "build/icon.png")), png2icons.BILINEAR, 0),
);

// Cleared, not overwritten: CI reuses its work directory, and a bundle left
// behind by an earlier run for an arch this one doesn't build would still be
// picked up by the sign-and-zip loop that globs this directory.
const out = path.join(root, "release/mac");
fs.rmSync(out, { recursive: true, force: true });

const built = [];

for (const arch of arches) {
  const [appPath] = await packager({
    dir: root,
    // Nothing is copied from `dir` (prebuiltAsar replaces the copy step); it is
    // read for the package.json name/version only.
    prebuiltAsar: asar,
    out,
    overwrite: true,
    platform: "darwin",
    arch,
    electronVersion,
    appBundleId: builderConfig.appId,
    appVersion: pkg.version,
    appCopyright: builderConfig.copyright,
    appCategoryType: builderConfig.mac?.category,
    icon: icns,
    extendInfo: builderConfig.mac?.extendInfo ?? {},
  });
  const macApp = path.join(appPath, `${pkg.productName}.app`);
  // prebuiltAsar copies app.asar, but @electron/packager does not know about
  // electron-builder's sibling app.asar.unpacked directory. Copy the complete
  // package so Node can resolve its JS shim and select the matching Darwin N-API
  // prebuild at runtime. The Linux-only venmic payload is intentionally absent.
  fs.cpSync(
    unpackedUiohook,
    path.join(
      macApp,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "uiohook-napi",
    ),
    { recursive: true },
  );
  const nativeHook = path.join(
    macApp,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "uiohook-napi",
    "prebuilds",
    `darwin-${arch}`,
    "uiohook-napi.node",
  );
  if (!fs.existsSync(nativeHook)) {
    throw new Error(`no ${nativeHook} — the ${arch} global-shortcut prebuild is missing`);
  }
  const venmic = path.join(
    macApp,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "@vencord",
    "venmic",
  );
  if (fs.existsSync(venmic)) {
    throw new Error(`Linux-only venmic unexpectedly shipped in ${macApp}`);
  }

  const infoPath = path.join(macApp, "Contents", "Info.plist");
  const info = plist.parse(fs.readFileSync(infoPath, "utf8"));
  for (const key of [
    "NSMicrophoneUsageDescription",
    "NSCameraUsageDescription",
    "NSAudioCaptureUsageDescription",
  ]) {
    if (typeof info[key] !== "string" || !info[key].trim()) {
      throw new Error(`${infoPath} is missing ${key}`);
    }
  }

  // These Linux-cross-built archives are only ad-hoc signed in CI. They are
  // intentionally not an electron-updater target: safely replacing a macOS
  // app requires a consistently Developer ID-signed update. Native mac builds
  // made with electron-builder do not contain this marker and may use the
  // signed latest-mac.yml feed.
  fs.writeFileSync(
    path.join(macApp, "Contents", "Resources", "armada-no-self-update"),
    "Cross-built ad-hoc archive; updates are installed manually.\n",
  );
  built.push(appPath);
  console.log(`built ${appPath}`);
}

// Sanity-check the architecture of what we just assembled by reading the
// Mach-O header: a wrong or fallback-arch download produces a bundle that dies
// on launch with no diagnostic, on a machine this build cannot test from.
const CPU_TYPES = { 0x01000007: "x64", 0x0100000c: "arm64" };

for (const appPath of built) {
  const app = fs.readdirSync(appPath).find((e) => e.endsWith(".app"));
  const exe = path.join(appPath, app, "Contents/MacOS", pkg.productName);
  const header = Buffer.alloc(8);
  const fd = fs.openSync(exe, "r");
  fs.readSync(fd, header, 0, 8, 0);
  fs.closeSync(fd);
  if (header.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`${exe} is not a 64-bit Mach-O binary`);
  }
  const found = CPU_TYPES[header.readUInt32LE(4)];
  const want = path.basename(appPath).split("-").pop();
  if (found !== want) {
    throw new Error(`${exe} is ${found ?? "an unknown arch"}, expected ${want}`);
  }
  console.log(`${path.basename(appPath)}: Mach-O ${found}`);
}
