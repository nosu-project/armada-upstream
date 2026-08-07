"use strict";

const MODIFIER_CODES = {
  AltLeft: "Alt",
  AltRight: "AltRight",
  ControlLeft: "Ctrl",
  ControlRight: "CtrlRight",
  MetaLeft: "Meta",
  MetaRight: "MetaRight",
  ShiftLeft: "Shift",
  ShiftRight: "ShiftRight",
};

function isBinding(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    value.code.length <= 32 &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= 80 &&
    ["altKey", "ctrlKey", "metaKey", "shiftKey"].every((key) => typeof value[key] === "boolean"),
  );
}

function hookKeycode(code, keys) {
  if (/^Key[A-Z]$/.test(code)) return keys[code.slice(3)];
  if (/^Digit[0-9]$/.test(code)) return keys[code.slice(5)];
  const name = MODIFIER_CODES[code] || code;
  return keys[name];
}

function modifiersMatch(binding, event) {
  return (
    (!binding.altKey || event.altKey) &&
    (!binding.ctrlKey || event.ctrlKey) &&
    (!binding.metaKey || event.metaKey) &&
    (!binding.shiftKey || event.shiftKey)
  );
}

class NativePushToTalkHook {
  constructor({ loadHook = () => require("uiohook-napi") } = {}) {
    this.loadHook = loadHook;
    this.hook = null;
    this.onKeyDown = null;
    this.onKeyUp = null;
    this.onPressed = null;
    this.pressed = false;
  }

  async start(binding, onPressed) {
    const { uIOhook, UiohookKey } = this.loadHook();
    const keycode = hookKeycode(binding.code, UiohookKey);
    if (!Number.isInteger(keycode)) throw new Error("That key cannot be registered");
    this.hook = uIOhook;
    this.onPressed = onPressed;
    this.onKeyDown = (event) => {
      if (event.keycode !== keycode || !modifiersMatch(binding, event) || this.pressed) return;
      this.pressed = true;
      onPressed(true);
    };
    this.onKeyUp = (event) => {
      if (event.keycode !== keycode || !this.pressed) return;
      this.pressed = false;
      onPressed(false);
    };
    uIOhook.on("keydown", this.onKeyDown);
    uIOhook.on("keyup", this.onKeyUp);
    try {
      uIOhook.start();
    } catch (error) {
      uIOhook.off("keydown", this.onKeyDown);
      uIOhook.off("keyup", this.onKeyUp);
      this.hook = null;
      throw error;
    }
    return {
      supported: true,
      backend: "native",
      bindingLabel: binding.label,
      reason: null,
    };
  }

  async stop() {
    const hook = this.hook;
    if (!hook) return;
    this.release();
    hook.off("keydown", this.onKeyDown);
    hook.off("keyup", this.onKeyUp);
    this.hook = null;
    this.onKeyDown = null;
    this.onKeyUp = null;
    this.onPressed = null;
    try {
      hook.stop();
    } catch {
      // The native hook may already have stopped during OS logout/shutdown.
    }
  }

  release() {
    if (!this.pressed) return;
    this.pressed = false;
    this.onPressed?.(false);
  }
}

function needsLinuxPortal(env) {
  return Boolean(
    env.FLATPAK_ID ||
    env.WAYLAND_DISPLAY ||
    String(env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland",
  );
}

function errorReason(error, platform, portal) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.includes("cancelled")) return "Push-to-talk shortcut setup was cancelled.";
  if (platform === "darwin") {
    return "Allow Armada in macOS Accessibility settings, then try again.";
  }
  if (portal) {
    return "This Linux desktop does not provide the Global Shortcuts portal required for push to talk on Wayland.";
  }
  return message || "The global push-to-talk shortcut could not be registered.";
}

class PushToTalkController {
  constructor({
    platform = process.platform,
    env = process.env,
    sendState = () => {},
    isMacTrusted = () => true,
    nativeFactory = () => new NativePushToTalkHook(),
    // Lazy by design: Windows/macOS packages exclude dbus-next, so importing
    // the Linux portal at module load would make those apps fail at startup.
    portalFactory = () => {
      const { LinuxGlobalShortcutsPortal } = require("./linuxGlobalShortcuts");
      return new LinuxGlobalShortcutsPortal();
    },
  } = {}) {
    this.platform = platform;
    this.env = env;
    this.sendState = sendState;
    this.isMacTrusted = isMacTrusted;
    this.nativeFactory = nativeFactory;
    this.portalFactory = portalFactory;
    this.backend = null;
    this.bindingSignature = null;
    this.status = null;
    this.active = false;
    this.pressed = false;
    this.generation = 0;
    this.pending = null;
  }

  handlePressed = (pressed) => {
    const next = Boolean(pressed);
    this.pressed = next;
    if (this.active) this.sendState(next);
  };

  async configure(binding) {
    if (binding !== null && !isBinding(binding)) {
      return { supported: false, backend: null, bindingLabel: null, reason: "Invalid push-to-talk shortcut." };
    }
    const signature = binding ? JSON.stringify(binding) : null;
    if (signature && signature === this.bindingSignature && this.status?.supported) return this.status;
    if (signature && signature === this.bindingSignature && this.pending) return this.pending;

    const generation = ++this.generation;
    this.bindingSignature = signature;
    this.status = null;
    const run = async () => {
      this.sendState(false);
      this.pressed = false;
      // Detach synchronously before awaiting teardown. A newer configure call
      // can then install its own backend without an older async teardown later
      // clearing or stopping the replacement.
      const previousBackend = this.backend;
      this.backend = null;
      await previousBackend?.stop();
      if (generation !== this.generation) {
        return { supported: false, backend: null, bindingLabel: null, reason: "Shortcut changed." };
      }
      if (!binding) {
        return { supported: true, backend: null, bindingLabel: null, reason: null };
      }

      const usePortal = this.platform === "linux" && needsLinuxPortal(this.env);
      if (this.platform === "darwin" && !this.isMacTrusted()) {
        return {
          supported: false,
          backend: null,
          bindingLabel: binding.label,
          reason: "Allow Armada in macOS Accessibility settings, then try again.",
        };
      }

      const backend = usePortal ? this.portalFactory() : this.nativeFactory();
      try {
        const status = await backend.start(binding, this.handlePressed);
        if (generation !== this.generation) {
          await backend.stop();
          return status;
        }
        this.backend = backend;
        this.status = status;
        return status;
      } catch (error) {
        await backend.stop().catch(() => {});
        const status = {
          supported: false,
          backend: usePortal ? "portal" : "native",
          bindingLabel: binding.label,
          reason: errorReason(error, this.platform, usePortal),
        };
        if (generation === this.generation) this.status = status;
        return status;
      }
    };
    this.pending = run().finally(() => {
      if (generation === this.generation) this.pending = null;
    });
    return this.pending;
  }

  setActive(active) {
    this.active = Boolean(active);
    if (!this.active) {
      this.pressed = false;
      this.sendState(false);
    }
    return this.active;
  }

  cancelPress() {
    this.backend?.release?.();
    this.pressed = false;
    if (this.active) this.sendState(false);
  }

  async destroy() {
    this.active = false;
    this.sendState(false);
    this.generation += 1;
    await this.backend?.stop();
    this.backend = null;
    this.status = null;
    this.bindingSignature = null;
  }
}

module.exports = {
  NativePushToTalkHook,
  PushToTalkController,
  hookKeycode,
  isBinding,
  modifiersMatch,
  needsLinuxPortal,
};
