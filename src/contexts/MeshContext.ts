import { createContext } from "react";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { MeshPeer } from "@/lib/bluetoothMesh";

/**
 * Live Bluetooth-mesh state. Its provider (`components/MeshProvider.tsx`) sits
 * ABOVE the router so history survives leaving `/mesh` — the native service has
 * no history replay.
 */
export interface MeshState {
  /** Whether the platform can run the BLE mesh (Android only). */
  available: boolean;
  /** True while the availability probe is still resolving (app boot). */
  probing: boolean;
  /** Whether mesh chat is on (persisted, off by default: permissions + foreground service). */
  enabled: boolean;
  started: boolean;
  /** This device's mesh peer id, once started. */
  myPeerID: string | null;
  peers: MeshPeer[];
  /** Direct-message histories keyed by mesh peer id. */
  directMessages: Record<string, ChatMsg[]>;
  /** A startup/permission error, if any. */
  error: string | null;
  /** Incognito: announce `anon<peerid>` instead of the display name. */
  incognito: boolean;
  /** The nickname this device is currently announcing on the mesh. */
  myNickname: string;
  /** Manually (re)start the mesh (e.g. after granting permission). */
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Turn mesh chat on/off (persisted). Off also stops a running mesh. */
  setEnabled: (enabled: boolean) => void;
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
