import { createContext } from "react";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { MeshPeer } from "@/lib/bluetoothMesh";

/**
 * The live Bluetooth-mesh state, exposed app-wide via {@link MeshContext}.
 *
 * This is hosted by a provider mounted ABOVE the router (see `MeshProvider` in
 * `components/MeshProvider.tsx`), so the message/DM history and peer roster
 * survive navigating away from the Mesh page and back — they're tied to the app
 * session, not the `/mesh` route's mount. (The native BLE service only pushes
 * *new* messages; it has no history replay, so unmounting the page used to drop
 * the whole conversation.)
 */
export interface MeshState {
  /** Whether the platform can run the BLE mesh (Android only). */
  available: boolean;
  /** Whether the mesh is currently running. */
  started: boolean;
  /** This device's mesh peer id, once started. */
  myPeerID: string | null;
  /** Current peer roster. */
  peers: MeshPeer[];
  /** Direct-message histories keyed by mesh peer id. */
  directMessages: Record<string, ChatMsg[]>;
  /** A startup/permission error, if any. */
  error: string | null;
  /**
   * Whether incognito mode is on. When on, this device announces a derived
   * `anon<peerid>` nickname; when off, the user's Armada display name.
   */
  incognito: boolean;
  /** The nickname this device is currently announcing on the mesh. */
  myNickname: string;
  /** Manually (re)start the mesh (e.g. after granting permission). */
  start: () => Promise<void>;
  /** Stop the mesh. */
  stop: () => Promise<void>;
  /** Toggle incognito mode (persisted) and re-announce under the new name. */
  setIncognito: (incognito: boolean) => void;
}

export interface MeshContextType {
  /** The broadcast room as a {@link ChatTransport} for the shared chat UI. */
  transport: ChatTransport;
  /** The full live mesh state (roster, DMs, identity, controls). */
  mesh: MeshState;
  /** Send a public (broadcast) mesh message. */
  send: (content: string) => Promise<void>;
  /** Send an encrypted 1:1 mesh direct message. */
  sendPrivate: (peer: MeshPeer, content: string) => Promise<void>;
}

export const MeshContext = createContext<MeshContextType | undefined>(undefined);
