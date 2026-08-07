"use strict";

const dbus = require("@jellybrick/dbus-next");
const { Message, Variant } = dbus;

const PORTAL_NAME = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const GLOBAL_SHORTCUTS_INTERFACE = "org.freedesktop.portal.GlobalShortcuts";
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const REQUEST_INTERFACE = "org.freedesktop.portal.Request";
const SESSION_INTERFACE = "org.freedesktop.portal.Session";
const SHORTCUT_ID = "push_to_talk";
const ALTERNATE_SHORTCUT_ID = "push_to_talk_alternate";
const SHORTCUT_IDS = [SHORTCUT_ID, ALTERNATE_SHORTCUT_ID];

let nextToken = 1;

function xdgKeyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `KP_${code.slice(6)}`;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;

  return {
    AltLeft: "Alt_L",
    AltRight: "Alt_R",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    Backquote: "grave",
    Backslash: "backslash",
    Backspace: "BackSpace",
    BracketLeft: "bracketleft",
    BracketRight: "bracketright",
    CapsLock: "Caps_Lock",
    Comma: "comma",
    ContextMenu: "Menu",
    ControlLeft: "Control_L",
    ControlRight: "Control_R",
    Delete: "Delete",
    End: "End",
    Enter: "Return",
    Equal: "equal",
    Escape: "Escape",
    Home: "Home",
    Insert: "Insert",
    MetaLeft: "Super_L",
    MetaRight: "Super_R",
    Minus: "minus",
    NumpadAdd: "KP_Add",
    NumpadDecimal: "KP_Decimal",
    NumpadDivide: "KP_Divide",
    NumpadEnter: "KP_Enter",
    NumpadMultiply: "KP_Multiply",
    NumpadSubtract: "KP_Subtract",
    PageDown: "Page_Down",
    PageUp: "Page_Up",
    Period: "period",
    Quote: "apostrophe",
    Semicolon: "semicolon",
    ShiftLeft: "Shift_L",
    ShiftRight: "Shift_R",
    Slash: "slash",
    Space: "space",
    Tab: "Tab",
  }[code] || null;
}

/** Convert Armada's physical-key binding to the XDG Shortcuts syntax. */
function bindingToXdgTrigger(binding) {
  const key = xdgKeyName(binding?.code);
  if (!key) return null;
  const modifiers = [];
  if (binding.ctrlKey) modifiers.push("CTRL");
  if (binding.altKey) modifiers.push("ALT");
  if (binding.shiftKey) modifiers.push("SHIFT");
  if (binding.metaKey) modifiers.push("LOGO");
  return [...modifiers, key].join("+");
}

function requestMatchRule() {
  return [
    "type='signal'",
    `sender='${PORTAL_NAME}'`,
    `interface='${REQUEST_INTERFACE}'`,
    "member='Response'",
  ].join(",");
}

async function changeMatch(bus, member, rule) {
  await bus.call(new Message({
    destination: "org.freedesktop.DBus",
    path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus",
    member,
    signature: "s",
    body: [rule],
  }));
}

/**
 * Invoke one of the portal's request methods without racing its Response
 * signal. The match is installed before the method call; responses that arrive
 * before the returned request path is known are queued and matched afterwards.
 */
async function portalRequest(bus, invoke, timeoutMs = 120_000) {
  const rule = requestMatchRule();
  await changeMatch(bus, "AddMatch", rule);
  const queued = [];
  let requestPath = null;
  let settle;
  const response = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const onMessage = (message) => {
    if (
      message.interface !== REQUEST_INTERFACE ||
      message.member !== "Response"
    ) return;
    if (!requestPath) {
      queued.push(message);
      return;
    }
    if (message.path === requestPath) settle.resolve(message.body);
  };
  bus.on("message", onMessage);
  const timer = setTimeout(() => settle.reject(new Error("Global shortcut portal timed out")), timeoutMs);

  try {
    requestPath = await invoke();
    const early = queued.find((message) => message.path === requestPath);
    if (early) settle.resolve(early.body);
    const [resultCode, results] = await response;
    if (resultCode !== 0) {
      throw new Error(resultCode === 1 ? "Global shortcut setup was cancelled" : "Global shortcut setup failed");
    }
    return results || {};
  } finally {
    clearTimeout(timer);
    bus.off("message", onMessage);
    void changeMatch(bus, "RemoveMatch", rule).catch(() => {});
  }
}

function variantValue(value) {
  return value instanceof Variant ? value.value : value;
}

function desktopEnvironment(env = process.env) {
  const value = [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION]
    .filter(Boolean)
    .join(":")
    .toLowerCase();
  if (value.includes("cosmic")) return "cosmic";
  if (value.includes("kde") || value.includes("plasma")) return "kde";
  if (value.includes("gnome")) return "gnome";
  return "unknown";
}

function portalSettingsHint(desktop, portalVersion) {
  if (portalVersion >= 2) {
    return "Click the assigned shortcut above to change it in your desktop's trusted editor.";
  }
  return "Click the assigned shortcut above to reopen your desktop's trusted shortcut chooser.";
}

function nextLegacyShortcutId(shortcutId) {
  return shortcutId === SHORTCUT_ID ? ALTERNATE_SHORTCUT_ID : SHORTCUT_ID;
}

function knownShortcutId(shortcutId) {
  return SHORTCUT_IDS.includes(shortcutId) ? shortcutId : SHORTCUT_ID;
}

async function readPortalVersion(portalObject) {
  try {
    const properties = portalObject.getInterface(PROPERTIES_INTERFACE);
    const version = Number(variantValue(
      await properties.Get(GLOBAL_SHORTCUTS_INTERFACE, "version"),
    ));
    return Number.isInteger(version) && version > 0 ? version : 1;
  } catch {
    // Global Shortcuts v1 predates ConfigureShortcuts. Treat an old portal
    // that omits or cannot read the property conservatively as v1.
    return 1;
  }
}

/** GNOME currently returns GTK accelerator text instead of a display label. */
function formatShortcutDescription(value) {
  const description = String(value || "");
  if (!description.includes("<")) {
    if (!/\bPress\s+/i.test(description)) return description;
    return description
      .replace(/\bPress\s+/gi, "")
      .split(/\s*\+\s*/)
      .map((part) => part.length === 1 ? part.toUpperCase() : part)
      .join(" + ");
  }
  const modifiers = [];
  const key = description.replace(/<([^>]+)>/g, (_match, modifier) => {
    modifiers.push({
      Alt: "Alt",
      Control: "Ctrl",
      Ctrl: "Ctrl",
      Meta: "Meta",
      Primary: "Ctrl",
      Shift: "Shift",
      Super: "Super",
    }[modifier] || modifier);
    return "";
  });
  const keyLabel = key.length === 1 ? key.toUpperCase() : key;
  return [...modifiers, keyLabel].filter(Boolean).join(" + ") || description;
}

function propertyValue(properties, key) {
  return variantValue(properties instanceof Map ? properties.get(key) : properties?.[key]);
}

function shortcutDescription(shortcuts, fallback, shortcutId = SHORTCUT_ID) {
  for (const [id, properties] of shortcuts || []) {
    if (id !== shortcutId) continue;
    return formatShortcutDescription(propertyValue(properties, "trigger_description") || fallback);
  }
  return fallback;
}

class LinuxGlobalShortcutsPortal {
  constructor({
    sessionBus = dbus.sessionBus,
    env = process.env,
    loadShortcutId = () => SHORTCUT_ID,
    saveShortcutId = () => {},
  } = {}) {
    this.sessionBus = sessionBus;
    this.desktop = desktopEnvironment(env);
    this.loadShortcutId = loadShortcutId;
    this.saveShortcutId = saveShortcutId;
    this.bus = null;
    this.globalShortcuts = null;
    this.portalVersion = 0;
    this.sessionHandle = null;
    this.shortcutId = SHORTCUT_ID;
    this.binding = null;
    this.suspended = false;
    this.onPressed = null;
    this.onStatusChanged = null;
    this.onActivated = null;
    this.onDeactivated = null;
    this.onShortcutsChanged = null;
  }

  async start(binding, onPressed, onStatusChanged = () => {}) {
    const preferredTrigger = bindingToXdgTrigger(binding);
    if (!preferredTrigger) throw new Error("That key cannot be registered on Linux");

    const bus = this.sessionBus();
    this.bus = bus;
    this.onPressed = onPressed;
    this.onStatusChanged = onStatusChanged;
    this.binding = binding;
    try {
      this.shortcutId = knownShortcutId(this.loadShortcutId());
    } catch {
      this.shortcutId = SHORTCUT_ID;
    }
    try {
      const portalObject = await bus.getProxyObject(PORTAL_NAME, PORTAL_PATH);
      const globalShortcuts = portalObject.getInterface(GLOBAL_SHORTCUTS_INTERFACE);
      this.globalShortcuts = globalShortcuts;
      this.portalVersion = await readPortalVersion(portalObject);

      this.onActivated = (sessionHandle, shortcutId) => {
        if (!this.suspended && sessionHandle === this.sessionHandle && shortcutId === this.shortcutId) {
          this.onPressed?.(true);
        }
      };
      this.onDeactivated = (sessionHandle, shortcutId) => {
        if (!this.suspended && sessionHandle === this.sessionHandle && shortcutId === this.shortcutId) {
          this.onPressed?.(false);
        }
      };
      this.onShortcutsChanged = (sessionHandle, shortcuts) => {
        if (sessionHandle !== this.sessionHandle) return;
        this.release();
        this.onStatusChanged?.({
          supported: true,
          backend: "portal",
          bindingLabel: shortcutDescription(shortcuts, binding.label, this.shortcutId),
          reason: null,
          settingsAvailable: true,
          settingsHint: portalSettingsHint(this.desktop, this.portalVersion),
        });
      };
      globalShortcuts.on("Activated", this.onActivated);
      globalShortcuts.on("Deactivated", this.onDeactivated);
      globalShortcuts.on("ShortcutsChanged", this.onShortcutsChanged);

      const token = this.nextToken();
      this.sessionHandle = await this.createSession(token);
      const bindResults = await this.bindSession(
        this.sessionHandle,
        this.shortcutId,
        preferredTrigger,
        token,
      );
      const shortcuts = variantValue(bindResults.shortcuts) || [];
      if (!shortcuts.some(([id]) => id === this.shortcutId)) {
        throw new Error("No push-to-talk shortcut was assigned");
      }
      this.persistShortcutId(this.shortcutId);

      return {
        supported: true,
        backend: "portal",
        bindingLabel: shortcutDescription(shortcuts, binding.label, this.shortcutId),
        reason: null,
        settingsAvailable: true,
        settingsHint: portalSettingsHint(this.desktop, this.portalVersion),
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async openSettings() {
    if (!this.globalShortcuts || !this.sessionHandle) return false;
    this.release();
    if (this.portalVersion >= 2) {
      if (typeof this.globalShortcuts.ConfigureShortcuts !== "function") return false;
      await this.globalShortcuts.ConfigureShortcuts(this.sessionHandle, "", {});
      return true;
    }
    if (!this.bus || !this.binding) return false;

    const previousSession = this.sessionHandle;
    const replacementId = nextLegacyShortcutId(this.shortcutId);
    const token = this.nextToken();
    const replacementSession = await this.createSession(token);
    this.suspended = true;
    try {
      // A v1 portal has no ConfigureShortcuts method. A replacement action ID
      // makes BindShortcuts show the same trusted chooser used on first setup.
      // The old session stays live until the user accepts, so cancel is safe.
      const bindResults = await this.bindSession(
        replacementSession,
        replacementId,
        null,
        token,
      );
      const shortcuts = variantValue(bindResults.shortcuts) || [];
      if (!shortcuts.some(([id]) => id === replacementId)) {
        await this.closeSession(replacementSession);
        return false;
      }

      this.shortcutId = replacementId;
      this.sessionHandle = replacementSession;
      this.persistShortcutId(replacementId);
      await this.closeSession(previousSession);
      this.onStatusChanged?.({
        supported: true,
        backend: "portal",
        bindingLabel: shortcutDescription(shortcuts, this.binding.label, this.shortcutId),
        reason: null,
        settingsAvailable: true,
        settingsHint: portalSettingsHint(this.desktop, this.portalVersion),
      });
      return true;
    } catch (error) {
      await this.closeSession(replacementSession);
      if (error instanceof Error && error.message.includes("cancelled")) return true;
      throw error;
    } finally {
      this.suspended = false;
    }
  }

  nextToken() {
    return `armada_ptt_${process.pid}_${nextToken++}`;
  }

  async createSession(token) {
    const createResults = await portalRequest(this.bus, () => this.globalShortcuts.CreateSession({
      handle_token: new Variant("s", `${token}_create`),
      session_handle_token: new Variant("s", `${token}_session`),
    }));
    const sessionHandle = String(variantValue(createResults.session_handle) || "");
    if (!sessionHandle) throw new Error("Global shortcut portal returned no session");
    return sessionHandle;
  }

  async bindSession(sessionHandle, shortcutId, preferredTrigger, token) {
    const properties = {
      description: new Variant("s", "Hold to talk in Armada"),
    };
    if (preferredTrigger) {
      properties.preferred_trigger = new Variant("s", preferredTrigger);
    }
    return portalRequest(this.bus, () => this.globalShortcuts.BindShortcuts(
      sessionHandle,
      [[shortcutId, properties]],
      "",
      { handle_token: new Variant("s", `${token}_bind`) },
    ));
  }

  async closeSession(sessionHandle, bus = this.bus) {
    if (!bus || !sessionHandle) return;
    try {
      const sessionObject = await bus.getProxyObject(PORTAL_NAME, sessionHandle);
      await sessionObject.getInterface(SESSION_INTERFACE).Close();
    } catch {
      // The compositor may already have closed the session.
    }
  }

  persistShortcutId(shortcutId) {
    try {
      this.saveShortcutId(shortcutId);
    } catch {
      // Losing this hint only makes a legacy portal ask again after restart.
    }
  }

  async stop() {
    this.release();
    const bus = this.bus;
    const globalShortcuts = this.globalShortcuts;
    const sessionHandle = this.sessionHandle;
    this.bus = null;
    this.globalShortcuts = null;
    this.portalVersion = 0;
    this.sessionHandle = null;
    this.shortcutId = SHORTCUT_ID;
    this.binding = null;
    this.suspended = false;
    this.onPressed = null;
    this.onStatusChanged = null;
    if (globalShortcuts && this.onActivated) globalShortcuts.off("Activated", this.onActivated);
    if (globalShortcuts && this.onDeactivated) globalShortcuts.off("Deactivated", this.onDeactivated);
    if (globalShortcuts && this.onShortcutsChanged) {
      globalShortcuts.off("ShortcutsChanged", this.onShortcutsChanged);
    }
    this.onActivated = null;
    this.onDeactivated = null;
    this.onShortcutsChanged = null;
    if (!bus) return;
    await this.closeSession(sessionHandle, bus);
    bus.disconnect();
  }

  release() {
    this.onPressed?.(false);
  }
}

module.exports = {
  GLOBAL_SHORTCUTS_INTERFACE,
  LinuxGlobalShortcutsPortal,
  PORTAL_NAME,
  PORTAL_PATH,
  PROPERTIES_INTERFACE,
  SHORTCUT_ID,
  ALTERNATE_SHORTCUT_ID,
  bindingToXdgTrigger,
  desktopEnvironment,
  formatShortcutDescription,
  knownShortcutId,
  nextLegacyShortcutId,
  portalSettingsHint,
  portalRequest,
  readPortalVersion,
  shortcutDescription,
  xdgKeyName,
};
