"use strict";

// Runs in an Electron utility process, never in the main process. venmic's
// PatchBay is a C++ static whose destructor tears PipeWire down at exit() and
// can abort there (pw_proxy_remove assertion), which would core-dump the whole
// app on every quit. Here the main process kills this process instead, so no
// static destructor runs, and a crash costs only screen-share audio.

const { listLinuxAudioApplications } = require("./linuxAudioSources");

let patchBay = null;
let loadError = null;

function load() {
  if (patchBay || loadError) return;
  try {
    const { PatchBay } = require("@vencord/venmic");
    if (!PatchBay.hasPipeWire()) {
      loadError = "PipeWire is not available in this session.";
      return;
    }
    patchBay = new PatchBay();
  } catch (error) {
    loadError = "The PipeWire audio capture module could not be loaded.";
    console.warn("[screen-share] failed to load venmic", error);
  }
}

const handlers = {
  probe() {
    load();
    return {
      loadError: patchBay ? null : loadError,
      // venmic 6.x (only the Flatpak-compatible native addon) starts a link
      // unmuted and has no unmute().
      canUnmute: typeof patchBay?.unmute === "function",
    };
  },
  applications({ electronAudioProcessId }) {
    return listLinuxAudioApplications(patchBay, electronAudioProcessId);
  },
  link({ data }) {
    patchBay.unlink();
    return patchBay.link(data);
  },
  unmute() {
    patchBay?.unmute?.();
    return true;
  },
  unlink() {
    patchBay?.unlink();
  },
};

process.parentPort.on("message", ({ data: { id, op, args } }) => {
  try {
    const handler = handlers[op];
    if (!handler) throw new Error(`unknown op ${op}`);
    if (op !== "probe" && op !== "unlink" && !patchBay) {
      throw new Error("venmic is not loaded");
    }
    process.parentPort.postMessage({ id, ok: true, value: handler(args ?? {}) });
  } catch (error) {
    process.parentPort.postMessage({ id, ok: false, error: String(error?.stack ?? error) });
  }
});
