import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  DESKTOP_FILE,
  DESKTOP_ID,
  ENTRY_FIELDS,
  ICON_SIZES,
  MARKER_KEY,
  appImageSelfPath,
  buildDesktopEntry,
  desktopExecArg,
  integrateAppImage,
  isGeneratedEntry,
  xdgDataDirs,
  xdgDataHome,
} = require("./desktopIntegration.js");

const HERE = resolve(process.cwd(), "electron");

/** A throwaway XDG data root, plus the env that points the module at it. */
function sandbox({ appImage = "/home/u/Downloads/Armada.AppImage", extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "armada-desktop-"));
  const dataHome = join(root, "data");
  const dataDirs = join(root, "system");
  mkdirSync(join(dataHome, "applications"), { recursive: true });
  mkdirSync(join(dataDirs, "applications"), { recursive: true });
  return {
    root,
    dataHome,
    dataDirs,
    appImage,
    entryFile: join(dataHome, "applications", DESKTOP_FILE),
    env: {
      APPIMAGE: appImage,
      XDG_DATA_HOME: dataHome,
      XDG_DATA_DIRS: dataDirs,
      ...extra,
    },
  };
}

const run = (box, options = {}) =>
  integrateAppImage({ env: box.env, platform: "linux", version: "9.9.9", ...options });

describe("XDG paths", () => {
  it("falls back to the spec defaults", () => {
    expect(xdgDataHome({}, "/home/u")).toBe("/home/u/.local/share");
    // A relative XDG_DATA_HOME is invalid per the basedir spec.
    expect(xdgDataHome({ XDG_DATA_HOME: "share" }, "/home/u")).toBe("/home/u/.local/share");
    expect(xdgDataHome({ XDG_DATA_HOME: "/custom" }, "/home/u")).toBe("/custom");
    expect(xdgDataDirs({})).toEqual(["/usr/local/share", "/usr/share"]);
    expect(xdgDataDirs({ XDG_DATA_DIRS: "/a:relative:/b" })).toEqual(["/a", "/b"]);
  });
});

describe("when self-integration applies", () => {
  it("requires Linux, $APPIMAGE, and no opt-out", () => {
    const env = { APPIMAGE: "/opt/Armada.AppImage" };
    expect(appImageSelfPath({ env, platform: "linux" })).toBe("/opt/Armada.AppImage");
    expect(appImageSelfPath({ env, platform: "darwin" })).toBe(null);
    expect(appImageSelfPath({ env, platform: "win32" })).toBe(null);
    // deb, Flatpak and `npm start` never set it.
    expect(appImageSelfPath({ env: {}, platform: "linux" })).toBe(null);
    expect(appImageSelfPath({ env: { APPIMAGE: "Armada.AppImage" }, platform: "linux" })).toBe(null);
    expect(
      appImageSelfPath({
        env: { ...env, ARMADA_NO_DESKTOP_INTEGRATION: "1" },
        platform: "linux",
      }),
    ).toBe(null);
  });

  it("writes nothing at all when it does not apply", async () => {
    const box = sandbox();
    const result = await integrateAppImage({ env: {}, platform: "linux" });
    expect(result).toEqual({ integrated: false, reason: "not-an-appimage" });
    expect(() => readFileSync(box.entryFile)).toThrow();
  });
});

describe("the generated entry", () => {
  it("carries the window-association fields", () => {
    const entry = buildDesktopEntry({ appImagePath: "/opt/Armada.AppImage", version: "1.2.3" });
    expect(entry.startsWith("[Desktop Entry]\n")).toBe(true);
    expect(entry).toContain("Name=Armada");
    // The whole point: WM_CLASS is app.setDesktopName() minus .desktop, so the
    // shell can only name the window "Armada" if these match.
    expect(entry).toContain(`StartupWMClass=${DESKTOP_ID}`);
    expect(entry).toContain(`Icon=${DESKTOP_ID}`);
    expect(entry).toContain("Type=Application");
    expect(entry).toContain(`${MARKER_KEY}=armada-1.2.3`);
    expect(isGeneratedEntry(entry)).toBe(true);
  });

  it("keeps --no-sandbox, which the AppImage cannot run without", () => {
    const entry = buildDesktopEntry({ appImagePath: "/opt/Armada.AppImage" });
    expect(entry).toContain('Exec="/opt/Armada.AppImage" --no-sandbox %U');
  });

  it("quotes and escapes the AppImage path", () => {
    expect(desktopExecArg("/home/u/My Apps/Armada.AppImage")).toBe('"/home/u/My Apps/Armada.AppImage"');
    expect(desktopExecArg('/tmp/a"b$c`d\\e')).toBe('"/tmp/a\\"b\\$c\\`d\\\\e"');
    // A newline in the path cannot break out into a new key=value line.
    const entry = buildDesktopEntry({ appImagePath: "/tmp/a\nExec=/usr/bin/evil" });
    expect(entry.split("\n").filter((line) => line.startsWith("Exec="))).toHaveLength(1);
  });

  it("matches the entry electron-builder ships for deb and AppImage", () => {
    const config = parseYaml(readFileSync(join(HERE, "electron-builder.yml"), "utf8"));
    const packaged = config.linux.desktop.entry;
    expect(packaged.Name).toBe(ENTRY_FIELDS.Name);
    expect(packaged.Comment).toBe(ENTRY_FIELDS.Comment);
    expect(packaged.Categories).toBe(ENTRY_FIELDS.Categories);
    // electron-builder derives the file name and StartupWMClass from
    // package.json's desktopName; it has to stay the id this module writes.
    const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
    expect(pkg.desktopName).toBe(DESKTOP_FILE);
    expect(config.linux.syncDesktopName).toBe(true);
  });

  it("is packaged inside the asar, with the icon it installs", () => {
    const config = parseYaml(readFileSync(join(HERE, "electron-builder.yml"), "utf8"));
    // Unlisted, the require fails inside the asar and the shell cannot boot;
    // an unlisted icon file is a silent fallback to no launcher art at all.
    expect(config.files).toContain("desktopIntegration.js");
    expect(config.files).toContain("build/linux-icon.png");
    expect(config.linux.icon).toBe("build/linux-icon.png");
  });
});

describe("installing", () => {
  it("writes the entry and every hicolor size", async () => {
    const box = sandbox();
    const result = await run(box, { renderIcon: (size) => Buffer.from(`png-${size}`) });

    expect(result.reason).toBe("written");
    expect(readFileSync(box.entryFile, "utf8")).toContain("Name=Armada");
    for (const size of ICON_SIZES) {
      const icon = join(box.dataHome, "icons", "hicolor", `${size}x${size}`, "apps", `${DESKTOP_ID}.png`);
      expect(readFileSync(icon, "utf8")).toBe(`png-${size}`);
    }
  });

  it("is a no-op on the next launch", async () => {
    const box = sandbox();
    const renderIcon = (size) => Buffer.from(`png-${size}`);
    await run(box, { renderIcon });
    const again = await run(box, { renderIcon });
    expect(again).toMatchObject({ integrated: true, reason: "unchanged", files: [] });
  });

  it("rewrites its own entry when the AppImage moves", async () => {
    const box = sandbox();
    await run(box);
    const moved = { ...box, env: { ...box.env, APPIMAGE: "/opt/armada/Armada.AppImage" } };
    const result = await run(moved);
    expect(result.reason).toBe("written");
    expect(readFileSync(box.entryFile, "utf8")).toContain('Exec="/opt/armada/Armada.AppImage"');
  });

  it("still works when no icon renderer is supplied", async () => {
    const box = sandbox();
    const result = await run(box);
    expect(result).toMatchObject({ integrated: true, reason: "written" });
    expect(result.files).toEqual([box.entryFile]);
  });

  it("survives a data home it cannot write", async () => {
    const box = sandbox();
    // A plain file where the data home should be: every write below it fails.
    const blocked = join(box.root, "blocked");
    writeFileSync(blocked, "");
    const result = await run({ ...box, env: { ...box.env, XDG_DATA_HOME: blocked } });
    expect(result.integrated).toBe(false);
    expect(result.reason).toBe("error");
  });
});

describe("standing down", () => {
  it("leaves a system-wide entry (deb) alone", async () => {
    const box = sandbox();
    writeFileSync(join(box.dataDirs, "applications", DESKTOP_FILE), "[Desktop Entry]\nName=Armada\n");
    expect(await run(box)).toEqual({ integrated: false, reason: "system-entry" });
    expect(() => readFileSync(box.entryFile)).toThrow();
  });

  it("never clobbers an entry it did not write", async () => {
    const box = sandbox();
    const handWritten = "[Desktop Entry]\nName=My Armada\nExec=/somewhere/else %U\n";
    writeFileSync(box.entryFile, handWritten);
    expect(await run(box)).toEqual({ integrated: false, reason: "foreign-entry" });
    expect(readFileSync(box.entryFile, "utf8")).toBe(handWritten);
  });

  it("defers to AppImageLauncher's entry for the same file", async () => {
    const box = sandbox();
    writeFileSync(
      join(box.dataHome, "applications", "appimagekit_9f3-Armada.desktop"),
      `[Desktop Entry]\nName=Armada\nExec="${box.appImage}" %U\n`,
    );
    expect(await run(box)).toEqual({ integrated: false, reason: "foreign-entry" });
    expect(() => readFileSync(box.entryFile)).toThrow();
  });

  it("ignores unrelated entries in the same directory", async () => {
    const box = sandbox();
    writeFileSync(
      join(box.dataHome, "applications", "other.desktop"),
      "[Desktop Entry]\nName=Other\nExec=/home/u/Downloads/Other.AppImage %U\n",
    );
    expect((await run(box)).reason).toBe("written");
  });
});
