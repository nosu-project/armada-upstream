import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNip65RelaySetup } from "@/hooks/useNip65RelaySetup";
import { toast } from "@/hooks/useToast";
import { normalizeRelayUrl } from "@/lib/platform";

export function RelayBootstrapForm({
  onDone,
  onSkip,
}: {
  onDone?: () => void;
  onSkip?: () => void;
}) {
  const { discover, adopt, publish } = useNip65RelaySetup();
  const inputId = useId();
  const [value, setValue] = useState("");
  const [checkedRelay, setCheckedRelay] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const normalized = normalizeRelayUrl(value);

  const find = async () => {
    if (!normalized) {
      setError("Enter a valid ws:// or wss:// relay URL.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setCheckedRelay(undefined);
    try {
      const found = await discover([normalized]);
      if (found) {
        adopt(found);
        toast({
          title: "Relay list restored",
          description: `Found ${found.relays.length} signed NIP-65 ${found.relays.length === 1 ? "relay" : "relays"}.`,
        });
        onDone?.();
      } else {
        setCheckedRelay(normalized);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Relay lookup failed.");
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!checkedRelay) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await publish([{ url: checkedRelay, read: true, write: true }]);
      toast({
        title: "Relay list published",
        description: result.rejected.length > 0
          ? `Accepted by ${result.accepted.length} relays; ${result.rejected.length} did not accept it.`
          : `Accepted by ${result.accepted.length} relays.`,
      });
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Relay-list publish failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full space-y-3 text-left">
      <div className="space-y-1.5">
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          Bootstrap relay
        </label>
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
          No signed relay list was found. Armada can publish <strong>{checkedRelay}</strong> as
          your read and write relay. This creates or replaces your NIP-65 list only after you
          approve the signature.
        </div>
      )}

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      {checkedRelay ? (
        <Button
          type="button"
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={create}
          disabled={busy}
        >
          Save and publish
        </Button>
      ) : (
        <Button
          type="button"
          size="lg"
          className="h-12 w-full clip-corner-lg text-base font-medium"
          onClick={find}
          disabled={busy || !value.trim()}
        >
          {busy ? "Looking…" : "Find my relay setup"}
        </Button>
      )}

      {onSkip && (
        <Button
          type="button"
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={onSkip}
          disabled={busy}
        >
          Not now
        </Button>
      )}
    </div>
  );
}
