"use strict";

/**
 * The Flatpak update flow: notice from the release event, install through the
 * Flatpak update portal, restart into the new deploy.
 *
 * A Flatpak's `/app` is a read-only OSTree mount the running process cannot
 * rewrite, and electron-updater has no installer for the format — so the
 * download-and-`quitAndInstall` path the AppImage/NSIS/mac builds use is
 * foreclosed here (see `electron/updateSupport.js`, which excludes it). What
 * this edition has instead is the one privileged actor a sandboxed app may talk
 * to by default: `org.freedesktop.portal.Flatpak`. Its
 * `UpdateMonitor.Update()` deploys the newer commit of THIS app from the origin
 * remote the signed bundle embedded at install time — the GPG-verified OSTree
 * repository under armada.buzz/downloads/flatpak/ (`flatpak/build.sh`,
 * `flatpak/sign.sh`) — and `Spawn()` with FLATPAK_SPAWN_FLAGS_LATEST_VERSION
 * starts a fresh instance on that new deploy. The spawn is the piece a bare
 * `app.relaunch()` cannot deliver: a child of this process inherits the OLD
 * sandbox, whose `/app` still mounts the commit it was launched from.
 *
 * The kind-30622 release event still decides WHETHER to offer. The portal has
 * no "check now" method — it polls the remote on its own ~30-minute clock, and
 * only signals — so the 4-hourly timer and the tray's manual check resolve the
 * same event every other edition resolves (`updateFeed.cjs`, the bundled
 * `src/lib/desktopUpdate.ts`) and compare versions with the same
 * `compareVersions`. The event is DETECTION only: nothing is downloaded from
 * Blossom here. The installed bytes come exclusively from the GPG-verified
 * remote, pulled and deployed by the portal outside the sandbox.
 *
 * What this costs the sandbox: nothing. No finish-args entry — the
 * `org.freedesktop.portal.*` bus names are reachable from every Flatpak by
 * design. The portal refuses to update to a version that requires MORE
 * permissions than the running one (org.freedesktop.DBus.Error.NotSupported;
 * see the manifest comment — growing finish-args breaks this path for one hop),
 * may raise the desktop's own one-time consent dialog from its permission
 * store, and can only pull the app's own ref from the app's own origin — there
 * is no way to hand it arbitrary bytes. That last property is what killed the
 * alternative: applying a Blossom-downloaded bundle in place needs
 * `flatpak-spawn --host` (`--talk-name=org.freedesktop.Flatpak`, arbitrary
 * host-command execution), which spends the boundary this edition exists for.
 *
 * Deliberately Electron-free AND dbus-free: the session bus is injected, so
 * the whole flow — monitor lifecycle, progress folding, the timeout, the spawn
 * arguments — runs on the Linux CI runner against a fake bus, in the same
 * spirit as `updateSupport.js` and `bundleStore.js`. `main.js` supplies the
 * real bus from @jellybrick/dbus-next.
 */

const PORTAL_NAME = "org.freedesktop.portal.Flatpak";
const PORTAL_PATH = "/org/freedesktop/portal/Flatpak";
const PORTAL_INTERFACE = "org.freedesktop.portal.Flatpak";
const UPDATE_MONITOR_INTERFACE = "org.freedesktop.portal.Flatpak.UpdateMonitor";

/** Spawn the LATEST installed version of the app, not the running commit. */
const SPAWN_FLAGS_LATEST_VERSION = 2;

/**
 * The overall status field of an UpdateMonitor Progress signal. The portal
 * guarantees the final signal of an Update() carries a non-zero one.
 */
const PROGRESS_STATUS = {
  RUNNING: 0,
  /** No update to install — the remote has nothing newer than the deploy. */
  EMPTY: 1,
  DONE: 2,
  FAILED: 3,
};

/** How long the portal gets to pull and deploy before it is written off. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The app's entry point inside the sandbox, for the relaunch spawn.
 *
 * The manifest's `command: armada` resolves here, and the wrapper it names
 * (`flatpak/armada-wrapper`) sets TMPDIR and execs through zypak — spawning the
 * Electron binary directly would skip both.
 */
const APP_COMMAND = "/app/bin/armada";

/**
 * Lazily load the version comparator from the bundled feed module.
 *
 * `updateFeed.cjs` is a gitignored build artifact (the compiled
 * `src/lib/desktopUpdate.ts`), so requiring it at module load would make a
 * missing bundle an app that cannot start, and would break the unit test, which
 * has no build. It is required only when the runtime path actually needs it; the
 * test injects its own comparator instead. Using the SAME `compareVersions` the
 * release contract uses everywhere else is the point — a second version parser
 * here would be a second contract free to disagree about what "newer" means.
 */
function loadCompareVersions() {
  return require("./updateFeed.cjs").compareVersions;
}

/**
 * The update to offer, or null if the resolved release is not newer than what
 * is running.
 *
 * `compareVersions` is newest-first (negative when its first argument is the
 * newer), so a strictly-newer resolved version is the only thing that returns
 * the update; equal or older returns null. Downgrades are refused for the same
 * reason electron-updater sets `allowDowngrade = false` — and the portal would
 * refuse them anyway, since OSTree only moves the deploy forward.
 */
function plannedFlatpakUpdate(update, currentVersion, { compareVersions } = {}) {
  if (!update) return null;
  const compare = compareVersions ?? loadCompareVersions();
  if (compare(update.version, currentVersion) >= 0) return null;
  return update;
}

/** A dict value off the wire: dbus-next wraps `a{sv}` entries in Variants. */
function unwrapVariant(raw) {
  return raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
}

/**
 * Fold an UpdateMonitor Progress payload into plain values.
 *
 * A signal with no `status` field is a running one — the portal only promises
 * a non-zero status on the FINAL signal, and intermediate ones may carry only
 * op/progress counters.
 */
function parseProgress(info = {}) {
  const status = unwrapVariant(info.status);
  const progress = unwrapVariant(info.progress);
  return {
    status: typeof status === "number" ? status : PROGRESS_STATUS.RUNNING,
    progress: typeof progress === "number" ? progress : null,
    error: unwrapVariant(info.error) ?? null,
    errorMessage: unwrapVariant(info.error_message) ?? null,
  };
}

/**
 * Ask the portal to install this app's update, and wait for the outcome.
 *
 * `CreateUpdateMonitor` → `Update("", {})` → fold `Progress` signals until one
 * carries a terminal status. Resolves `{ result: "installed" }` on DONE and
 * `{ result: "nothing" }` on EMPTY — the latter is a real case, not an error:
 * the release event and the OSTree repository are published by the same
 * workflow but propagate independently, so the event can name a version the
 * remote has not finished serving yet.
 *
 * Rejects on a FAILED progress (with the portal's error message attached), on
 * `Update()` itself throwing — NotSupported is the portal refusing a version
 * that requires new permissions, which system `flatpak update` can still
 * install — and on the timeout. The monitor is ALWAYS closed on the way out;
 * per the portal contract, Close() also cancels an installation still in
 * flight, which is what makes the timeout a real bound rather than an
 * abandonment.
 */
async function installFlatpakUpdate({
  bus,
  parentWindow = "",
  timeoutMs = INSTALL_TIMEOUT_MS,
  onProgress,
} = {}) {
  const portalObject = await bus.getProxyObject(PORTAL_NAME, PORTAL_PATH);
  const portal = portalObject.getInterface(PORTAL_INTERFACE);
  const monitorPath = await portal.CreateUpdateMonitor({});
  const monitorObject = await bus.getProxyObject(PORTAL_NAME, monitorPath);
  const monitor = monitorObject.getInterface(UPDATE_MONITOR_INTERFACE);

  let handler;
  let timer;
  try {
    const outcome = new Promise((resolve, reject) => {
      handler = (info) => {
        const progress = parseProgress(info);
        if (onProgress) onProgress(progress);
        if (progress.status === PROGRESS_STATUS.DONE) {
          resolve({ result: "installed" });
        } else if (progress.status === PROGRESS_STATUS.EMPTY) {
          resolve({ result: "nothing" });
        } else if (progress.status === PROGRESS_STATUS.FAILED) {
          reject(
            new Error(
              progress.errorMessage ||
                progress.error ||
                "the Flatpak update portal reported a failure",
            ),
          );
        }
      };
      // Subscribed before Update() is called: the portal emits Progress from a
      // worker thread, so a signal can arrive before the method reply does.
      monitor.on("Progress", handler);
      timer = setTimeout(
        () => reject(new Error(`Flatpak update timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (typeof timer.unref === "function") timer.unref();
    });
    // A terminal Progress can settle `outcome` while Update() is still awaited
    // below; this side-channel keeps that from surfacing as an unhandled
    // rejection if Update() throws first. The real result is still awaited.
    outcome.catch(() => {});
    await monitor.Update(parentWindow, {});
    return await outcome;
  } finally {
    clearTimeout(timer);
    if (handler) monitor.removeListener("Progress", handler);
    try {
      await monitor.Close();
    } catch {
      // The outcome above is already decided; a monitor that will not close
      // changes nothing about it.
    }
  }
}

/**
 * A NUL-terminated bytestring, which is how the portal reads `ay` arguments —
 * GLib's g_variant_get_bytestring answers empty for an unterminated array.
 */
function bytestring(value) {
  return Buffer.from(`${value}\0`, "utf8");
}

/**
 * Start a fresh instance of the app on its newest installed deploy.
 *
 * This is the restart half of the update: the running process keeps its old
 * `/app` until it exits, so after a successful Update() the caller releases
 * the single-instance lock, asks the portal to spawn the LATEST version, and
 * exits. No fds are forwarded and no env is passed — the spawned instance is a
 * launch, not a child.
 */
async function restartIntoLatest({ bus, argv = [APP_COMMAND], cwd = "/" } = {}) {
  const portalObject = await bus.getProxyObject(PORTAL_NAME, PORTAL_PATH);
  const portal = portalObject.getInterface(PORTAL_INTERFACE);
  return await portal.Spawn(
    bytestring(cwd),
    argv.map(bytestring),
    {},
    {},
    SPAWN_FLAGS_LATEST_VERSION,
    {},
  );
}

module.exports = {
  APP_COMMAND,
  PROGRESS_STATUS,
  SPAWN_FLAGS_LATEST_VERSION,
  installFlatpakUpdate,
  parseProgress,
  plannedFlatpakUpdate,
  restartIntoLatest,
};
