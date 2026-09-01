import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  APP_COMMAND,
  PROGRESS_STATUS,
  SPAWN_FLAGS_LATEST_VERSION,
  installFlatpakUpdate,
  parseProgress,
  plannedFlatpakUpdate,
  restartIntoLatest,
} = require("./flatpakUpdate.js");

/** Newest-first numeric compare, the contract `compareVersions` satisfies. */
function compareVersions(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function update(overrides = {}) {
  return { version: "1.3.0", tag: "v1.3.0", ...overrides };
}

/** An `a{sv}` entry as dbus-next delivers it: wrapped in a Variant-shaped object. */
function variant(signature, value) {
  return { signature, value };
}

/**
 * A fake session bus carrying the two objects the module talks to.
 *
 * The monitor is an EventEmitter because dbus-next interfaces are; `behave`
 * scripts what Update() does — usually emit Progress signals, which is also
 * where the signal-before-method-reply race is modelled (the portal emits from
 * a worker thread, so nothing orders the two).
 */
function fakeBus({ onUpdate, onSpawn } = {}) {
  const monitor = new EventEmitter();
  const state = { closed: 0, updates: [], spawns: [] };
  monitor.Update = async (parentWindow, options) => {
    state.updates.push({ parentWindow, options });
    if (onUpdate) return onUpdate(monitor);
  };
  monitor.Close = async () => {
    state.closed += 1;
  };

  const portal = {
    CreateUpdateMonitor: async () =>
      "/org/freedesktop/portal/Flatpak/update_monitor/1_23/t",
    Spawn: async (...args) => {
      state.spawns.push(args);
      if (onSpawn) return onSpawn(...args);
      return 4242;
    },
  };

  const bus = {
    async getProxyObject(name, path) {
      expect(name).toBe("org.freedesktop.portal.Flatpak");
      if (path === "/org/freedesktop/portal/Flatpak") {
        return { getInterface: () => portal };
      }
      return { getInterface: () => monitor };
    },
  };
  return { bus, monitor, state };
}

describe("plannedFlatpakUpdate", () => {
  it("offers a strictly newer version", () => {
    expect(plannedFlatpakUpdate(update(), "1.2.0", { compareVersions })?.version).toBe("1.3.0");
  });

  it("declines the same or an older version, like allowDowngrade=false", () => {
    expect(plannedFlatpakUpdate(update(), "1.3.0", { compareVersions })).toBeNull();
    expect(plannedFlatpakUpdate(update(), "1.4.0", { compareVersions })).toBeNull();
  });

  it("declines when nothing resolved", () => {
    expect(plannedFlatpakUpdate(undefined, "1.2.0", { compareVersions })).toBeNull();
    expect(plannedFlatpakUpdate(null, "1.2.0", { compareVersions })).toBeNull();
  });
});

describe("parseProgress", () => {
  it("unwraps the Variant-shaped a{sv} entries", () => {
    expect(
      parseProgress({
        status: variant("u", PROGRESS_STATUS.FAILED),
        progress: variant("u", 40),
        error: variant("s", "org.freedesktop.DBus.Error.Failed"),
        error_message: variant("s", "no space left"),
      }),
    ).toEqual({
      status: PROGRESS_STATUS.FAILED,
      progress: 40,
      error: "org.freedesktop.DBus.Error.Failed",
      errorMessage: "no space left",
    });
  });

  it("treats a signal with no status as a running one", () => {
    // The portal only promises a non-zero status on the FINAL signal; the
    // intermediate ones may carry only op/progress counters.
    expect(parseProgress({ progress: variant("u", 10) }).status).toBe(PROGRESS_STATUS.RUNNING);
    expect(parseProgress({}).status).toBe(PROGRESS_STATUS.RUNNING);
  });
});

describe("installFlatpakUpdate", () => {
  it("resolves installed on a DONE progress and closes the monitor", async () => {
    const { bus, state } = fakeBus({
      onUpdate: (monitor) => {
        monitor.emit("Progress", { status: variant("u", PROGRESS_STATUS.RUNNING), progress: variant("u", 50) });
        monitor.emit("Progress", { status: variant("u", PROGRESS_STATUS.DONE) });
      },
    });
    const seen = [];
    const outcome = await installFlatpakUpdate({ bus, onProgress: (p) => seen.push(p) });
    expect(outcome).toEqual({ result: "installed" });
    expect(state.updates).toEqual([{ parentWindow: "", options: {} }]);
    // Close() is unconditional: it is also what cancels an install in flight,
    // so it must run on every exit path.
    expect(state.closed).toBe(1);
    expect(seen.map((p) => p.status)).toEqual([PROGRESS_STATUS.RUNNING, PROGRESS_STATUS.DONE]);
  });

  it("resolves nothing on an EMPTY progress", async () => {
    // A real case, not an error: the release event and the OSTree repository
    // propagate independently, so the event can lead the remote.
    const { bus, state } = fakeBus({
      onUpdate: (monitor) => monitor.emit("Progress", { status: variant("u", PROGRESS_STATUS.EMPTY) }),
    });
    expect(await installFlatpakUpdate({ bus })).toEqual({ result: "nothing" });
    expect(state.closed).toBe(1);
  });

  it("rejects with the portal's message on a FAILED progress", async () => {
    const { bus, state } = fakeBus({
      onUpdate: (monitor) =>
        monitor.emit("Progress", {
          status: variant("u", PROGRESS_STATUS.FAILED),
          error_message: variant("s", "GPG signatures found, but none are in trusted keyring"),
        }),
    });
    await expect(installFlatpakUpdate({ bus })).rejects.toThrow(/trusted keyring/);
    expect(state.closed).toBe(1);
  });

  it("survives a Progress emitted before Update() replies", async () => {
    // The portal emits Progress from a worker thread, so the terminal signal
    // can beat the method reply. The handler is subscribed before Update() is
    // called, and this is the test that keeps it that way.
    const { bus } = fakeBus({
      onUpdate: async (monitor) => {
        monitor.emit("Progress", { status: variant("u", PROGRESS_STATUS.DONE) });
        await new Promise((r) => setTimeout(r, 10));
      },
    });
    expect(await installFlatpakUpdate({ bus })).toEqual({ result: "installed" });
  });

  it("propagates Update() refusing, and still closes the monitor", async () => {
    // NotSupported is the portal refusing a version that requires new
    // permissions — installable with system tools, but not from in here.
    const { bus, state } = fakeBus({
      onUpdate: () => {
        throw new Error("org.freedesktop.DBus.Error.NotSupported: new permissions");
      },
    });
    await expect(installFlatpakUpdate({ bus })).rejects.toThrow(/NotSupported/);
    expect(state.closed).toBe(1);
  });

  it("times out an install that never finishes, closing the monitor to cancel it", async () => {
    const { bus, state } = fakeBus({
      onUpdate: (monitor) =>
        monitor.emit("Progress", { status: variant("u", PROGRESS_STATUS.RUNNING) }),
    });
    await expect(installFlatpakUpdate({ bus, timeoutMs: 25 })).rejects.toThrow(/timed out/);
    // Per the portal contract Close() cancels an installation still in flight,
    // which is what makes the timeout a real bound rather than an abandonment.
    expect(state.closed).toBe(1);
  });
});

describe("restartIntoLatest", () => {
  it("spawns the app command with the latest-version flag", async () => {
    const { bus, state } = fakeBus();
    const pid = await restartIntoLatest({ bus });
    expect(pid).toBe(4242);
    const [cwd, argv, fds, envs, flags, options] = state.spawns[0];
    // `ay` arguments are read with g_variant_get_bytestring, which answers
    // empty for an array missing its NUL terminator.
    expect(Buffer.from(cwd).toString()).toBe("/\0");
    expect(argv.map((a) => Buffer.from(a).toString())).toEqual([`${APP_COMMAND}\0`]);
    // /app/bin/armada is the manifest's `command`, i.e. the zypak wrapper —
    // spawning the Electron binary directly would skip it.
    expect(APP_COMMAND).toBe("/app/bin/armada");
    expect(flags).toBe(SPAWN_FLAGS_LATEST_VERSION);
    expect(SPAWN_FLAGS_LATEST_VERSION).toBe(2);
    expect(fds).toEqual({});
    expect(envs).toEqual({});
    expect(options).toEqual({});
  });
});

describe("the sandbox boundary this edition keeps", () => {
  // The portal path costs the sandbox nothing: org.freedesktop.portal.* is
  // reachable from every Flatpak by design. These assertions are what keeps
  // the two escapes — host-command execution and a GUI-installer handoff —
  // from coming back quietly.
  const source = readFileSync(resolvePath(process.cwd(), "electron/flatpakUpdate.js"), "utf8");
  const manifest = readFileSync(
    resolvePath(process.cwd(), "electron/flatpak/buzz.armada.app.yml"),
    "utf8",
  );

  /**
   * The module with its comments removed.
   *
   * Asserted against the CODE, because the prose is where `flatpak-spawn --host`
   * is named — the docblock exists precisely to record that the escape was
   * considered and refused, and a search over the raw file would be failed by
   * its own explanation. Block comments plus whole-line `//` ones is the whole
   * grammar here.
   */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("talks only to the update portal, never to a process", () => {
    expect(code).not.toMatch(/child_process/);
    expect(code).not.toMatch(/flatpak-spawn/);
    expect(code).not.toMatch(/(?<![.\w])(execFile|execFileSync|execSync|spawnSync)\s*\(/);
    // Only the portal bus name appears in the code — org.freedesktop.Flatpak
    // (no `.portal.`) is the host command runner and must not.
    expect(code).toMatch(/org\.freedesktop\.portal\.Flatpak/);
    expect(code).not.toMatch(/"org\.freedesktop\.Flatpak"/);
    // The code still has to BE the module: an empty string passes everything
    // above.
    expect(code).toMatch(/module\.exports/);
  });

  it("keeps the manifest free of the permissions the portal path makes unnecessary", () => {
    // The GRANTS are asserted, not the region: the prose above `modules:`
    // names the refused permissions in order to say why, so a substring search
    // over the text would fail on its own explanation.
    const region = manifest.slice(
      manifest.indexOf("finish-args:"),
      manifest.indexOf("modules:"),
    );
    const granted = region
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim());
    expect(granted.length).toBeGreaterThan(0);
    expect(granted).toContain("--share=network");
    for (const arg of granted) {
      expect(arg).not.toContain("org.freedesktop.Flatpak");
      expect(arg).not.toContain("org.freedesktop.portal.OpenURI");
    }
  });
});
