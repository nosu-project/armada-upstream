/**
 * Client for the Discord bridge portal's JSON API (`armada-discord-bridge`).
 *
 * The portal owns everything that needs a Discord secret: the OAuth app, the
 * bot token, guild and channel reads. Armada drives that API from the import
 * wizard so the user never leaves the app — and, more importantly, so the
 * founding events are signed by the signer they are *already* logged in with,
 * instead of a second NIP-07 login on someone else's origin.
 *
 * ## Why a bearer token and not the session cookie
 *
 * The portal's cookie is `httpOnly; SameSite=Lax`, which a cross-origin fetch
 * never sends. Relaxing it to `SameSite=None` would work only while third-party
 * cookies do, and `VITE_BRIDGE_PORTAL_URL` explicitly allows the portal to live
 * on a domain unrelated to the client's — exactly the case Safari's ITP blocks
 * outright. So the portal hands this client a token and we present it
 * explicitly. A token the browser does not attach on its own is also the safer
 * shape: no ambient authority, nothing for a hostile page to ride.
 *
 * The token is a portal session id. It lives in `sessionStorage`, so it dies
 * with the tab and never syncs anywhere.
 */

import { bridgePortalUrl } from "@/lib/platform";

const TOKEN_KEY = "armada:bridge-portal-token";

/** postMessage type the portal's popup callback sends back to us. */
export const BRIDGE_SESSION_MESSAGE = "armada-bridge-session";

export class BridgeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BridgeApiError";
  }
}

export function bridgeToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setBridgeToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private-mode storage failures shouldn't crash the wizard; the session
    // just won't survive a reload.
  }
}

/**
 * One JSON call against the portal. Throws {@link BridgeApiError} on any
 * non-2xx, carrying the portal's `error` string when it sent one — those
 * strings are written for humans and are surfaced directly in the wizard.
 */
export async function bridgeApi<T>(path: string, init?: RequestInit): Promise<T> {
  const base = bridgePortalUrl("/");
  if (!base) throw new BridgeApiError("This build has no Discord bridge portal configured.", 0);

  const token = bridgeToken();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new BridgeApiError("Couldn't reach the bridge portal. Check your connection.", 0);
  }

  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    // A dead/rejected token should not strand the wizard on a broken session.
    if (res.status === 401) setBridgeToken(null);
    throw new BridgeApiError(body.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return body;
}

// ── Wire types (mirror packages/portal/web/src/api.ts) ───────────────────────

export interface BridgeMe {
  user: { id: string; username: string; avatarUrl?: string } | null;
  guilds?: Array<{ id: string; name: string; icon?: string }>;
  devLogin: boolean;
  discordConfigured: boolean;
}

export interface ImportChannel {
  discordId: string;
  name: string;
  category?: string;
  kind?: "voice";
  /** Gated on Discord, so it imports as a CORD-03 Private Channel. */
  private?: boolean;
  bridgeable: boolean;
  bridge: boolean;
  selected: boolean;
  history: boolean;
  historyImported?: number;
  historyDoneAt?: number;
  publishedAt?: number;
  bridgeId?: string;
}

export interface ImportPlanView {
  guild: { id: string; name: string; description?: string; iconUrl?: string };
  communityName: string;
  memberCount?: number;
  historyAllowed: boolean;
  emojis: Array<{ id: string; name: string }>;
  channels: ImportChannel[];
  roles: Array<{ discordId: string; name: string; dropped: string[]; publishedAt?: number }>;
  skipped: Array<{ kind: string; name: string; reason: string }>;
  checkpoints?: { communityIdHex?: string; ownerPkHex?: string; emojiPackAddress?: string };
}

/** An unsigned founding event the owner signs in-browser (NIP-07 shape). */
export interface OwnerSignTemplate {
  purpose: string;
  template: { kind: number; content: string; tags: string[][]; created_at: number };
}

export type ImportState =
  | "previewed"
  | "awaiting_sigs"
  | "minting"
  | "publishing"
  | "wiring"
  | "history"
  | "done"
  | "failed";

export interface ImportStatus {
  importId: string;
  status: ImportState;
  statusDetail?: string | null;
  plan: ImportPlanView;
  communityId?: string | null;
  inviteUrl?: string;
}

/** `POST /api/imports`: either the bot is missing, or we have a plan. */
export type PreviewResult =
  | { present: false; installUrl: string }
  | { present: true; importId: string; plan: ImportPlanView; defaultRelays: string[] };

// ── Calls ───────────────────────────────────────────────────────────────────

export const getBridgeMe = () => bridgeApi<BridgeMe>("/api/me");

export const previewImport = (guildId: string) =>
  bridgeApi<PreviewResult>("/api/imports", { method: "POST", body: JSON.stringify({ guildId }) });

export const getImportStatus = (importId: string) =>
  bridgeApi<ImportStatus>(`/api/imports/${importId}`);

export const prepareImport = (
  importId: string,
  body: {
    ownerNpub: string;
    relays?: string[];
    channels: Array<{ discordId: string; selected: boolean; bridge: boolean; history: boolean }>;
  },
) =>
  bridgeApi<{ ownerPk: string; templates: OwnerSignTemplate[] }>(`/api/imports/${importId}/prepare`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const confirmImport = (importId: string, signedEvents: unknown[]) =>
  bridgeApi<{ ok: true }>(`/api/imports/${importId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ signedEvents }),
  });

export const retryImport = (importId: string) =>
  bridgeApi<{ ok: true }>(`/api/imports/${importId}/retry`, { method: "POST" });

export const rerunImportHistory = (importId: string) =>
  bridgeApi<{ ok: true }>(`/api/imports/${importId}/rerun-history`, { method: "POST" });

// ── Discord sign-in (popup + postMessage) ───────────────────────────────────

/**
 * Sign in to the portal with Discord, in a popup.
 *
 * OAuth cannot happen inside our own page: the redirect has to land on the
 * portal's registered `redirect_uri`. So the portal opens in a popup, finishes
 * the exchange, and posts the session token back to this exact origin (which it
 * only does for origins the operator allow-listed). We verify `event.origin`
 * against the configured portal before trusting anything.
 *
 * Resolves once the token is stored. Rejects if the popup is blocked, closed,
 * or nothing arrives inside the timeout.
 */
export function connectDiscord({ timeoutMs = 5 * 60_000 } = {}): Promise<void> {
  const base = bridgePortalUrl("/");
  if (!base) return Promise.reject(new BridgeApiError("This build has no Discord bridge portal configured.", 0));

  const url = `${base}/api/auth/discord?mode=popup&origin=${encodeURIComponent(window.location.origin)}`;
  const popup = window.open(url, "armada-bridge-discord", "width=520,height=780,menubar=no,toolbar=no");
  if (!popup) {
    return Promise.reject(
      new BridgeApiError("Your browser blocked the Discord sign-in window. Allow popups and try again.", 0),
    );
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
      clearTimeout(timer);
      fn();
    };

    const onMessage = (event: MessageEvent) => {
      // Same-origin check first: any page can postMessage at us.
      if (event.origin !== new URL(base).origin) return;
      const data = event.data as { type?: string; token?: string } | null;
      if (!data || data.type !== BRIDGE_SESSION_MESSAGE) return;
      if (typeof data.token !== "string" || !data.token) {
        finish(() => reject(new BridgeApiError("The portal returned no session token.", 0)));
        return;
      }
      setBridgeToken(data.token);
      finish(resolve);
    };
    window.addEventListener("message", onMessage);

    // The popup closing without a message means the user backed out.
    const closedTimer = setInterval(() => {
      if (popup.closed) {
        finish(() => reject(new BridgeApiError("Discord sign-in was cancelled.", 0)));
      }
    }, 500);

    const timer = setTimeout(() => {
      finish(() => {
        popup.close();
        reject(new BridgeApiError("Discord sign-in timed out.", 0));
      });
    }, timeoutMs);
  });
}
