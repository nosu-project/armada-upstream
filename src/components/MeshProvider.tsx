import { MeshContext } from "@/contexts/MeshContext";
import { useMeshTransportState } from "@/hooks/useMeshTransport";

/**
 * Hosts Bluetooth-mesh state above the router so history and peers survive
 * `/mesh` unmounts (native has no history replay). Session-scoped by design.
 */
export function MeshProvider({ children }: { children: React.ReactNode }) {
  const value = useMeshTransportState();
  return <MeshContext.Provider value={value}>{children}</MeshContext.Provider>;
}
