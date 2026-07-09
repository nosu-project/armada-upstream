import { MeshContext } from "@/contexts/MeshContext";
import { useMeshTransportState } from "@/hooks/useMeshTransport";

/**
 * Hosts the live Bluetooth-mesh state once, above the router, so the mesh
 * message/DM history and peer roster persist for the whole app session — moving
 * between chats and back to the Mesh page no longer drops the conversation. The
 * native BLE service keeps running regardless; this just keeps the web-side
 * accumulated history alive across `/mesh` route unmounts (the native side has
 * no history replay). History is intentionally session-scoped: it clears on a
 * full app restart/reload, matching the mesh's ephemeral nature.
 */
export function MeshProvider({ children }: { children: React.ReactNode }) {
  const value = useMeshTransportState();
  return <MeshContext.Provider value={value}>{children}</MeshContext.Provider>;
}
