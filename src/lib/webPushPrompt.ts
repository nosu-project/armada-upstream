/**
 * Bridges the app-wide web-push hook to the post-login wizard so a fresh
 * web/PWA user is offered a one-time notification opt-in.
 *
 * Web Push is opt-out and auto-syncs on every load, but a brand-new user sits at
 * Notification permission `"default"` — and the browser refuses to grant
 * permission without a user gesture, which a headless auto-sync doesn't have. So
 * without an explicit ask, a fresh user never gets push until they hunt down the
 * Settings toggle. On iOS this is the *only* way in: the Push API exists solely
 * for a Home-Screen PWA, and it likewise needs the tap.
 *
 * The heavy push hooks (`usePushNotifications` / `useNostrPush`) are already
 * mounted once, app-wide, by `WebPushNotifications`. Rather than mount a second
 * copy inside the wizard (doubling every subscribe/register), that single
 * instance drives this module: it keeps the live `enable` action current
 * (`setWebPushEnable`) and, when a fresh logged-in user could receive push,
 * calls `requestWebPushOptIn()`. `LoginSetup` registers an opener that surfaces
 * the step; the step's button runs `runWebPushEnable()` (the tap that grants
 * permission).
 */

/** Set once the opt-in step has been surfaced; a declined step is not re-asked. */
const SHOWN_KEY = "armada:webpush-prompt-shown";

type EnableFn = () => Promise<void>;

/** The live `enable` from whichever web-push hook is active, kept fresh. */
let currentEnable: EnableFn | null = null;

/** The wizard's opener, and whether a show was requested before it registered. */
let opener: (() => void) | null = null;
let pendingRequest = false;

/** One request per session — the guard against re-firing on every re-render. */
let requestedThisSession = false;

/** Point the opt-in action at the active hook's `enable` (or clear on unmount). */
export function setWebPushEnable(fn: EnableFn | null): void {
  currentEnable = fn;
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
 * Ask the post-login wizard to surface the one-time web-push opt-in. No-ops if
 * it's already been shown (this or a previous load) or already requested this
 * session. Held until an opener registers if the wizard hasn't mounted yet.
 */
export function requestWebPushOptIn(): void {
  if (requestedThisSession || alreadyShown()) return;
  requestedThisSession = true;
  if (opener) opener();
  else pendingRequest = true;
}

/**
 * Register the wizard's opener. Fires immediately if a request is already
 * waiting. Returns an unsubscribe.
 */
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

/** Test seam: reset module state. */
export function __resetWebPushPromptForTests(): void {
  currentEnable = null;
  opener = null;
  pendingRequest = false;
  requestedThisSession = false;
  try {
    localStorage.removeItem(SHOWN_KEY);
  } catch {
    // ignore
  }
}
