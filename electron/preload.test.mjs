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
