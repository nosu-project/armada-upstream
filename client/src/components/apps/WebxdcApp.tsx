import { Blocks } from "lucide-react";

import { Webxdc } from "@/components/Webxdc";
import { useWebxdcApi, type AppSync } from "@/hooks/useWebxdcApi";
import { deriveIframeSubdomain } from "@/lib/iframeSubdomain";

/**
 * Runs a `.xdc` webxdc app inside the cross-origin sandbox, backing its
 * `window.webxdc` API with the chat's {@link AppSync} coordination plane. The
 * sandbox subdomain is derived privately from the session id so the app's
 * origin-keyed storage is isolated from every other app and from Armada itself.
 */
export function WebxdcApp({
  sync,
  url,
  sessionId,
  name,
}: {
  sync: AppSync;
  url: string;
  sessionId: string;
  name?: string;
}) {
  const api = useWebxdcApi(sync);
  const iframeId = deriveIframeSubdomain("webxdc", sessionId);

  return (
    <div className="relative w-full overflow-hidden rounded-lg bg-white" style={{ height: "min(70vh, 600px)" }}>
      <Webxdc
        id={iframeId}
        xdc={url}
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
