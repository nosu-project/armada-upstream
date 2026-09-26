import { HelpCircle } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { RelayListEditor } from "@/components/RelayListEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  ExistingRelayListError,
  relayListAbsenceConfirmed,
  useNip65RelaySetup,
} from "@/hooks/useNip65RelaySetup";
import { toast } from "@/hooks/useToast";
import { normalizeRelayUrl } from "@/lib/platform";
import type { RelayListDiscovery, RelayPreference } from "@/lib/nip65";

const EMPTY_RELAY_PREFERENCES: RelayPreference[] = [];

export function RelayBootstrapForm({
  onDone,
  onSkip,
}: {
  onDone?: () => void;
  onSkip?: () => void;
}) {
  const { discoverWithStatus, adopt, publish } = useNip65RelaySetup();
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const inputId = useId();
  const [value, setValue] = useState("");
  const [checkedRelay, setCheckedRelay] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ownsRelayList = config.relayMetadata.pubkey === user?.pubkey;
  const currentRelays = ownsRelayList
    ? config.relayMetadata.relays
    : EMPTY_RELAY_PREFERENCES;
  const [editedRelays, setEditedRelays] = useState<string[]>(() =>
    currentRelays.map((relay) => relay.url),
  );

  useEffect(() => {
    setEditedRelays(currentRelays.map((relay) => relay.url));
  }, [currentRelays, user?.pubkey]);

  const normalized = normalizeRelayUrl(value);

  const restore = (found: RelayListDiscovery) => {
    adopt(found);
    toast({
      title: "Setup found",
      description: `Restored ${found.relays.length} ${found.relays.length === 1 ? "relay" : "relays"} for your account.`,
    });
    onDone?.();
  };

  const find = async () => {
    if (!normalized) {
      setError("Enter a relay address that starts with wss://.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setCheckedRelay(undefined);
    try {
      const read = await discoverWithStatus([normalized]);
      if (read.discovery) {
        restore(read.discovery);
      } else if (relayListAbsenceConfirmed(read.answered, [normalized, ...config.appRelays])) {
        // "Use this relay" would write there and to the app relays, so all of
        // them must have answered before "not found" means "none exists".
        setCheckedRelay(normalized);
      } else {
        setError(
          "Couldn't reach enough relays to confirm your account has no saved setup yet. Check the address and try again.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't look that up. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const create = async (urls: string[]) => {
    if (urls.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await publish(urls.map((url) => ({ url, read: true, write: true })));
      toast({
        title: "Saved",
        description: result.rejected.length > 0
          ? `Saved on ${result.accepted.length} ${result.accepted.length === 1 ? "relay" : "relays"}; ${result.rejected.length} didn't accept it.`
          : `Saved on ${result.accepted.length} ${result.accepted.length === 1 ? "relay" : "relays"}.`,
      });
      onDone?.();
    } catch (err) {
      if (err instanceof ExistingRelayListError) {
        restore(err.discovery);
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  // The app's relays are a new list only once the wire affirmatively has none:
  // look for an existing one first (the app relays plus the discovery
  // indexes), adopt it if found, and refuse to publish on a read too thin to
  // tell "no list" from "couldn't reach the relays that hold it".
  const chooseAppRelays = async () => {
    const urls = config.appRelays;
    if (urls.length === 0) return;
    setBusy(true);
    setError(undefined);
    setCheckedRelay(undefined);
    let read: Awaited<ReturnType<typeof discoverWithStatus>>;
    try {
      read = await discoverWithStatus(urls);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't look up your setup. Try again.");
      setBusy(false);
      return;
    }
    if (read.discovery) {
      setBusy(false);
      restore(read.discovery);
      return;
    }
    if (!relayListAbsenceConfirmed(read.answered, urls)) {
      setError(
        "Couldn't reach enough relays to confirm your account has no saved setup yet. Try again, or look up a relay you've used before.",
      );
      setBusy(false);
      return;
    }
    await create(urls);
  };

  const saveExisting = async () => {
    if (editedRelays.length === 0) {
      setError("Keep at least one relay so your account can be found on your other devices.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await publish(editedRelays.map((url) => {
        const existing = currentRelays.find((relay) => relay.url === url);
        return existing ?? { url, read: true, write: true };
      }));
      toast({
        title: "Saved",
        description: result.rejected.length > 0
          ? `Saved on ${result.accepted.length} ${result.accepted.length === 1 ? "relay" : "relays"}; ${result.rejected.length} didn't accept it.`
          : `Saved on ${result.accepted.length} ${result.accepted.length === 1 ? "relay" : "relays"}.`,
      });
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (currentRelays.length > 0) {
    return (
      <div className="w-full space-y-3 text-left">
        <RelayListEditor
          relays={editedRelays}
          onChange={(relays) => {
            setEditedRelays(relays);
            setError(undefined);
          }}
          emptyText="Add at least one relay before saving."
        />
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button
          type="button"
          className="h-11 w-full clip-corner-lg touch:h-12"
          onClick={() => void saveExisting()}
          disabled={busy || editedRelays.length === 0}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full space-y-3 text-left">
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
            Relay address
          </label>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="What is a relay address?"
                className="-m-1.5 flex size-7 items-center justify-center rounded-full p-1.5 text-muted-foreground/60 hover:text-muted-foreground touch:size-11"
              >
                <HelpCircle className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              className="max-w-64 text-xs leading-relaxed text-muted-foreground"
            >
              A relay is a server that stores your account's data. If you've used Armada or
              another Nostr app before, enter a relay you used. It looks like{" "}
              <span className="font-mono text-foreground">wss://relay.example.com</span>. Not
              sure? You can skip this; Armada still works with its built-in relays.
            </PopoverContent>
          </Popover>
        </div>
        <Input
          id={inputId}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setCheckedRelay(undefined);
            setError(undefined);
          }}
          placeholder="wss://relay.example.com"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-12 bg-background/50 font-mono text-base"
        />
      </div>

      {checkedRelay && (
        <div className="clip-corner-lg bg-secondary/50 p-3 text-xs leading-relaxed text-muted-foreground">
          We didn't find a saved setup on that relay. You can start fresh here. Armada will
          remember <strong>{checkedRelay}</strong> as your account's home so your servers and
          settings follow you to your other devices. Nothing is saved until you confirm.
        </div>
      )}

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      {checkedRelay ? (
        <Button
          type="button"
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={() => void create([checkedRelay])}
          disabled={busy}
        >
          Use this relay
        </Button>
      ) : (
        <Button
          type="button"
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={find}
          disabled={busy || !value.trim()}
        >
          {busy ? "Looking…" : "Look up my setup"}
        </Button>
      )}

      {config.appRelays.length > 0 && (
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="secondary"
            className="h-11 w-full clip-corner-lg touch:h-12"
            onClick={() => void chooseAppRelays()}
            disabled={busy}
          >
            Use this app's relays
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Checks for an existing setup first; if there is none, saves{" "}
            {config.appRelays.map((url, index) => (
              <span key={url}>
                {index > 0 && ", "}
                <span className="font-mono text-foreground">{url.replace(/^wss?:\/\//, "").replace(/\/$/, "")}</span>
              </span>
            ))}{" "}
            as your account's home so your servers and settings follow you to your other
            devices.
          </p>
        </div>
      )}

      {onSkip && (
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={onSkip}
            disabled={busy}
          >
            Skip for now
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Armada keeps working with its default relays. You can set up your own anytime in
            Settings.
          </p>
        </div>
      )}
    </div>
  );
}
