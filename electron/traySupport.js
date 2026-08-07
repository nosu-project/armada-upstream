"use strict";

const { execFile } = require("node:child_process");

const STATUS_NOTIFIER_WATCHER = "org.kde.StatusNotifierWatcher";

function statusNotifierWatcherOwned(stdout) {
  return /^\(\s*true\s*,?\s*\)$/.test(String(stdout).trim());
}

function parseStatusNotifierItems(stdout) {
  return Array.from(String(stdout).matchAll(/'([^']+)'/g), (match) => match[1]);
}

function legacyX11TrayLikelyAvailable(env = process.env) {
  const sessionType = String(env.XDG_SESSION_TYPE || "").toLowerCase();
  const desktop = `${env.XDG_CURRENT_DESKTOP || ""}:${env.DESKTOP_SESSION || ""}`.toLowerCase();

  // GtkStatusIcon cannot provide a visible fallback in a native Wayland
  // session. GNOME also removed its legacy XEmbed tray, including on X11.
  if (sessionType === "wayland" || env.WAYLAND_DISPLAY) return false;
  if (desktop.includes("gnome")) return false;

  return Boolean(env.DISPLAY);
}

function canUseLinuxTray({ watcherOwned = false, env = process.env } = {}) {
  return watcherOwned || legacyX11TrayLikelyAvailable(env);
}

function queryDbusNameOwned(name, execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.DBus",
        "--object-path",
        "/org/freedesktop/DBus",
        "--method",
        "org.freedesktop.DBus.NameHasOwner",
        name,
      ],
      { timeout: 1_500, windowsHide: true },
      (error, stdout) => resolve(!error && statusNotifierWatcherOwned(stdout)),
    );
  });
}

function queryStatusNotifierWatcher(execFileImpl = execFile) {
  return queryDbusNameOwned(STATUS_NOTIFIER_WATCHER, execFileImpl);
}

function queryStatusNotifierItems(execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        STATUS_NOTIFIER_WATCHER,
        "--object-path",
        "/StatusNotifierWatcher",
        "--method",
        "org.freedesktop.DBus.Properties.Get",
        STATUS_NOTIFIER_WATCHER,
        "RegisteredStatusNotifierItems",
      ],
      { timeout: 1_500, windowsHide: true },
      (error, stdout) => resolve(error ? null : parseStatusNotifierItems(stdout)),
    );
  });
}

async function detectLinuxTrayEnvironment({ env = process.env, execFileImpl = execFile } = {}) {
  const watcherOwned = await queryStatusNotifierWatcher(execFileImpl);
  const registeredItems = watcherOwned
    ? await queryStatusNotifierItems(execFileImpl)
    : [];
  return {
    registeredItems,
    watcherOwned,
    supported: canUseLinuxTray({ watcherOwned, env }),
  };
}

async function detectLinuxTraySupport(options) {
  return (await detectLinuxTrayEnvironment(options)).supported;
}

module.exports = {
  STATUS_NOTIFIER_WATCHER,
  canUseLinuxTray,
  detectLinuxTrayEnvironment,
  detectLinuxTraySupport,
  legacyX11TrayLikelyAvailable,
  parseStatusNotifierItems,
  queryDbusNameOwned,
  queryStatusNotifierItems,
  queryStatusNotifierWatcher,
  statusNotifierWatcherOwned,
};
