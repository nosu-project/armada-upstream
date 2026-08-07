// @vitest-environment node

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  NativePushToTalkHook,
  PushToTalkController,
  hookKeycode,
  modifiersMatch,
  needsLinuxPortal,
} = require("./pushToTalk.js");

const capsLock = {
  code: "CapsLock",
  label: "Caps Lock",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

class FakeHook extends EventEmitter {
  start = vi.fn();
  stop = vi.fn();
}

describe("native push-to-talk hook", () => {
  it("maps physical browser codes to uiohook keycodes", () => {
    const keys = { A: 30, 7: 8, CapsLock: 58, CtrlRight: 285 };
    expect(hookKeycode("KeyA", keys)).toBe(30);
    expect(hookKeycode("Digit7", keys)).toBe(8);
    expect(hookKeycode("CapsLock", keys)).toBe(58);
    expect(hookKeycode("ControlRight", keys)).toBe(285);
  });

  it("requires configured modifiers but permits unrelated extra modifiers", () => {
    const binding = { ...capsLock, ctrlKey: true };
    expect(modifiersMatch(binding, { ctrlKey: true, altKey: false, metaKey: false, shiftKey: true })).toBe(true);
    expect(modifiersMatch(binding, { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })).toBe(false);
  });

  it("emits one press and one release while ignoring key repeat", async () => {
    const hook = new FakeHook();
    const backend = new NativePushToTalkHook({
      loadHook: () => ({ uIOhook: hook, UiohookKey: { CapsLock: 58 } }),
    });
    const onPressed = vi.fn();
    await backend.start(capsLock, onPressed);

    hook.emit("keydown", { keycode: 58, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
    hook.emit("keydown", { keycode: 58, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
    hook.emit("keyup", { keycode: 58, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });

    expect(onPressed.mock.calls).toEqual([[true], [false]]);
    await backend.stop();
    expect(hook.stop).toHaveBeenCalledOnce();
  });
});

describe("push-to-talk controller", () => {
  it("uses the portal for Wayland and Flatpak, but the native hook for X11", () => {
    expect(needsLinuxPortal({ XDG_SESSION_TYPE: "wayland" })).toBe(true);
    expect(needsLinuxPortal({ FLATPAK_ID: "buzz.armada.app" })).toBe(true);
    expect(needsLinuxPortal({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe(false);
  });

  it("only forwards key state while a call marks push to talk active", async () => {
    const sendState = vi.fn();
    let emit;
    const backend = {
      start: vi.fn(async (_binding, onPressed) => {
        emit = onPressed;
        return { supported: true, backend: "native", bindingLabel: "Caps Lock", reason: null };
      }),
      stop: vi.fn(async () => {}),
    };
    const controller = new PushToTalkController({
      platform: "win32",
      sendState,
      nativeFactory: () => backend,
    });
    await controller.configure(capsLock);
    emit(true);
    expect(sendState).not.toHaveBeenLastCalledWith(true);

    controller.setActive(true);
    emit(true);
    controller.cancelPress();
    expect(sendState).toHaveBeenLastCalledWith(false);
    emit(true);
    emit(false);
    expect(sendState.mock.calls.slice(-2)).toEqual([[true], [false]]);

    controller.setActive(false);
    expect(sendState).toHaveBeenLastCalledWith(false);
    await controller.destroy();
  });

  it("does not let an older async teardown clear a replacement binding", async () => {
    let releaseStop;
    const first = {
      start: vi.fn(async () => ({ supported: true, backend: "native", bindingLabel: "A", reason: null })),
      stop: vi.fn(() => new Promise((resolve) => { releaseStop = resolve; })),
    };
    const replacement = {
      start: vi.fn(async () => ({ supported: true, backend: "native", bindingLabel: "C", reason: null })),
      stop: vi.fn(async () => {}),
    };
    const nativeFactory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(replacement);
    const controller = new PushToTalkController({ platform: "win32", nativeFactory });
    await controller.configure({ ...capsLock, code: "KeyA", label: "A" });

    const superseded = controller.configure({ ...capsLock, code: "KeyB", label: "B" });
    const current = controller.configure({ ...capsLock, code: "KeyC", label: "C" });
    await expect(current).resolves.toMatchObject({ supported: true, bindingLabel: "C" });
    releaseStop();
    await superseded;

    expect(controller.backend).toBe(replacement);
    await controller.destroy();
  });
});
