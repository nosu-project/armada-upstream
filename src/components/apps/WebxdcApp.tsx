import { Blocks } from "lucide-react";

import { Webxdc } from "@/components/Webxdc";
import { useWebxdcApi, type AppSync } from "@/hooks/useWebxdcApi";
import { deriveIframeSubdomain } from "@/lib/iframeSubdomain";
import type { ImetaEncryption } from "@/lib/imeta";

/**
 * Runs a `.xdc` app in the cross-origin sandbox, backing `window.webxdc` with
 * {@link AppSync}. The sandbox subdomain derives privately from the session id
 * to isolate the app's origin-keyed storage.
 */
export function WebxdcApp({
  sync,
  url,
  sessionId,
  name,
  encryption,
}: {
  sync: AppSync;
  url: string;
  sessionId: string;
  name?: string;
  encryption?: ImetaEncryption;
}) {
  const api = useWebxdcApi(sync);
  const iframeId = deriveIframeSubdomain("webxdc", sessionId);

  return (
    <div className="relative w-full overflow-hidden rounded-lg bg-white" style={{ height: "min(70vh, 600px)" }}>
      <Webxdc
        id={iframeId}
        xdc={url}
        encryption={encryption}
        webxdc={api}
        title={name ?? "Webxdc app"}
        className="w-full h-full border-0"
      />
      <noscript>
        <div className="flex items-center gap-2 p-4 text-sm">
          <Blocks className="size-4" /> {name ?? "Webxdc app"}
        </div>
      </noscript>
    </div>
  );
}
