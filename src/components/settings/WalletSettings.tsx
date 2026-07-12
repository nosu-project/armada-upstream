import { ArrowDown, ArrowUp, CheckCircle2, Circle, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

import { nwcWalletPubkey } from "@/lib/walletStorage";
import { DEFAULT_ESPLORA_APIS, readEsploraApis, writeEsploraApis } from "@/lib/esploraStorage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useToast } from "@/hooks/useToast";
import { useWallet } from "@/hooks/useWallet";

/**
 * Settings → Wallet: Nostr Wallet Connect management + zap preferences.
 *
 * The connection string is a SPENDING SECRET: it is validated, stored in
 * per-account local storage, and never rendered back — rows show only the
 * alias and the wallet service's pubkey prefix.
 */
export function WalletSettings() {
  const { connections, activeConnection, addConnection, removeConnection, setActive, webln } = useWallet();
  const { config, updateConfig } = useAppContext();
  const { toast } = useToast();
  const { user } = useCurrentUser();

  const [uri, setUri] = useState("");
  const [alias, setAlias] = useState("");
  const [connecting, setConnecting] = useState(false);

  const [esploraUrls, setEsploraUrls] = useState<string[]>(() => readEsploraApis(user?.pubkey));
  const [newEsplora, setNewEsplora] = useState("");

  const saveEsplora = (urls: string[]) => {
    const normalized = urls.map((u) => u.replace(/\/+$/, ""));
    setEsploraUrls(normalized);
    if (user) writeEsploraApis(user.pubkey, normalized);
  };

  const handleAddEsplora = () => {
    const url = newEsplora.trim().replace(/\/+$/, "");
    if (!url) return;
    if (esploraUrls.includes(url)) {
      toast({ title: "Already in the list" });
      return;
    }
    saveEsplora([...esploraUrls, url]);
    setNewEsplora("");
  };

  const handleMoveEsplora = (index: number, dir: -1 | 1) => {
    const next = [...esploraUrls];
    const swap = index + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[index], next[swap]] = [next[swap], next[index]];
    saveEsplora(next);
  };

  const handleRemoveEsplora = (index: number) => {
    if (esploraUrls.length <= 1) return;
    saveEsplora(esploraUrls.filter((_, i) => i !== index));
  };

  const handleResetEsplora = () => {
    saveEsplora([...DEFAULT_ESPLORA_APIS]);
  };

  const handleConnect = async () => {
    if (!uri.trim() || connecting) return;
    setConnecting(true);
    try {
      await addConnection(uri, alias);
      setUri("");
      setAlias("");
      toast({ title: "Wallet connected" });
    } catch (e) {
      toast({
        title: "Couldn't connect wallet",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setConnecting(false);
    }
  };

  return (
    <>
      <SettingsRow
        label="Enable zaps & wallet"
        description="Show zap buttons, the wallet dialog, and wallet settings. Synced across devices."
      >
        <Switch
          checked={config.zapsEnabled}
          onCheckedChange={(checked) => updateConfig((c) => ({ ...c, zapsEnabled: checked }))}
        />
      </SettingsRow>

      {config.zapsEnabled && (
        <>
      <SettingsRow>
        <div className="space-y-2">
          <div className="text-sm font-medium">Connect a wallet (NWC)</div>
          <p className="text-xs text-muted-foreground">
            Paste a Nostr Wallet Connect string from your wallet (Alby Hub, Coinos, Primal,
            lnbits…). It authorizes payments, so it stays on this device only — never synced.
          </p>
          <Input
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="nostr+walletconnect://…"
            type="password"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex gap-2">
            <Input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="Name (optional)"
              className="flex-1"
            />
            <Button onClick={handleConnect} disabled={!uri.trim() || connecting}>
              {connecting ? <Loader2 className="size-4 animate-spin" /> : "Connect"}
            </Button>
          </div>
        </div>
      </SettingsRow>

      {connections.map((connection) => {
        const isActive = connection.connectionString === activeConnection?.connectionString;
        return (
          <SettingsRow
            key={connection.connectionString}
            label={
              <span className="flex items-center gap-2">
                {connection.alias}
                {isActive && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                    active
                  </span>
                )}
              </span>
            }
            description={`Wallet service ${nwcWalletPubkey(connection.connectionString).slice(0, 12) || "unknown"}…`}
          >
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActive(connection.connectionString)}
                disabled={isActive}
                title={isActive ? "Active wallet" : "Use this wallet"}
              >
                {isActive ? <CheckCircle2 className="size-4 text-primary" /> : <Circle className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeConnection(connection.connectionString)}
                title="Remove wallet"
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
            </div>
          </SettingsRow>
        );
      })}

      <SettingsRow
        label="Browser wallet (WebLN)"
        description={
          webln
            ? "A WebLN extension is available; it's used when no NWC wallet is active."
            : "No WebLN extension detected in this browser."
        }
      >
        <span className={`text-xs font-medium ${webln ? "text-primary" : "text-muted-foreground"}`}>
          {webln ? "Detected" : "—"}
        </span>
      </SettingsRow>

      <SettingsRow
        label="Default zap amount"
        description="Preselected amount (sats) when you open the zap dialog."
      >
        <Input
          type="number"
          min={1}
          value={config.defaultZapAmount}
          onChange={(e) => {
            const n = Math.max(1, Math.floor(Number(e.target.value) || 0));
            updateConfig((current) => ({ ...current, defaultZapAmount: n }));
          }}
          className="w-28 text-right"
        />
      </SettingsRow>

      <SettingsRow>
        <div className="space-y-2">
          <div className="text-sm font-medium">Bitcoin explorers (Esplora)</div>
          <p className="text-xs text-muted-foreground">
            Blockchain data sources for on-chain zaps (UTXOs, fees, broadcast). Tried in
            order; the first that responds is used. Stays on this device only.
          </p>
          <div className="space-y-1">
            {esploraUrls.map((url, i) => (
              <div key={url} className="flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground w-16 shrink-0">
                  {i === 0 ? "Primary" : `Fallback ${i}`}
                </span>
                <span className="text-xs font-mono truncate flex-1">{url}</span>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => handleMoveEsplora(i, -1)} disabled={i === 0} title="Move up">
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => handleMoveEsplora(i, 1)} disabled={i === esploraUrls.length - 1} title="Move down">
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => handleRemoveEsplora(i)} disabled={esploraUrls.length <= 1} title="Remove">
                  <Trash2 className="size-3.5 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={newEsplora}
              onChange={(e) => setNewEsplora(e.target.value)}
              placeholder="https://mempool.space/api"
              className="flex-1"
            />
            <Button variant="outline" size="sm" onClick={handleAddEsplora} disabled={!newEsplora.trim()}>
              <Plus className="size-4" /> Add
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={handleResetEsplora} className="text-xs">
            <RotateCcw className="size-3.5" /> Restore defaults
          </Button>
        </div>
      </SettingsRow>
        </>
      )}
    </>
  );
}
