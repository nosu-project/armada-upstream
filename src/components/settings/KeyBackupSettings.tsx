import { Capacitor } from "@capacitor/core";
import { Check, Copy, Download, Eye, EyeOff, Share2 } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { saveNsec } from "@/lib/credentialManager";
import { share } from "@/lib/share";

interface KeyBackupSettingsProps {
  /** Bech32 nsec of the active login (only nsec logins expose a key). */
  nsec: string;
  /** Hex pubkey of the active login. */
  pubkey: string;
}

/**
 * "Keys" settings section: reveal, copy, and download the account's secret
 * key. Only nsec logins have a retrievable key. Remote (NIP-46), extension
 * (NIP-07) and Android-signer logins keep the key inside the signer, so
 * SettingsPage only renders this for nsec logins.
 */
export function KeyBackupSettings({ nsec, pubkey }: KeyBackupSettingsProps) {
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState<"nsec" | "npub" | null>(null);
  const npub = nip19.npubEncode(pubkey);

  const copy = async (text: string, which: "nsec" | "npub") => {
    try {
      await writeClipboardText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy to the clipboard. Please select and copy it manually.",
        variant: "destructive",
      });
    }
  };

  // Back the key up out of the app. On the web this offers the browser's
  // password manager (Chromium) or downloads a text file; on native, blob
  // downloads don't work in the WebView, so hand the key to the share sheet
  // (save to files, a notes app, a password manager…).
  const backup = async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        await share({
          title: "Armada secret key",
          text: nsec,
          dialogTitle: "Back up your secret key",
        });
      } else {
        await saveNsec(npub, nsec);
      }
    } catch {
      toast({
        title: "Backup failed",
        description: "Could not save the key. Please copy it manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <SettingsRow>
        <div className="clip-corner-lg bg-amber-500/10 p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-amber-600 dark:text-amber-300">
              Keep this key secret
            </span>
          </div>
          <p className="text-xs text-amber-700 dark:text-amber-300/90">
            Your secret key is the only way to access your account. There is no password reset.
            Anyone who sees it controls your identity. Store it somewhere safe, like a password
            manager.
          </p>
        </div>
      </SettingsRow>

      <SettingsRow>
        <div className="space-y-2">
          <div className="text-sm font-medium leading-tight">Secret key</div>
          <div className="relative">
            <Input
              type={showKey ? "text" : "password"}
              value={nsec}
              readOnly
              className="pr-10 font-mono bg-background/40 border-transparent"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
              onClick={() => setShowKey(!showKey)}
              aria-label={showKey ? "Hide secret key" : "Reveal secret key"}
            >
              {showKey ? (
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Eye className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => copy(nsec, "nsec")}
            >
              {copied === "nsec" ? (
                <Check className="size-4 text-success" />
              ) : (
                <Copy className="size-4" />
              )}
              Copy
            </Button>
            <Button variant="outline" className="flex-1" onClick={backup}>
              {Capacitor.isNativePlatform() ? (
                <Share2 className="size-4" />
              ) : (
                <Download className="size-4" />
              )}
              Back up
            </Button>
          </div>
        </div>
      </SettingsRow>

      <SettingsRow
        label="Public key"
        description="Your public identity, safe to share with anyone."
      >
        <Button
          variant="ghost"
          size="icon"
          className="size-9 touch:size-11"
          onClick={() => copy(npub, "npub")}
          aria-label="Copy public key"
        >
          {copied === "npub" ? (
            <Check className="size-4 text-success" />
          ) : (
            <Copy className="size-4" />
          )}
        </Button>
      </SettingsRow>
    </>
  );
}
