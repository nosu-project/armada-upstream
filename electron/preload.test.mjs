// @vitest-environment node

import fs from "node:fs";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

function loadPreload() {
  let api;
  const listeners = new Map();
  const ipcRenderer = {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn((channel, listener) => listeners.set(channel, listener)),
    removeListener: vi.fn((channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    }),
  };
  const contextBridge = {
    exposeInMainWorld: vi.fn((_name, value) => {
      api = value;
    }),
  };
  const source = fs.readFileSync(new URL("./preload.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    require: (specifier) => {
      if (specifier === "electron") return { contextBridge, ipcRenderer };
      throw new Error(`unexpected preload dependency: ${specifier}`);
    },
  });
  return { api, ipcRenderer, listeners };
}

describe("screen-share preload bridge", () => {
  it("returns the React picker's source to main over IPC", async () => {
    const { api, ipcRenderer, listeners } = loadPreload();
    api.onPickScreenSource(vi.fn(async () => "screen:portal:1"));

    await listeners.get("armada:pick-screen-source")({}, 42);

    expect(ipcRenderer.send).toHaveBeenCalledWith(
      "armada:screen-source-picked",
      42,
      "screen:portal:1",
    );
  });

  it("reports cancellation when the picker fails", async () => {
    const { api, ipcRenderer, listeners } = loadPreload();
    api.onPickScreenSource(
      vi.fn(async () => {
        throw new Error("picker closed");
      }),
    );

    await listeners.get("armada:pick-screen-source")({}, 7);

    expect(ipcRenderer.send).toHaveBeenCalledWith("armada:screen-source-picked", 7, null);
  });
});

describe("push-to-talk preload bridge", () => {
  it("forwards configuration and press/release state without exposing IPC", async () => {
    const { api, ipcRenderer, listeners } = loadPreload();
    const binding = {
      code: "CapsLock",
      label: "Caps Lock",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };
    const handler = vi.fn();

    api.configurePushToTalk(binding);
    api.setPushToTalkActive(true);
    const unsubscribe = api.onPushToTalkState(handler);
    listeners.get("armada:push-to-talk-state")({}, true);
    listeners.get("armada:push-to-talk-state")({}, false);

    expect(ipcRenderer.invoke).toHaveBeenCalledWith("armada:push-to-talk-configure", binding);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("armada:push-to-talk-active", true);
    expect(handler.mock.calls).toEqual([[true], [false]]);

    const listener = listeners.get("armada:push-to-talk-state");
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "armada:push-to-talk-state",
      listener,
    );
  });
});
