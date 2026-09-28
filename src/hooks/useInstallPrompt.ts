import { useEffect, useState } from "react";

import { isIOS, isStandalonePwa } from "@/lib/platform";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

/**
 * Captures `beforeinstallprompt` so the app can trigger the PWA install dialog itself.
 * `needsManualInstall`: iOS has no programmatic prompt; show Share → Add to Home Screen.
 */
export function useInstallPrompt() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(isStandalonePwa);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handler);

    const installed = () => {
      setPrompt(null);
      setIsInstalled(true);
    };
    window.addEventListener("appinstalled", installed);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  const install = async (): Promise<"accepted" | "dismissed" | null> => {
    if (!prompt) return null;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    setPrompt(null);
    return outcome;
  };

  return {
    canInstall: !!prompt,
    install,
    isInstalled,
    needsManualInstall: isIOS() && !isInstalled,
  };
}
