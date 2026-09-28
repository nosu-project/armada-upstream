import { createContext } from "react";

import type { Channel, Community } from "@/concord/lib/types";
import type { ImetaEncryption } from "@/lib/imeta";

/** Which chat surface an app runs in; each variant maps to its own {@link AppSync} backend. */
export type AppScope =
  | { kind: "nip29"; relayUrl: string; groupId: string }
  | { kind: "concord"; community: Community; channel: Channel }
  /** A NIP-17 conversation, named by its participant SET (`dmConvKey`), never one peer. */
  | { kind: "dm"; conversation: string };

/**
 * A stable scope string, identical across clients for the same channel so
 * everyone converges on one session ({@link defaultSessionId}). Concord uses the
 * hex channel id, not the name.
 */
export function appScopeKey(scope: AppScope): string {
  switch (scope.kind) {
    case "nip29":
      return `nip29|${scope.relayUrl}|${scope.groupId}`;
    case "concord":
      // `concord2|` is cross-client — don't respell it.
      return `concord2|${scope.channel.idHex}`;
    case "dm":
      // For a 1:1 this equals the old single-pubkey key, so sessions don't rename.
      return `dm|${scope.conversation}`;
  }
}

/**
 * Default session id for a built-in app: deterministic from scope + type, so one
 * shared session per channel. Webxdc apps pass the attachment's uuid instead.
 */
export function defaultSessionId(scope: AppScope, app: AppKind): string {
  return `${appScopeKey(scope)}|${app.type}`;
}

/**
 * Which app is running: a built-in by type, or `webxdc` with its `.xdc` URL and
 * manifest metadata. The watchalong keeps the `youtube` type even for direct
 * video — it's part of the cross-client session id.
 */
export type AppKind =
  | { type: "youtube" }
  | {
      type: "webxdc";
      url: string;
      name?: string;
      icon?: string;
      /** AES-GCM params when the `.xdc` is a client-encrypted (e.g. Concord) attachment. */
      encryption?: ImetaEncryption;
    };

/** A running in-chat app: the chat it lives in, what it is, and its sync session id. */
export interface ActiveApp {
  scope: AppScope;
  app: AppKind;
  /** Coordination session id (webxdc `i`/`uuid`); relaunching with it rejoins. */
  sessionId: string;
}

export interface AppsContextType {
  activeApp: ActiveApp | null;
  /** Launch an app in a chat (replaces any currently-open app). */
  launchApp: (scope: AppScope, app: AppKind, sessionId?: string) => void;
  closeApp: () => void;
  /**
   * Hand the running app a fresher scope. A Concord rotation replaces the channel's
   * keys without changing the scope KEY, so nothing remounts and the app would
   * keep sealing under a retired epoch (which receivers refuse). Scopes for other
   * chats are ignored.
   */
  refreshScope: (scope: AppScope) => void;
  /** Register the top-of-chat node for the app stage (matching scope only). Returns an unregister. */
  registerAppStageSlot: (el: HTMLElement) => () => void;
  /** Whether the app stage is expanded (vs minimized to a pill). */
  stageOpen: boolean;
  /** Toggle the stage open/closed. */
  toggleStage: () => void;
  /** Explicitly set the stage open state. */
  setStageOpen: (open: boolean) => void;
}

export const AppsContext = createContext<AppsContextType | undefined>(undefined);
