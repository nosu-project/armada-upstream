/**
 * One-time post-login notification opt-in. Permission needs a user gesture
 * (and on iOS PWAs push is otherwise unreachable), so the app-wide
 * `WebPushNotifications` hook calls `requestWebPushOptIn()` and keeps `enable`
 * current; `LoginSetup` registers the opener and the step's button runs
 * `runWebPushEnable()`. Also used for the foreground notifier — see {@link OptInMode}.
 */

/** Set once the opt-in step has been surfaced; a declined step is not re-asked. */
const SHOWN_KEY = "armada:webpush-prompt-shown";

type EnableFn = () => Promise<void>;

/**
 * `"push"` delivers with the tab closed; `"foreground"` (no Web Push) only while
 * Armada is open, so the copy must differ.
 */
export type OptInMode = "push" | "foreground";

let currentMode: OptInMode = "push";

/** The mode the step should present. */
export function webPushOptInMode(): OptInMode {
  return currentMode;
}

/** The live `enable` from whichever web-push hook is active, kept fresh. */
let currentEnable: EnableFn | null = null;

/** The wizard's opener, and whether a show was requested before it registered. */
let opener: (() => void) | null = null;
let pendingRequest = false;

/** One request per session — the guard against re-firing on every re-render. */
let requestedThisSession = false;

/** Point the opt-in action at the active hook's `enable` (or clear on unmount). */
export function setWebPushEnable(fn: EnableFn | null, mode: OptInMode = "push"): void {
  currentEnable = fn;
  currentMode = mode;
}

/** Run the current `enable`. Call from the step's click handler (a gesture). */
export async function runWebPushEnable(): Promise<void> {
  await currentEnable?.();
}

function alreadyShown(): boolean {
  try {
    return localStorage.getItem(SHOWN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember the step was surfaced, so it isn't offered again on later loads. */
export function markWebPushPromptShown(): void {
  try {
    localStorage.setItem(SHOWN_KEY, "1");
  } catch {
    // best-effort
  }
}

/**
 * Ask the wizard to show the opt-in once (per install and session); held until
 * an opener registers.
 */
export function requestWebPushOptIn(): void {
  if (requestedThisSession || alreadyShown()) return;
  requestedThisSession = true;
  if (opener) opener();
  else pendingRequest = true;
}

/** Register the wizard's opener; fires at once if a request is waiting. */
export function registerWebPushOptInOpener(open: () => void): () => void {
  opener = open;
  if (pendingRequest) {
    pendingRequest = false;
    open();
  }
  return () => {
    if (opener === open) opener = null;
  };
}
