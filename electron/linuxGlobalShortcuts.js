"use strict";

const dbus = require("@jellybrick/dbus-next");
const { Message, Variant } = dbus;

const PORTAL_NAME = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const GLOBAL_SHORTCUTS_INTERFACE = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_INTERFACE = "org.freedesktop.portal.Request";
const SESSION_INTERFACE = "org.freedesktop.portal.Session";
const SHORTCUT_ID = "push_to_talk";

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

function shortcutDescription(shortcuts, fallback) {
  for (const [id, properties] of shortcuts || []) {
    if (id !== SHORTCUT_ID) continue;
    return String(variantValue(properties?.trigger_description) || fallback);
  }
  return fallback;
}

class LinuxGlobalShortcutsPortal {
  constructor({ sessionBus = dbus.sessionBus } = {}) {
    this.sessionBus = sessionBus;
    this.bus = null;
    this.globalShortcuts = null;
    this.sessionHandle = null;
    this.onPressed = null;
    this.onActivated = null;
    this.onDeactivated = null;
  }

  async start(binding, onPressed) {
    const preferredTrigger = bindingToXdgTrigger(binding);
    if (!preferredTrigger) throw new Error("That key cannot be registered on Linux");

    const bus = this.sessionBus();
    this.bus = bus;
    this.onPressed = onPressed;
    try {
      const portalObject = await bus.getProxyObject(PORTAL_NAME, PORTAL_PATH);
      const globalShortcuts = portalObject.getInterface(GLOBAL_SHORTCUTS_INTERFACE);
      this.globalShortcuts = globalShortcuts;

      this.onActivated = (sessionHandle, shortcutId) => {
        if (sessionHandle === this.sessionHandle && shortcutId === SHORTCUT_ID) this.onPressed?.(true);
      };
      this.onDeactivated = (sessionHandle, shortcutId) => {
        if (sessionHandle === this.sessionHandle && shortcutId === SHORTCUT_ID) this.onPressed?.(false);
      };
      globalShortcuts.on("Activated", this.onActivated);
      globalShortcuts.on("Deactivated", this.onDeactivated);

      const token = `armada_ptt_${process.pid}_${nextToken++}`;
      const createResults = await portalRequest(bus, () => globalShortcuts.CreateSession({
        handle_token: new Variant("s", `${token}_create`),
        session_handle_token: new Variant("s", `${token}_session`),
      }));
      this.sessionHandle = String(variantValue(createResults.session_handle) || "");
      if (!this.sessionHandle) throw new Error("Global shortcut portal returned no session");

      const bindResults = await portalRequest(bus, () => globalShortcuts.BindShortcuts(
        this.sessionHandle,
        [[SHORTCUT_ID, {
          description: new Variant("s", "Hold to talk in Armada"),
          preferred_trigger: new Variant("s", preferredTrigger),
        }]],
        "",
        { handle_token: new Variant("s", `${token}_bind`) },
      ));
      const shortcuts = variantValue(bindResults.shortcuts) || [];
      if (!shortcuts.some(([id]) => id === SHORTCUT_ID)) {
        throw new Error("No push-to-talk shortcut was assigned");
      }

      return {
        supported: true,
        backend: "portal",
        bindingLabel: shortcutDescription(shortcuts, binding.label),
        reason: null,
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    this.release();
    const bus = this.bus;
    const globalShortcuts = this.globalShortcuts;
    const sessionHandle = this.sessionHandle;
    this.bus = null;
    this.globalShortcuts = null;
    this.sessionHandle = null;
    this.onPressed = null;
    if (globalShortcuts && this.onActivated) globalShortcuts.off("Activated", this.onActivated);
    if (globalShortcuts && this.onDeactivated) globalShortcuts.off("Deactivated", this.onDeactivated);
    this.onActivated = null;
    this.onDeactivated = null;
    if (!bus) return;
    try {
      if (sessionHandle) {
        const sessionObject = await bus.getProxyObject(PORTAL_NAME, sessionHandle);
        await sessionObject.getInterface(SESSION_INTERFACE).Close();
      }
    } catch {
      // The compositor may already have closed the session.
    } finally {
      bus.disconnect();
    }
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
  SHORTCUT_ID,
  bindingToXdgTrigger,
  portalRequest,
  shortcutDescription,
  xdgKeyName,
};
