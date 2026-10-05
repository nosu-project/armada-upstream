import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle } from "lucide-react";
import { Capacitor } from "@capacitor/core";

import { Button } from "@/components/ui/button";

/**
 * Landing page for the nostrconnect:// `callback` URL after a remote signer
 * approves. Native: navigate home after a delay so the NIP-46 handshake
 * subscription can persist the auth event. Web: the original tab completes it;
 * this tab can be closed.
 */
export function RemoteLoginSuccessPage() {
  const navigate = useNavigate();
  const isNative = Capacitor.isNativePlatform();

  useEffect(() => {
    if (!isNative) return;
    const timer = setTimeout(() => navigate("/", { replace: true }), 1500);
    return () => clearTimeout(timer);
  }, [isNative, navigate]);

  return (
    <main className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center px-8 space-y-4 max-w-sm">
        <CheckCircle className="w-16 h-16 text-green-500 mx-auto" />
        <h1 className="text-2xl font-bold">Login approved</h1>
        {isNative ? (
          <p className="text-muted-foreground">Taking you back to the app&hellip;</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Your signer approved the connection. You can close this tab and return to the app.
            </p>
            <Button onClick={() => navigate("/", { replace: true })}>
              Go home
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
