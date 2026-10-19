import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { usePullPortableSetup } from "@/hooks/usePullPortableSetup";
import { usePublishPortableSetup } from "@/hooks/usePublishPortableSetup";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";

/** Settings › Account › Sync: private-settings sync and the portable-setup push/pull. */
export function SyncSettings() {
  const intl = useIntl();
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
        title: t({ id: "syncSettings.refreshed", defaultMessage: "Setup refreshed" }),
        description: result.voiceServer
          ? t({ id: "syncSettings.refreshedDescriptionVoice", defaultMessage: "{records, plural, one {# signed record was} other {# signed records were}} read from {sources, plural, one {# account relay} other {# account relays}}, including your voice server." }, { records: result.records, sources: result.sources })
          : t({ id: "syncSettings.refreshedDescription", defaultMessage: "{records, plural, one {# signed record was} other {# signed records were}} read from {sources, plural, one {# account relay} other {# account relays}}." }, { records: result.records, sources: result.sources }),
      });
    }).catch((err) => {
      toast({
        title: t({ id: "syncSettings.refreshFailed", defaultMessage: "Setup could not be refreshed" }),
        description: err instanceof Error ? err.message : t({ id: "syncSettings.pleaseTryAgain", defaultMessage: "Please try again." }),
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
          ? t({ id: "syncSettings.rejectedDeliveries", defaultMessage: "{count, plural, one {# delivery was} other {# deliveries were}} rejected" }, { count: result.rejectedDeliveries })
          : undefined,
        skipped > 0
          ? t({ id: "syncSettings.skippedDocuments", defaultMessage: "{count, plural, one {# locally known settings document was} other {# locally known settings documents were}} left unchanged because no relay returned a safe base" }, { count: skipped })
          : undefined,
      ].filter((detail): detail is string => Boolean(detail));
      toast({
        title: partial
          ? t({ id: "syncSettings.partial", defaultMessage: "Setup partially synchronized" })
          : t({ id: "syncSettings.synchronized", defaultMessage: "Setup synchronized" }),
        description: partial
          ? t({ id: "syncSettings.partialDescription", defaultMessage: "{records} signed records were sent to {destinations} account relays; {details}. Retry once every account relay is reachable." }, { records: result.records, destinations: result.destinations, details: details.join("; ") })
          : t({ id: "syncSettings.synchronizedDescription", defaultMessage: "{records} signed records are available on {destinations} account relays." }, { records: result.records, destinations: result.destinations }),
        variant: partial ? "destructive" : undefined,
      });
    }).catch((err) => {
      toast({
        title: t({ id: "syncSettings.publishFailed", defaultMessage: "Setup was not fully synchronized" }),
        description: err instanceof Error ? err.message : t({ id: "syncSettings.pleaseTryAgain", defaultMessage: "Please try again." }),
        variant: "destructive",
      });
    });
  };

  return (
    <SettingsGroup
      id="sync"
      title={intl.formatMessage({ id: "syncSettings.title", defaultMessage: "Sync" })}
      footer={userWriteRelayUrls.length === 0
        ? intl.formatMessage({ id: "syncSettings.noRelayListFooter", defaultMessage: "Publish a relay list under Relays › Home to sync across devices." })
        : undefined}
      info={userWriteRelayUrls.length === 0
        ? intl.formatMessage({ id: "syncSettings.noRelayListInfo", defaultMessage: "Publishing a relay list lets Armada copy your lists, settings and communities to your other devices. Device, audio and wallet settings always stay on this device." })
        : intl.formatMessage({ id: "syncSettings.localInfo", defaultMessage: "Device, audio and wallet settings always stay on this device." })}
    >
      <SettingsRow
        label={intl.formatMessage({ id: "syncSettings.automatic", defaultMessage: "Automatic settings sync" })}
        description={intl.formatMessage({ id: "syncSettings.automaticDescription", defaultMessage: "Keep settings and your DM list the same everywhere." })}
        info={intl.formatMessage({ id: "syncSettings.automaticInfo", defaultMessage: "Keeps private settings and your DM list the same on your other devices. This switch applies to this device only." })}
      >
        <Switch
          checked={config.automaticSettingsSync !== false}
          onCheckedChange={setAutomaticSettingsSync}
        />
      </SettingsRow>
      {userWriteRelayUrls.length > 0 && (
        <SettingsRow
          stack
          label={portableSetup.isConfigured
            ? intl.formatMessage({ id: "syncSettings.synchronize", defaultMessage: "Synchronize setup" })
            : intl.formatMessage({ id: "syncSettings.setUp", defaultMessage: "Set up synchronization" })}
          description={portableSetup.isConfigured
            ? portableSetup.isAutomatic
              ? intl.formatMessage({ id: "syncSettings.automaticStatus", defaultMessage: "Your setup syncs automatically." })
              : intl.formatMessage({ id: "syncSettings.manualStatus", defaultMessage: "Private settings wait for Sync now." })
            : intl.formatMessage({ id: "syncSettings.unconfiguredStatus", defaultMessage: "Copy your setup to your relays." })}
          info={portableSetup.isConfigured
            ? portableSetup.isAutomatic
              ? intl.formatMessage({ id: "syncSettings.automaticInfoDetail", defaultMessage: "Sync now pushes your setup to every relay again. Pull latest reads it back." })
              : intl.formatMessage({ id: "syncSettings.manualInfo", defaultMessage: "Communities and servers sync on their own; private settings are sent only when you tap Sync now." })
            : intl.formatMessage({ id: "syncSettings.unconfiguredInfo", defaultMessage: "Copies your lists, settings and communities to the relays in your published (NIP-65) relay list." })}
        >
          <div className="grid w-full gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="secondary"
              className="h-10 clip-corner-lg touch:h-11"
              disabled={portablePull.isPending || portableSetup.isPending}
              onClick={pull}
            >
              {portablePull.isPending
                ? <FormattedMessage id="syncSettings.pulling" defaultMessage="Pulling…" />
                : <FormattedMessage id="syncSettings.pullLatest" defaultMessage="Pull latest" />}
            </Button>
            <Button
              type="button"
              className="h-10 clip-corner-lg touch:h-11"
              disabled={portableSetup.isPending || portableSetup.isStatusLoading || portablePull.isPending}
              onClick={publish}
            >
              {portableSetup.isPending
                ? <FormattedMessage id="syncSettings.synchronizing" defaultMessage="Synchronizing…" />
                : portableSetup.isConfigured
                  ? <FormattedMessage id="syncSettings.syncNow" defaultMessage="Sync now" />
                  : <FormattedMessage id="syncSettings.startSync" defaultMessage="Start sync" />}
            </Button>
          </div>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
