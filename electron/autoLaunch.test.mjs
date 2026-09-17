import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { getLaunchSettings, setLaunchSettings } = require("./autoLaunch.js");

function makeFs() {
  const files = new Map();
  return {
    files,
    fsImpl: {
      mkdirSync: vi.fn(),
      readFileSync: vi.fn((file) => {
        if (!files.has(file)) throw new Error("missing");
        return files.get(file);
      }),
      writeFileSync: vi.fn((file, value) => files.set(file, value)),
    },
  };
}

function makeApp(initial = { openAtLogin: false }) {
  let state = { ...initial };
  return {
    getLoginItemSettings: vi.fn(() => state),
    setLoginItemSettings: vi.fn((options) => {
      state = { openAtLogin: Boolean(options.openAtLogin) };
    }),
  };
}

describe("desktop launch-at-login", () => {
  it("reports unsupported on platforms without the API", () => {
    const { fsImpl } = makeFs();
    expect(
      getLaunchSettings({ platform: "freebsd", appImpl: makeApp(), userDataPath: "/p", fsImpl }),
    ).toEqual({ supported: false, openAtLogin: false, openAsHidden: false });
  });

  it("reports unsupported when the shell exposes no login-item API", () => {
    const { fsImpl } = makeFs();
    expect(
      getLaunchSettings({ platform: "linux", appImpl: {}, userDataPath: "/p", fsImpl }),
    ).toEqual({ supported: false, openAtLogin: false, openAsHidden: false });
  });

  it("registers the app and mirrors the hidden flag as a launch arg on Linux", () => {
    const { fsImpl } = makeFs();
    const appImpl = makeApp();
    const result = setLaunchSettings(
      { openAtLogin: true, openAsHidden: true },
      { platform: "linux", appImpl, userDataPath: "/profile", fsImpl, env: {} },
    );
    expect(appImpl.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: ["--hidden"],
    });
    expect(result).toEqual({ supported: true, openAtLogin: true, openAsHidden: true });
  });

  it("uses $APPIMAGE as the relaunch path under an AppImage", () => {
    const { fsImpl } = makeFs();
    const appImpl = makeApp();
    setLaunchSettings(
      { openAtLogin: true, openAsHidden: false },
      {
        platform: "linux",
        appImpl,
        userDataPath: "/profile",
        fsImpl,
        env: { APPIMAGE: "/home/u/Armada.AppImage" },
      },
    );
    expect(appImpl.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: "/home/u/Armada.AppImage",
      args: [],
    });
  });

  it("uses the native openAsHidden option on macOS", () => {
    const { fsImpl } = makeFs();
    const appImpl = makeApp();
    setLaunchSettings(
      { openAtLogin: true, openAsHidden: true },
      { platform: "darwin", appImpl, userDataPath: "/profile", fsImpl, env: {} },
    );
    expect(appImpl.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      openAsHidden: true,
    });
  });

  it("round-trips the hidden preference through userData", () => {
    const { fsImpl } = makeFs();
    const appImpl = makeApp();
    const opts = { platform: "linux", appImpl, userDataPath: "/profile", fsImpl, env: {} };
    setLaunchSettings({ openAtLogin: true, openAsHidden: true }, opts);
    expect(
      getLaunchSettings({ platform: "linux", appImpl, userDataPath: "/profile", fsImpl }),
    ).toEqual({ supported: true, openAtLogin: true, openAsHidden: true });

    setLaunchSettings({ openAtLogin: false, openAsHidden: false }, opts);
    expect(
      getLaunchSettings({ platform: "linux", appImpl, userDataPath: "/profile", fsImpl }),
    ).toEqual({ supported: true, openAtLogin: false, openAsHidden: false });
  });
});
