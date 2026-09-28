import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Native bridge to the Android-only Bluetooth mesh (vendored bitchat, via
 * `BluetoothMeshPlugin.java`); Web Bluetooth can't do the needed dual role.
 * Identity stays bitchat-native; only the nickname comes from the Nostr profile.
 */
export interface MeshMessage {
  /** Stable message id (uppercase UUID, from the wire payload). */
  id: string;
  sender: string;
  content: string;
  /** Epoch milliseconds. */
  timestamp: number;
  /** 8-byte (16-hex) mesh peer id of the sender, if known. */
  senderPeerID: string | null;
  /** Channel name (`#name`) if the message was sent to one; null = public. */
  channel: string | null;
  isPrivate: boolean;
}

export interface MeshPeer {
  peerID: string;
  nickname: string;
  isConnected?: boolean;
  isDirectConnection?: boolean;
  isVerified?: boolean;
  lastSeen?: number;
  noisePublicKey?: string;
}

export interface BluetoothMeshPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  /** Nickname announced on the mesh (the Nostr display name); persisted natively. */
  setNickname(options: { nickname: string }): Promise<void>;
  /** Request BLE permissions and start the mesh + foreground service. */
  start(): Promise<{ peerID: string }>;
  stop(): Promise<void>;
  /** Send a public (broadcast) mesh message, flooded over BLE with TTL. */
  sendMessage(options: { content: string }): Promise<void>;
  /** Send an encrypted 1:1 mesh direct message using bitchat Noise sessions. */
  sendPrivateMessage(options: {
    content: string;
    peerID: string;
    nickname?: string;
    messageID?: string;
  }): Promise<void>;
  getPeers(): Promise<{ peers: MeshPeer[] }>;

  /** A message was received off the mesh (public, channel, or decrypted DM). */
  addListener(
    eventName: "message",
    listener: (data: MeshMessage) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "peers",
    listener: (data: { peers: MeshPeer[] }) => void,
  ): Promise<PluginListenerHandle>;
  /** A delivery ack arrived for one of our sent messages. */
  addListener(
    eventName: "deliveryAck",
    listener: (data: { messageID: string; peerID: string }) => void,
  ): Promise<PluginListenerHandle>;
  /** A read receipt arrived for one of our sent messages. */
  addListener(
    eventName: "readReceipt",
    listener: (data: { messageID: string; peerID: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const BluetoothMesh = registerPlugin<BluetoothMeshPlugin>("BluetoothMesh");
