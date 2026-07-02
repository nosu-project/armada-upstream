import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

/**
 * Captures the browser's `beforeinstallprompt` event so the app can trigger
 * the PWA install dialog at a time of our choosing instead of the default
 * browser UI.
 *
 * Returns:
 *  - `canInstall`  — true when the browser has queued a deferred prompt (i.e.
 *                    the app meets install criteria and hasn't been installed yet).
 *  - `install()`   — call to show the install dialog; resolves with the user's
 *                    choice ("accepted" | "dismissed").
 *  - `isInstalled` — true when running as a standalone PWA (already installed).
 */
export function useInstallPrompt() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(
    () => window.matchMedia("(display-mode: standalone)").matches,
  );

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handler);

    // Once the app is installed, clear the deferred prompt.
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

  return { canInstall: !!prompt, install, isInstalled };
}
