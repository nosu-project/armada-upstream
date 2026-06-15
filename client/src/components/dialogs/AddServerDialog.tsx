import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { normalizeRelayUrl, PLATFORM_RELAYS, relayToHttpUrl } from "@/lib/platform";

interface AddServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Add an internal relay to the server list. The URL is validated by fetching
 * its NIP-11 document before being persisted, so typos don't pollute the rail.
 */
export function AddServerDialog({ open, onOpenChange }: AddServerDialogProps) {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const handleAdd = async () => {
    setError(null);
    const normalized = normalizeRelayUrl(url);
    if (!normalized) {
      setError("Enter a valid ws:// or wss:// relay URL.");
      return;
    }
    if (PLATFORM_RELAYS.includes(normalized) || config.addedRelays.includes(normalized)) {
      setError("That server is already in your list.");
      return;
    }

    setChecking(true);
    try {
      const res = await fetch(relayToHttpUrl(normalized), {
        headers: { Accept: "application/nostr+json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
    } catch {
      setChecking(false);
      setError("Could not reach that relay's NIP-11 endpoint. Check the URL and your network.");
      return;
    }
    setChecking(false);

    // Update the local cache immediately for instant UI, then persist to the
    // user's NIP-29 server list (kind 10009 `r` tags) when signed in.
    updateConfig((current) => ({
      ...current,
      addedRelays: [...current.addedRelays, normalized],
    }));
    if (user) {
      updateList({ type: "add-server", url: normalized }).catch((err) =>
        console.warn("Failed to sync server to group list:", err));
    }
    toast({ title: "Server added", description: normalized });
    setUrl("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>
            Connect to another internal relay. Servers host their own channels and members.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="server-url">Relay URL</Label>
            <Input
              id="server-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="wss://relay.internal"
              autoComplete="off"
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Alert>
            <ShieldCheck className="size-4" />
            <AlertDescription>
              Pinned platform servers cannot be removed; servers you add here can be
              managed from Settings.
            </AlertDescription>
          </Alert>

          <DialogFooter>
            <Button type="submit" disabled={checking || !url.trim()}>
              {checking ? <><Loader2 className="size-4 mr-2 animate-spin" /> Checking…</> : "Add server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
