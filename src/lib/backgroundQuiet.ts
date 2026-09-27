/**
 * Android: while the app is in the background and the native notification
 * service is watching the account, the WebView goes QUIET.
 *
 * Nothing used to tell the WebView it had been backgrounded, so it went on
 * syncing as if on screen: its own wire subscriptions to every relay the
 * service was ALSO subscribed to, the sync scheduler's rounds, and a second
 * pass over every event the service received and forwarded to it. On a busy
 * account that measured 25–55 MB an hour and a quarter of a core with the
 * screen off — the same relays downloaded twice, and each event opened twice.
 *
 * The service is the background path by design: it holds the sockets,
 * decrypts, stores into the shared database and notifies. What it received
 * while the WebView was quiet is routed through ingest on resume (the durable
 * drain in WireSync), and the wire resumes each relay from its cursor, so
 * going quiet loses nothing — it only stops doing the work twice.
 *
 * Not while anything the user can hear or see depends on the page: a call (its
 * media runs in the WebView), or any playing audio/video element. Those keep
 * the WebView fully awake, exactly as before.
 */
import { onAppStateChange } from "@/lib/appStateEvents";

/** Grace before going quiet, so a quick app switch doesn't tear subscriptions down. */
const QUIET_AFTER_MS = 15_000;

let quiet = false;
let serviceWatching = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let installed = false;
const listeners = new Set<() => void>();
const holds = new Set<string>();

function set(next: boolean): void {
  if (quiet === next) return;
  quiet = next;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener must never break the others.
    }
  }
}

/** Whether something on the page must keep running in the background. */
function pageIsBusy(): boolean {
  if (holds.size > 0) return true;
  if (typeof document === "undefined") return false;
  for (const media of document.querySelectorAll<HTMLMediaElement>("audio, video")) {
    if (!media.paused && !media.ended) return true;
  }
  return false;
}

function install(): void {
  if (installed) return;
  installed = true;
  onAppStateChange((isActive) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (isActive) {
      set(false);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (serviceWatching && !pageIsBusy()) set(true);
    }, QUIET_AFTER_MS);
  });
  // Playback can also START while quiet (the lock screen's media controls),
  // after the check above has run. `play` doesn't bubble, hence the capture.
  if (typeof document !== "undefined") {
    document.addEventListener("play", () => set(false), true);
  }
}

/** Whether the WebView is quiet right now (see the module comment). */
export function isBackgroundQuiet(): boolean {
  return quiet;
}

/** Subscribe to quiet flips. Installs the app-state listener on first use. */
export function onBackgroundQuiet(listener: () => void): () => void {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tell this module whether the native service is running with a live config
 * for the account — the only case in which the WebView may hand the
 * background over to it. Losing the service while quiet wakes the WebView.
 */
export function setNativeServiceWatching(watching: boolean): void {
  // Profiling builds: `armada:perf-no-quiet` keeps the old behavior, for an
  // A/B measurement on one device and one account.
  if (import.meta.env.VITE_PROFILE === "1" && watching) {
    try {
      if (localStorage.getItem("armada:perf-no-quiet") === "1") watching = false;
    } catch {
      // no storage: measure the real behavior
    }
  }
  serviceWatching = watching;
  install();
  if (!watching) set(false);
}

/**
 * Keep the WebView awake in the background while `reason` is held (a call).
 * Taking a hold while quiet wakes it. Returns the release.
 */
export function holdBackgroundActivity(reason: string): () => void {
  holds.add(reason);
  set(false);
  return () => {
    holds.delete(reason);
  };
}

/** Test seam. */
export function _resetBackgroundQuietForTests(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  quiet = false;
  serviceWatching = false;
  holds.clear();
  listeners.clear();
}

// Profiling builds: readable from DevTools, for device-driven measurement.
if (import.meta.env.VITE_PROFILE === "1") {
  (globalThis as { __armadaBackgroundQuiet?: () => unknown }).__armadaBackgroundQuiet = () => ({
    quiet,
    serviceWatching,
    holds: [...holds],
    pageIsBusy: pageIsBusy(),
  });
}
