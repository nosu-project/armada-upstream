import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { usePullPortableSetup } from "@/hooks/usePullPortableSetup";
import { usePublishPortableSetup } from "@/hooks/usePublishPortableSetup";
import { toast } from "@/hooks/useToast";

/** Settings › Account › Sync: private-settings sync and the portable-setup push/pull. */
export function SyncSettings() {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const portablePull = usePullPortableSetup();
  const portableSetup = usePublishPortableSetup();

  // The user's published NIP-65 list, ignored when it belongs to another login.
  const ownsRelayList =
    !config.relayMetadata.pubkey || config.relayMetadata.pubkey === user?.pubkey;
  const userWriteRelayUrls = ownsRelayList
    ? config.relayMetadata.relays.filter((r) => r.write).map((r) => r.url)
    : [];

  const setAutomaticSettingsSync = (automaticSettingsSync: boolean) => {
    updateConfig((current) => ({ ...current, automaticSettingsSync }));
  };

  const pull = () => {
    portablePull.pull().then((result) => {
      toast({
        title: "Setup refreshed",
        description: `${result.records} signed ${result.records === 1 ? "record was" : "records were"} read from ${result.sources} account ${result.sources === 1 ? "relay" : "relays"}${result.voiceServer ? ", including your voice server" : ""}.`,
      });
    }).catch((err) => {
      toast({
        title: "Setup could not be refreshed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    });
  };

  const publish = () => {
    portableSetup.publish().then((result) => {
      const skipped = result.unrefreshed.length;
      const partial = result.rejectedDeliveries > 0 || skipped > 0;
      const details = [
        result.rejectedDeliveries > 0
          ? `${result.rejectedDeliveries} ${result.rejectedDeliveries === 1 ? "delivery was" : "deliveries were"} rejected`
          : undefined,
        skipped > 0
          ? `${skipped} locally known settings ${skipped === 1 ? "document was" : "documents were"} left unchanged because no relay returned a safe base`
          : undefined,
      ].filter((detail): detail is string => Boolean(detail));
      toast({
        title: partial
          ? "Setup partially synchronized"
          : "Setup synchronized",
        description: partial
          ? `${result.records} signed records were sent to ${result.destinations} account relays; ${details.join("; ")}. Retry once every account relay is reachable.`
          : `${result.records} signed records are available on ${result.destinations} account relays.`,
        variant: partial ? "destructive" : undefined,
      });
    }).catch((err) => {
      toast({
        title: "Setup was not fully synchronized",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    });
  };

  return (
    <SettingsGroup
      id="sync"
      title="Sync"
      footer={userWriteRelayUrls.length === 0
        ? "Publish a relay list under Relays › Home to sync across devices."
        : undefined}
      info={userWriteRelayUrls.length === 0
        ? "Publishing a relay list lets Armada copy your lists, settings and communities to your other devices. Device, audio and wallet settings always stay on this device."
        : "Device, audio and wallet settings always stay on this device."}
    >
      <SettingsRow
        label="Automatic settings sync"
        description="Keep settings and your DM list the same everywhere."
        info="Keeps private settings and your DM list the same on your other devices. This switch applies to this device only."
      >
        <Switch
          checked={config.automaticSettingsSync !== false}
          onCheckedChange={setAutomaticSettingsSync}
        />
      </SettingsRow>
      {userWriteRelayUrls.length > 0 && (
        <SettingsRow
          stack
          label={portableSetup.isConfigured ? "Synchronize setup" : "Set up synchronization"}
          description={portableSetup.isConfigured
            ? portableSetup.isAutomatic
              ? "Your setup syncs automatically."
              : "Private settings wait for Sync now."
            : "Copy your setup to your relays."}
          info={portableSetup.isConfigured
            ? portableSetup.isAutomatic
              ? "Sync now pushes your setup to every relay again. Pull latest reads it back."
              : "Communities and servers sync on their own; private settings are sent only when you tap Sync now."
            : "Copies your lists, settings and communities to the relays in your published (NIP-65) relay list."}
        >
          <div className="grid w-full gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="secondary"
              className="h-10 clip-corner-lg touch:h-11"
              disabled={portablePull.isPending || portableSetup.isPending}
              onClick={pull}
            >
              {portablePull.isPending ? "Pulling…" : "Pull latest"}
            </Button>
            <Button
              type="button"
              className="h-10 clip-corner-lg touch:h-11"
              disabled={portableSetup.isPending || portableSetup.isStatusLoading || portablePull.isPending}
              onClick={publish}
            >
              {portableSetup.isPending
                ? "Synchronizing…"
                : portableSetup.isConfigured
                  ? "Sync now"
                  : "Start sync"}
            </Button>
          </div>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
