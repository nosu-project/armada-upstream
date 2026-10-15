import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Download, Eye, KeyRound, LogOut } from "lucide-react";
import { nip19 } from "nostr-tools";

import { Button } from "@/components/ui/button";
import {
  ChromeDialogContent,
  ChromeDialogFooter,
  ChromeDialogHeader,
  Dialog,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { backUpNsec } from "@/lib/credentialManager";
import { clearKeyBackupPending } from "@/lib/keyBackup";

interface BackupKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nsec: string;
  pubkey: string;
  /**
   * Logout mode: the dialog stands between "Log out" and an account that exists
   * nowhere else. Stays open after a backup so the user can finish logging out.
   */
  onLogout?: () => void;
}

/**
 * Back up a key signup minted without asking. Copy, file, keyring all count:
 * each clears the pending marker ({@link clearKeyBackupPending}).
 */
export function BackupKeyDialog({ open, onOpenChange, nsec, pubkey, onLogout }: BackupKeyDialogProps) {
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [backedUp, setBackedUp] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShowKey(false);
    setCopied(false);
    setBackedUp(false);
  }, [open]);

  const done = () => {
    setBackedUp(true);
    clearKeyBackupPending(pubkey);
    if (!onLogout) onOpenChange(false);
  };

  const copyKey = async () => {
    try {
      await writeClipboardText(nsec);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Key copied", description: "Paste it somewhere safe, like a password manager." });
      done();
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy to the clipboard. Please select and copy it manually.",
        variant: "destructive",
      });
    }
  };

  // "Save as…" on web, Credential Manager on Android, Files on iOS.
  const saveKey = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await backUpNsec(nip19.npubEncode(pubkey), nsec);
      if (result.status === "cancelled") return;
      if (result.status === "failed") {
        toast({
          title: "Couldn't save your key",
          description: "Saving failed. Reveal your key, copy it, and store it somewhere safe.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Key saved",
        description: `Saved to ${result.location}. Keep it safe. It's your only login.`,
      });
      done();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={onLogout ? "Back up before logging out" : "Back up your secret key"}>
        <ChromeDialogHeader
          icon={onLogout ? LogOut : KeyRound}
          tone={onLogout ? "destructive" : "primary"}
          title={onLogout ? "back up before logging out" : "back up your secret key"}
          description={
            onLogout
              ? "Your key isn't backed up anywhere. Log out without it and this account is gone for good."
              : "Your account lives only on this device. Save your key so you can sign in anywhere, and never lose it."
          }
        />

        <div className="mt-5 space-y-4">
          <div className="clip-corner-lg bg-destructive/10 p-3.5 text-left">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-px size-4 shrink-0 text-destructive" />
              <div className="space-y-1">
                <p className="text-xs font-bold uppercase tracking-widest text-destructive">
                  This key is your only login
                </p>
                <p className="text-xs leading-relaxed text-destructive/90">
                  There's no email or password, and it can't be reset. Anyone you share it
                  with can act as you.
                </p>
              </div>
            </div>
          </div>

          {/* Reveal, then copy. No hide: that would only remove the copy button. */}
          <div className="relative w-full">
            <Input
              type={showKey ? "text" : "password"}
              value={nsec}
              readOnly
              className="pr-10 font-mono bg-background border-transparent"
            />
            {showKey ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                onClick={copyKey}
                aria-label={copied ? "Key copied" : "Copy key"}
                title={copied ? "Copied" : "Copy key"}
              >
                {copied ? (
                  <Check className="size-4 text-success" />
                ) : (
                  <Copy className="size-4 text-muted-foreground" />
                )}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                onClick={() => setShowKey(true)}
                aria-label="Show key"
                title="Show key"
              >
                <Eye className="size-4 text-muted-foreground" />
              </Button>
            )}
          </div>

          <Button
            type="button"
            size="lg"
            variant={backedUp ? "secondary" : "default"}
            className="h-12 w-full clip-corner-lg text-base font-medium"
            onClick={saveKey}
            disabled={saving}
          >
            <Download className="size-4" />
            {saving ? "Saving…" : "Save key"}
          </Button>
        </div>

        <ChromeDialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {onLogout ? "Cancel" : "Later"}
          </Button>
          {onLogout && (
            <Button
              type="button"
              variant={backedUp ? "default" : "destructive"}
              onClick={onLogout}
            >
              {backedUp ? "Log out" : "Log out anyway"}
            </Button>
          )}
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}
