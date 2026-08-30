import { createContext } from "react";

import type { Channel, Community } from "@/concord/lib/types";
import type { ImetaEncryption } from "@/lib/imeta";

/**
 * Which chat surface an app is running in. NIP-29 groups are addressed by
 * `relayUrl` + `groupId`; Concord channels carry their decrypted key
 * material. Each variant maps onto its own {@link AppSync} backend.
 */
export type AppScope =
  | { kind: "nip29"; relayUrl: string; groupId: string }
  | { kind: "concord"; community: Community; channel: Channel }
  /**
   * A NIP-17 conversation, named by its participant SET (`dmConvKey`) and never
   * by one peer. The two spellings coincide for a 1:1 and diverge for a group,
   * and a scope that carried a peer named a room that only sometimes existed:
   * the launch card and the stage slot then keyed differently, so the app
   * portalled into a slot nothing had registered.
   */
  | { kind: "dm"; conversation: string };

/**
 * A stable string identifying a chat scope. MUST be deterministic and identical
 * across clients/devices for the same channel, so everyone who launches an app
 * in that channel converges on the same coordination session (see
 * {@link defaultSessionId}). NIP-29 uses relay+group; Concord uses the hex
 * channel id (unique, unlike the human channel name).
 */
export function appScopeKey(scope: AppScope): string {
  switch (scope.kind) {
    case "nip29":
      return `nip29|${scope.relayUrl}|${scope.groupId}`;
    case "concord":
      // The `concord2|` spelling is load-bearing and stays: this key is
      // cross-client, so respelling it would put this build in a different
      // coordination session from every other client in the same channel.
      return `concord2|${scope.channel.idHex}`;
    case "dm":
      // The participant set, which for a 1:1 is byte-identical to the single
      // pubkey this used to be — so no existing session is renamed.
      return `dm|${scope.conversation}`;
  }
}

/**
 * The default coordination-session id for a built-in app in a scope. Derived
 * deterministically from the scope + app type so that everyone in the same
 * channel who opens (e.g.) the watchalong joins the SAME session — there's one
 * shared watchalong per channel, not a private one per person. Webxdc apps
 * instead pass an explicit session id (the attachment's `webxdc` uuid).
 */
export function defaultSessionId(scope: AppScope, app: AppKind): string {
  return `${appScopeKey(scope)}|${app.type}`;
}

/**
 * Which app is running. A built-in app (`youtube` watchalong) is identified by
 * its type; a `webxdc` app additionally carries the `.xdc` archive URL and
 * display metadata parsed from its manifest.
 */
export type AppKind =
  | { type: "youtube" }
  | {
      type: "webxdc";
      url: string;
      name?: string;
      icon?: string;
      /**
       * AES-GCM params when the `.xdc` blob is a client-encrypted attachment
       * (Concord channels encrypt uploads), so the archive is decrypted before
       * unzip. Absent for plaintext (e.g. NIP-29) attachments.
       */
      encryption?: ImetaEncryption;
    };

/** A running in-chat app: the chat it lives in, what it is, and its sync session id. */
export interface ActiveApp {
  scope: AppScope;
  app: AppKind;
  /**
   * The coordination session id (the webxdc `i`/`uuid`). All state/realtime
   * traffic is scoped to this, so re-launching the same app with the same id
   * rejoins the shared session.
   */
  sessionId: string;
}

export interface AppsContextType {
  /** The app currently open, or null. */
  activeApp: ActiveApp | null;
  /** Launch an app in a chat (replaces any currently-open app). */
  launchApp: (scope: AppScope, app: AppKind, sessionId?: string) => void;
  /** Close the open app. */
  closeApp: () => void;
  /**
   * Hand the running app a fresher view of the chat it lives in.
   *
   * `scope` carries live objects — a Concord `Channel` holds the group key and
   * epoch its messages are sealed under — and it is captured when the app
   * launches. A rotation replaces those without changing the scope KEY, so
   * nothing remounts and the app keeps sealing under an epoch the channel has
   * retired. Receivers refuse that (`concord/lib/chat.ts`, by design, so an
   * ejected member cannot keep writing), and the sender sees nothing wrong
   * because it renders its own writes locally. The chat surface owns the live
   * objects, so it pushes them here; a scope for a different chat is ignored.
   */
  refreshScope: (scope: AppScope) => void;
  /**
   * Register the top-of-chat DOM node into which the running app's stage should
   * portal. Only the chat surface matching the active app's scope should
   * register. Returns an unregister function.
   */
  registerAppStageSlot: (el: HTMLElement) => () => void;
  /** Whether the app stage is expanded (vs minimized to a pill). */
  stageOpen: boolean;
  /** Toggle the stage open/closed. */
  toggleStage: () => void;
  /** Explicitly set the stage open state. */
  setStageOpen: (open: boolean) => void;
}

export const AppsContext = createContext<AppsContextType | undefined>(undefined);
