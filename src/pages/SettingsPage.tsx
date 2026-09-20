import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  ChevronDown,
  Compass,
  Download,
  FileText,
  Image,
  KeyRound,
   Link2,
  MessageSquare,
  MessageSquareLock,
  Mic,
  Monitor,
  Palette,
  ScrollText,
  Search,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smile,
  UserCircle,
  UserX,
  Waypoints,
  Zap,
} from "lucide-react";
import { useNostrLogin } from "@nostrify/react/login";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { lazy, Suspense } from "react";

import { LoginArea } from "@/components/auth/LoginArea";
import { BlossomServerListEditor } from "@/components/BlossomServerListEditor";
import { AccountStandingDialog } from "@/components/settings/AccountStandingDialog";
import { EmojiPackSettings } from "@/components/settings/EmojiPackSettings";
import { ProfileSettings } from "@/components/ProfileSettings";
import { NotificationSettings } from "@/components/NotificationSettings";
import { RelayListEditor } from "@/components/RelayListEditor";
import { RelayBootstrapForm } from "@/components/RelayBootstrapForm";
import { DesktopSettings } from "@/components/settings/DesktopSettings";
import { KeyBackupSettings } from "@/components/settings/KeyBackupSettings";
import { MediaPrivacySettings } from "@/components/settings/MediaPrivacySettings";
import { MutedPeopleSettings } from "@/components/settings/MutedPeopleSettings";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { WalletSettings } from "@/components/settings/WalletSettings";
import { ThemeSelector } from "@/components/ThemeSelector";
import { VoiceDeviceSettings } from "@/components/VoiceDeviceSettings";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useBlossomServerList } from "@/hooks/useBlossomServerList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { usePullPortableSetup } from "@/hooks/usePullPortableSetup";
import { usePublishPortableSetup } from "@/hooks/usePublishPortableSetup";
import { useSearchRelayList } from "@/hooks/useSearchRelayList";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { isDesktop } from "@/lib/desktop";
import { APP_BLOSSOM_SERVERS } from "@/lib/blossom";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { STOCK_RELAYS } from "@/concord/lib/stockRelays";
import { APP_RELAYS, BROADCAST_RELAYS, DM_RELAYS, SEARCH_RELAYS } from "@/lib/platform";
import {
  getAudioProcessing,
  setAudioProcessing,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";
import { rnnoiseSupported } from "@/lib/rnnoiseSupport";
import { sendsOnEnter } from "@/lib/sendOnEnter";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

const RequestToVanishDialog = lazy(() =>
  import("@/components/RequestToVanishDialog").then((m) => ({ default: m.RequestToVanishDialog })),
);

type SectionId =
  | "account"
  | "standing"
  | "keys"
  | "profile"
  | "notifications"
  | "muted"
  | "appearance"
  | "desktop"
  | "voice"
  | "servers"
  | "app-relays"
  | "community-relays"
  | "search-relays"
  | "dms"
  | "chat"
  | "media"
  | "links"
  | "discover"
  | "emojis"
  | "wallet"
  | "install"
  | "danger";

interface NavItem {
  id: SectionId;
  title: string;
  icon: LucideIcon;
  /**
   * Render this section's row(s) directly in the list (no collapsible
   * header). Used for single-item sections — Account (the login pill), About
   * (one link row), and Advanced (whose one row is already its own
   * collapsible) — where a header would just hide a single tap target.
   */
  inline?: boolean;
  /**
   * Open something instead of expanding. The entry still renders as a section
   * header (icon, title, chevron) so it sits in the list like its neighbours;
   * only what happens on tap differs.
   */
  action?: () => void;
}

/**
 * The row that heads a section. Shared by the collapsible sections and the
 * ones that open a dialog, so the two can't drift apart visually.
 */
const SECTION_HEADER_CLASS =
  "flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/40";

interface NavGroup {
  heading: string;
  items: NavItem[];
}

/**
 * App settings: one scrolling list (same format on every viewport). Sections
 * with multiple controls sit behind a collapsible header (icon + title,
 * expands in place); single-item sections render their row directly.
 */
export function SettingsPage() {
  const navigate = useNavigate();
  // Deep-linked section (e.g. /settings#profile from the account switcher's
  // "Edit profile"): that section renders expanded and is scrolled into view.
  const targetSection = useLocation().hash.slice(1);
  useEffect(() => {
    if (!targetSection) return;
    document.getElementById(`settings-${targetSection}`)?.scrollIntoView({ block: "start" });
  }, [targetSection]);
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();
  const { logins } = useNostrLogin();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const servers = useNip29Servers();
  const dmRelayList = useDmRelayList();
  const blossomServerList = useBlossomServerList();
  const searchRelayList = useSearchRelayList();
  const portablePull = usePullPortableSetup();
  const portableSetup = usePublishPortableSetup();

  // Voice mic-processing prefs are device-local (stored in localStorage, not
  // synced AppConfig — a setting right for a laptop mic is wrong on a phone).
  // Mirror the in-call gear menu; changes apply to the next captured mic track
  // (and live mid-call, since the gear menu restarts the track on change).
  const [voiceProcessing, setVoiceProcessing] = useState<AudioProcessingPrefs>(() =>
    getAudioProcessing(),
  );
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [standingOpen, setStandingOpen] = useState(false);

  /**
   * Opening Account Standing retires its nag dot for good. Written on the way
   * in rather than on close, so a dismissed dialog doesn't nag again.
   */
  const openStanding = useCallback(() => {
    setStandingOpen(true);
    updateConfig((current) =>
      current.accountStandingSeen ? current : { ...current, accountStandingSeen: true },
    );
  }, [updateConfig]);
  const { canInstall, install, needsManualInstall } = useInstallPrompt();
  const setVoiceToggle = (key: keyof AudioProcessingPrefs) => (value: boolean) => {
    setVoiceProcessing((prev) => {
      const next = { ...prev, [key]: value };
      setAudioProcessing(next);
      return next;
    });
  };

  /**
   * App relays are an Armada preference and travel in encrypted NIP-78. Search
   * relays have their own interoperable NIP-51 kind 10007 list, so their editor
   * explicitly publishes that canonical record too.
   */
  const setAppRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, appRelays: relays }));
  };

  const setBroadcastRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, broadcastRelays: relays }));
  };

  const setAppDmRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, appDmRelays: relays }));
  };

  const setAppBlossomServers = (servers: string[]) => {
    updateConfig((current) => ({ ...current, appBlossomServers: servers }));
  };

  const setAutomaticSettingsSync = (automaticSettingsSync: boolean) => {
    updateConfig((current) => ({ ...current, automaticSettingsSync }));
  };

  const setCommunityRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, communityRelays: relays }));
  };

  const setSearchRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, searchRelays: relays }));
    if (user) {
      searchRelayList.publish(relays).catch((err) =>
        console.warn("Search relay list (kind 10007) publish failed:", err));
    }
  };

  /**
   * Update the user's server list by diffing against the kind 10009 list —
   * the one and only store for added servers. There is no local mirror to
   * write: `useNip29Servers` re-derives from the list mutation's own fold
   * write, so the editor reflects the change as soon as it lands.
   */
  const setAddedRelays = (relays: string[]) => {
    if (!user) return;
    for (const url of relays) {
      if (!servers.includes(url)) {
        updateList({ type: "add-server", url }).catch((err) =>
          console.warn("Failed to add server to group list:", err));
      }
    }
    for (const url of servers) {
      if (!relays.includes(url)) {
        updateList({ type: "remove-server", url }).catch((err) =>
          console.warn("Failed to remove server from group list:", err));
      }
    }
  };

  /**
   * Toggle the app's default DM relays in/out of THIS client's DM relay set.
   *
   * App DM relays are a purely client-side helper (`effectiveDmRelays`): the
   * relays this client also reads/writes DMs on for reliability + push. They are
   * NEVER part of the user's published kind-10050 inbox — that's the user's own
   * event and must not carry app defaults. So this is local-only and publishes
   * nothing. Config syncs across the user's devices via NostrSync.
   */
  const setUseAppDmRelays = (value: boolean) => {
    updateConfig((current) => ({ ...current, useAppDmRelays: value }));
  };

  /**
   * Toggle whether this client also uses the user's own DM relays. Local-only:
   * the published kind-10050 reflects the personal list itself (`setDmRelays`),
   * not whether this client currently reads from it.
   */
  const setUseOwnDmRelays = (value: boolean) => {
    updateConfig((current) => ({ ...current, useOwnDmRelays: value }));
  };

  /**
   * Toggle whether the app relays are used in the general pool at all. On by
   * default; turning it off is a foot-gun (see the warning rendered alongside).
   * Local config only; publishes nothing.
   */
  const setUseAppRelays = (value: boolean) => {
    updateConfig((current) => ({ ...current, useAppRelays: value }));
  };

  /**
   * Toggle whether the general relay pool also uses the user's own NIP-65
   * (kind 10002) relays. Local-only and publishes nothing: `relayMetadata` is
   * a read-only mirror of the user's published list (synced by NostrSync), so
   * this only controls whether this client reads/writes on those relays too.
   */
  const setUseUserRelays = (value: boolean) => {
    updateConfig((current) => ({ ...current, useUserRelays: value }));
  };

  /**
   * Toggle DM typing indicators. Off by default — see `dmTypingIndicators`.
   * Local config only (synced across devices); publishes nothing.
   */
  const setDmTypingIndicators = (value: boolean) => {
    updateConfig((current) => ({ ...current, dmTypingIndicators: value }));
  };

  /**
   * Turn direct messages off (or back on) entirely — see `dmsDisabled`. When
   * on, every standing DM subscription (wire, inbox top-up, typing, calls, and
   * the push/native watch sets) collapses to an empty relay set, so the client
   * stops receiving DMs at the network level. Local config only (synced across
   * devices); publishes nothing and deletes no stored conversations.
   */
  const setDmsDisabled = (value: boolean) => {
    updateConfig((current) => ({ ...current, dmsDisabled: value }));
  };

  /**
   * Toggle whether unknown-sender DMs are surfaced in the request tier. On by
   * default — see `showDmRequests`. Local config only (synced across devices);
   * publishes nothing and drops no messages.
   */
  const setShowDmRequests = (value: boolean) => {
    updateConfig((current) => ({ ...current, showDmRequests: value }));
  };

  /**
   * Toggle whether the rail shows the automatic strip of recent unread DMs. On
   * by default — see `showRecentRailDms`. Local config only (synced across
   * devices); publishes nothing and leaves manually arranged rail DMs untouched.
   */
  const setShowRecentRailDms = (value: boolean) => {
    updateConfig((current) => ({ ...current, showRecentRailDms: value }));
  };

  /**
   * Toggle whether Discover bypasses the curated author allow-list and shows
   * the unfiltered public firehose. Off by default; on is a foot-gun (see the
   * warning rendered alongside). Local config only (synced across devices);
   * publishes nothing.
   */
  const setDiscoverAllContent = (value: boolean) => {
    updateConfig((current) => ({ ...current, discoverAllContent: value }));
  };

  /**
   * Persist the user's own DM relays. kind-10050 is the user's canonical,
   * discoverable inbox and holds ONLY their personal relays — never the app
   * defaults. So publish exactly the edited list (a direct edit to their own
   * relay list is the one legitimate reason to write their 10050). No async
   * refetch/seed, so an in-flight fetch can't clobber a fresh edit.
   */
  const setDmRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, dmRelays: relays }));
    if (user) {
      dmRelayList.publish(relays).catch((err) =>
        console.warn("DM relay list (kind 10050) publish failed:", err));
    }
  };

  /**
   * Persist the user's Blossom media servers. Updates local config (the
   * encrypted-settings push is handled centrally by NostrSync) and — since
   * kind 10063 is the canonical, discoverable "where my media lives" list
   * (BUD-03) — republishes it so other clients stay in sync.
   */
  const setBlossomServers = (servers: string[]) => {
    updateConfig((current) => ({
      ...current,
      blossomServerMetadata: { servers, updatedAt: Math.floor(Date.now() / 1000) },
    }));
    if (user) {
      blossomServerList.publish(servers).catch((err) =>
        console.warn("Blossom server list (kind 10063) publish failed:", err));
    }
  };

  /** Toggle whether uploads also use the app default Blossom servers. */
  const setUseAppBlossomServers = (value: boolean) => {
    updateConfig((current) => ({ ...current, useAppBlossomServers: value }));
  };

  /**
   * Toggle tracking-parameter stripping. Publishes nothing; affects both what
   * this client sends and how it renders links it receives. Synced.
   */
  const setStripTrackingParams = (value: boolean) => {
    updateConfig((current) => ({ ...current, stripTrackingParams: value }));
  };

  /**
   * Toggle whether Enter sends a message. When off, Enter is a newline and
   * Ctrl/Cmd+Enter sends. Stored per device class (touch vs physical keyboard)
   * and synced, so the choice follows every like device without a desktop
   * preference reaching a phone — see AppConfig.sendOnEnter.
   */
  const setSendOnEnter = (value: boolean) => {
    const key = isTouch ? "touch" : "desktop";
    updateConfig((current) => ({
      ...current,
      sendOnEnter: { ...current.sendOnEnter, [key]: value },
    }));
  };

  // Section list, gated the same way the old flat sections were.
  const navGroups = useMemo<NavGroup[]>(() => {
    const userItems: NavItem[] = [
      { id: "account", title: "Account", icon: UserCircle, inline: true },
    ];
    if (user) {
      // Only an nsec login has a key this client can show/back up. Remote,
      // extension and Android-signer logins keep the key inside the signer.
      const activeLogin = logins[0];
      // Until it's been opened the entry wears an alert shield, which the
      // dialog then reveals to be a joke. Afterwards it settles into the check.
      userItems.push({
        id: "standing",
        title: "Account standing",
        icon: config.accountStandingSeen ? ShieldCheck : ShieldAlert,
        action: openStanding,
      });
      if (activeLogin?.type === "nsec") {
        userItems.push({ id: "keys", title: "Keys", icon: KeyRound });
      }
      userItems.push(
        { id: "profile", title: "Profile", icon: UserCircle },
        { id: "notifications", title: "Notifications", icon: Bell },
        // The only route back from a block: a blocked person appears in no
        // list anywhere else, so there is nowhere else an unblock could live.
        { id: "muted", title: "Blocked people", icon: UserX },
      );
    }
    const appItems: NavItem[] = [
      { id: "appearance", title: "Appearance", icon: Palette },
    ];
    // Launch-at-login and start-minimized are Electron-shell settings.
    if (isDesktop()) {
      appItems.push({ id: "desktop", title: "Desktop", icon: Monitor });
    }
    appItems.push(
      { id: "voice", title: "Voice", icon: Mic },
      { id: "servers", title: "Servers", icon: Server },
      { id: "app-relays", title: "App relays", icon: Waypoints },
      { id: "community-relays", title: "Community relays", icon: ShieldCheck },
      { id: "search-relays", title: "Search relays", icon: Search },
      { id: "dms", title: "Direct messages", icon: MessageSquareLock },
      { id: "chat", title: "Chat", icon: MessageSquare },
      { id: "media", title: "Media", icon: Image },
      { id: "links", title: "Links", icon: Link2 },
      { id: "discover", title: "Discover", icon: Compass },
    );
    if (user) {
      appItems.push({ id: "emojis", title: "Emoji packs", icon: Smile });
    }
    if (user) {
      // The Wallet page is reachable even when zaps are off, because its own
      // enable toggle lives inside it — gating the nav entry on zapsEnabled
      // would strand the user with no way to turn it back on. The page hides
      // its own contents when disabled.
      appItems.push({ id: "wallet", title: "Wallet", icon: Zap });
    }
    if (canInstall || needsManualInstall) {
      appItems.push({ id: "install", title: "Install app", icon: Download, inline: true });
    }
    const groups: NavGroup[] = [
      { heading: "User settings", items: userItems },
      { heading: "App settings", items: appItems },
    ];
    if (user) {
      groups.push({ heading: "Danger zone", items: [{ id: "danger", title: "Delete account", icon: AlertTriangle, inline: true }] });
    }
    return groups;
  }, [user, logins, canInstall, needsManualInstall, config.accountStandingSeen, openStanding]);

  /** The row(s) inside one section's chrome card. */
  const sectionBody = (id: SectionId): ReactNode => {
    switch (id) {
      case "account":
        return (
          <SettingsRow>
            <LoginArea className="w-full flex" />
          </SettingsRow>
        );
      case "standing":
        // Header-only: its trigger opens AccountStandingDialog, so there's
        // nothing to expand into.
        return null;
      case "keys": {
        const activeLogin = logins[0];
        if (activeLogin?.type !== "nsec") return null;
        return <KeyBackupSettings nsec={activeLogin.data.nsec} pubkey={activeLogin.pubkey} />;
      }
      case "profile":
        return (
          <SettingsRow>
            <ProfileSettings />
          </SettingsRow>
        );
      case "muted":
        return <MutedPeopleSettings />;
      case "notifications":
        return (
          <SettingsRow>
            <NotificationSettings />
          </SettingsRow>
        );
      case "appearance":
        return (
          <SettingsRow>
            <ThemeSelector />
          </SettingsRow>
        );
      case "desktop":
        return <DesktopSettings />;
      case "servers":
        return (
          <>
            <SettingsRow>
              <p className="text-xs text-muted-foreground leading-snug">
                Trust-the-host NIP-29 servers you've connected to. Each is a
                single relay that stores that server's channels and messages.
                Usually added by joining, with the + button in the server rail.
              </p>
            </SettingsRow>
            <SettingsRow>
              <RelayListEditor
                relays={servers}
                onChange={setAddedRelays}
                emptyText="No extra servers added. Use the + button in the server rail to add one."
                placeholder="wss://server.example.com"
              />
            </SettingsRow>
          </>
        );
      case "app-relays": {
        const ownsRelayList =
          !config.relayMetadata.pubkey || config.relayMetadata.pubkey === user?.pubkey;
        const userRelayUrls = ownsRelayList
          ? config.relayMetadata.relays.map((r) => r.url)
          : [];
        const userWriteRelayUrls = ownsRelayList
          ? config.relayMetadata.relays.filter((r) => r.write).map((r) => r.url)
          : [];
        return (
          <>
            <SettingsRow>
              <p className="text-xs text-muted-foreground leading-snug">
                The relays where Armada keeps and looks up your account data:
                your profile, follow list, emoji packs, and the other personal
                lists that follow you between devices.
              </p>
            </SettingsRow>
            <SettingsRow
              label="Use app relays"
              description="Read and write your account data on the app relays below. Leave this on unless you really know you want it off."
            >
              <Switch checked={config.useAppRelays} onCheckedChange={setUseAppRelays} />
            </SettingsRow>
            {!config.useAppRelays && !(config.useUserRelays && userRelayUrls.length > 0) && (
              <SettingsRow>
                <p className="text-sm text-destructive leading-snug">
                  App relays are off and you have no personal relays (NIP-65).
                  Your profile, follow lists, and emoji packs won't load or sync
                  until you configure an app or personal account-data relay.
                </p>
              </SettingsRow>
            )}
            <SettingsRow>
              <RelayListEditor
                relays={config.appRelays}
                onChange={setAppRelays}
                onReset={() => setAppRelays([...APP_RELAYS])}
                emptyText="No app relays yet. Configure personal NIP-65 relays to keep account data available."
              />
            </SettingsRow>
            <SettingsRow>
              <p className="text-xs text-muted-foreground leading-snug">
                Broadcast relays. Your profile and other public account data are
                also published here so other Nostr apps can find them. Armada
                never reads from these, so removing one costs you nothing but
                reach. Your communities and messages are never sent here.
              </p>
            </SettingsRow>
            <SettingsRow>
              <RelayListEditor
                relays={config.broadcastRelays}
                onChange={setBroadcastRelays}
                onReset={() => setBroadcastRelays([...BROADCAST_RELAYS])}
                emptyText="No broadcast relays. Your public data goes only to the relays above."
              />
            </SettingsRow>
            <SettingsRow
              label="Use my own relays (NIP-65)"
              description="Also read and write profiles and lists on the relays from your published NIP-65 relay list, on top of the app relays above."
            >
              <Switch checked={config.useUserRelays} onCheckedChange={setUseUserRelays} />
            </SettingsRow>
            {user && (
              <SettingsRow
                stack
                label={userRelayUrls.length > 0 ? "Edit my signed relay list" : "Find or publish my relay list"}
                description={userRelayUrls.length > 0
                  ? "Changes replace your NIP-65 list only after you press Save and approve the signature."
                  : "Look for your signed NIP-65 list using one bootstrap relay. If none exists, Armada can publish that relay only after you approve the signature."}
              >
                <RelayBootstrapForm />
              </SettingsRow>
            )}
            {user && (
              <SettingsRow
                label="Automatic settings sync"
                description="Automatically send private Armada setting changes and the encrypted DM discovery index, and apply changes from your other clients. This switch affects only this device; Sync now still works when it is off."
              >
                <Switch
                  checked={config.automaticSettingsSync !== false}
                  onCheckedChange={setAutomaticSettingsSync}
                />
              </SettingsRow>
            )}
            {user && userWriteRelayUrls.length > 0 && (
              <SettingsRow
                stack
                label={portableSetup.isConfigured ? "Synchronize setup" : "Set up synchronization"}
                description={(
                  <>
                    {portableSetup.isConfigured
                      ? portableSetup.isAutomatic
                        ? "Community and server lists stay synchronized, and private settings plus the DM roster sync automatically. Sync now also repairs every NIP-65 write relay immediately."
                        : "Private settings and DM-roster auto-sync are off on this device; community and server lists still synchronize when changed. Sync now repairs all portable state immediately."
                      : config.automaticSettingsSync !== false
                        ? "Press once to copy your signed lists, encrypted settings, community recovery state, invite authority, and DM roster to every NIP-65 write relay. Later private setting changes will sync automatically."
                        : "Press once to copy your signed lists and encrypted recovery state. Future private Armada setting changes remain on this device until you press Sync now or enable automatic sync."}
                    <span className="mt-2 block">
                      Pull latest setup reads those records—including communities and DM
                      conversations—back from your NIP-65 relays without publishing anything.
                    </span>
                    <span className="mt-2 block">
                      Device hardware, audio processing, notification permission, Bluetooth, and
                      wallet secrets stay on this device.
                    </span>
                  </>
                )}
              >
                <div className="grid w-full gap-2 sm:grid-cols-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 clip-corner-lg touch:h-12"
                    disabled={portablePull.isPending || portableSetup.isPending}
                    onClick={() => {
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
                    }}
                  >
                    {portablePull.isPending ? "Pulling…" : "Pull latest setup"}
                  </Button>
                  <Button
                    type="button"
                    className="h-11 clip-corner-lg touch:h-12"
                    disabled={portableSetup.isPending || portableSetup.isStatusLoading || portablePull.isPending}
                    onClick={() => {
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
                    }}
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
          </>
        );
      }
      case "community-relays":
        return (
          <>
            <SettingsRow>
              <p className="text-xs text-muted-foreground leading-snug">
                Where a community you create lives. Everyone in it reads and
                posts here, so pick relays that will let your members post. You
                can change the set for a single community when you create it,
                and afterwards from the community's own settings.
              </p>
            </SettingsRow>
            <SettingsRow>
              <RelayListEditor
                relays={config.communityRelays}
                onChange={setCommunityRelays}
                onReset={() => setCommunityRelays([...STOCK_RELAYS])}
                emptyText="No community relays — new communities fall back to the shared Concord relays."
              />
            </SettingsRow>
          </>
        );
      case "search-relays":
        return (
          <>
            <SettingsRow>
              <p className="text-xs text-muted-foreground leading-snug">
                Relays queried when you search for people or communities by name
                (NIP-50). Leave empty to fall back to your app relays.
              </p>
            </SettingsRow>
            <SettingsRow>
              <RelayListEditor
                relays={config.searchRelays}
                onChange={setSearchRelays}
                onReset={() => setSearchRelays([...SEARCH_RELAYS])}
                emptyText="No search relays — search falls back to your app relays."
              />
            </SettingsRow>
          </>
        );
      case "dms": {
        const effective = effectiveDmRelays(config);
        return (
          <>
            <SettingsRow
              label="Turn off direct messages"
              description="Stop this account from listening for direct messages at all. No standing inbox subscription is held, so unsolicited DMs never reach you and cost no bandwidth. Your stored conversations and DM relay list are left untouched; turn this back off to resume. Synced across your devices."
            >
              <Switch checked={config.dmsDisabled} onCheckedChange={setDmsDisabled} />
            </SettingsRow>
            {/* Everything below configures a DM inbox the account is no longer
                listening on, so the whole-DM opt-out hides it — leaving only
                the master toggle to turn DMs back on. */}
            {!config.dmsDisabled && (
              <>
                <SettingsRow
                  label="Use app DM relays"
                  description="Send and receive DMs on your general app relays and the additional synchronized app DM relays below."
                >
                  <Switch checked={config.useAppDmRelays} onCheckedChange={setUseAppDmRelays} />
                </SettingsRow>
                <SettingsRow
                  stack
                  label="Additional app DM relays"
                  description="The client-provided DM relays used alongside your general app relays. This synchronized list replaces Armada's built-in DM address."
                >
                  <RelayListEditor
                    relays={config.appDmRelays}
                    onChange={setAppDmRelays}
                    onReset={() => setAppDmRelays([...DM_RELAYS])}
                    emptyText="No additional app DM relays. Legacy DMs still use your general app relays."
                    placeholder="wss://dm-relay.example.com"
                  />
                </SettingsRow>
                <SettingsRow
                  label="Use my own DM relays"
                  description="Also send and receive DMs on your own relays (listed below)."
                >
                  <Switch checked={config.useOwnDmRelays} onCheckedChange={setUseOwnDmRelays} />
                </SettingsRow>
                <SettingsRow>
                  <RelayListEditor
                    relays={config.dmRelays}
                    onChange={setDmRelays}
                    emptyText="No personal DM relays yet. Add one, or rely on the app DM relays above."
                    placeholder="wss://dm-relay.example.com"
                  />
                </SettingsRow>
                <SettingsRow
                  label="Message requests"
                  description="Show DMs from people you don't follow and haven't written to in a separate Requests list. Turn off to hide them from your inbox entirely."
                >
                  <Switch checked={config.showDmRequests} onCheckedChange={setShowDmRequests} />
                </SettingsRow>
                <SettingsRow
                  label="Recent DMs in the rail"
                  description="Show your newest unread conversations as a strip at the top of the far-left rail. Turn off to keep only the DMs you've pinned there. Doesn't affect your DM list."
                >
                  <Switch checked={config.showRecentRailDms} onCheckedChange={setShowRecentRailDms} />
                </SettingsRow>
                <SettingsRow
                  label="Typing indicators"
                  description="Show when the other person is typing, and let them see when you are. Sends a small encrypted signal every few seconds while you type, so your relays can tell the conversation is active right now."
                >
                  <Switch checked={config.dmTypingIndicators} onCheckedChange={setDmTypingIndicators} />
                </SettingsRow>
                {effective.length > 0 ? (
                  <SettingsRow>
                    <div className="space-y-2">
                      <div className="text-sm font-medium leading-tight">DMs currently use</div>
                      <RelayListEditor readOnly relays={effective} />
                    </div>
                  </SettingsRow>
                ) : (
                  <SettingsRow>
                    <p className="text-sm text-destructive">
                      No DM relays selected. You can't send or receive direct
                      messages. Turn on at least one option above.
                    </p>
                  </SettingsRow>
                )}
              </>
            )}
          </>
        );
      }
      case "media":
        return (
          <>
            <MediaPrivacySettings />
            <SettingsRow
              label="Use app media servers"
              description="Upload files to the synchronized app Blossom servers in addition to your own."
            >
              <Switch
                checked={config.useAppBlossomServers}
                onCheckedChange={setUseAppBlossomServers}
              />
            </SettingsRow>
            <SettingsRow
              stack
              label="App media servers"
              description="This synchronized list replaces the media-server addresses shipped with the app."
            >
              <BlossomServerListEditor
                servers={config.appBlossomServers}
                onChange={setAppBlossomServers}
                onReset={() => setAppBlossomServers([...APP_BLOSSOM_SERVERS])}
                emptyText="No app media servers configured."
              />
            </SettingsRow>
            <SettingsRow>
              <BlossomServerListEditor
                servers={config.blossomServerMetadata.servers}
                onChange={setBlossomServers}
                emptyText="No personal media servers configured."
              />
            </SettingsRow>
            {!config.useAppBlossomServers
              && config.blossomServerMetadata.servers.length === 0 && (
              <SettingsRow>
                <p className="text-sm text-destructive">
                  No media servers selected. File uploads are unavailable until you add a
                  personal server or turn app media servers back on.
                </p>
              </SettingsRow>
            )}
          </>
        );
      case "chat":
        return (
          <SettingsRow
            label="Send with Enter"
            description={
              isTouch
                ? "Enter sends the message. Off, Enter is a new line and you send with the button."
                : "Enter sends; Shift+Enter for a new line. Off, Ctrl/Cmd+Enter sends."
            }
          >
            <Switch
              checked={sendsOnEnter(config.sendOnEnter, isTouch)}
              onCheckedChange={setSendOnEnter}
            />
          </SettingsRow>
        );
      case "links":
        return (
          <SettingsRow
            label="Clean up links"
            description="Remove tracking parameters from links — YouTube's ?si=, utm_ campaign tags, and the click ids ad networks add. Applied to links you send, so they're clean for everyone who reads them, and to links you receive, so nothing they carry reaches the sites your app loads previews from. Only known tracking parameters are removed; the link still goes to the same page."
          >
            <Switch
              checked={config.stripTrackingParams}
              onCheckedChange={setStripTrackingParams}
            />
          </SettingsRow>
        );
      case "discover":
        return (
          <>
            <SettingsRow
              label="Show all content"
              description="Discover normally shows only communities, emoji packs, and themes from a curated set of authors: the Armada follow pack, plus people you follow. Turn this on to browse everything published to your relays instead."
            >
              <Switch
                checked={config.discoverAllContent}
                onCheckedChange={setDiscoverAllContent}
              />
            </SettingsRow>
            {config.discoverAllContent && (
              <SettingsRow>
                <div className="flex items-start gap-2">
                  <AlertTriangle className="size-4 text-destructive shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive leading-snug">
                    Discover is now unfiltered. Content comes from anyone on your
                    relays and is not vetted or moderated, so you may encounter
                    spam or objectionable material.
                  </p>
                </div>
              </SettingsRow>
            )}
          </>
        );
      case "voice":
        return (
          <>
            <SettingsRow>
              <VoiceDeviceSettings />
            </SettingsRow>
            {rnnoiseSupported() && (
              <SettingsRow
                label="Noise cancellation"
                description="ML background-noise removal (RNNoise) — removes keyboards, fans, and chatter. Applied to your next call."
              >
                <Switch
                  checked={voiceProcessing.rnnoise}
                  onCheckedChange={setVoiceToggle("rnnoise")}
                />
              </SettingsRow>
            )}
            <SettingsRow
              label="Noise suppression"
              description="Filter out background hum and keyboard noise."
            >
              <Switch
                checked={voiceProcessing.noiseSuppression}
                onCheckedChange={setVoiceToggle("noiseSuppression")}
              />
            </SettingsRow>
            <SettingsRow
              label="Echo cancellation"
              description="Stop your speakers from echoing back into the mic."
            >
              <Switch
                checked={voiceProcessing.echoCancellation}
                onCheckedChange={setVoiceToggle("echoCancellation")}
              />
            </SettingsRow>
            <SettingsRow
              label="Auto gain control"
              description="Even out your volume automatically."
            >
              <Switch
                checked={voiceProcessing.autoGainControl}
                onCheckedChange={setVoiceToggle("autoGainControl")}
              />
            </SettingsRow>
          </>
        );
      case "emojis":
        return <EmojiPackSettings />;
      case "wallet":
        return <WalletSettings />;
      case "install":
        return (
          <SettingsRow
            label="Install Armada"
            description={needsManualInstall
              ? "In Safari, tap Share → Add to Home Screen, keep Open as Web App on, then launch Armada from its new icon."
              : "Add to your home screen or desktop for a standalone app experience."}
            onClick={canInstall ? () => install() : undefined}
          >
            <Download className="size-4 text-muted-foreground" />
          </SettingsRow>
        );
      case "danger":
        return (
          <SettingsRow
            label="Delete Account"
            description="Permanently remove your identity and request data deletion from relays."
            onClick={() => setDeleteAccountOpen(true)}
          >
            <AlertTriangle className="size-4 text-destructive" />
          </SettingsRow>
        );
    }
  };

  return (
    <main className="flex-1 min-w-0 flex flex-col safe-area-top">
      {/* Header — a detached floating command bar matching the group/Concord/DM
          chrome (cut-corner card, recessed shade), capped to the settings
          content width and centered on desktop. */}
      <header className="relative h-12 touch:h-14 mx-2 mt-3 w-[calc(100%-1rem)] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          aria-label="Back"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="font-semibold truncate leading-tight">Settings</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto pb-safe">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 pb-12 pt-4 space-y-6">
          {navGroups.map((group) => (
            <section key={group.heading} className="space-y-1.5">
              <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.heading}
              </h2>
              <div className="space-y-1.5">
                {group.items.map((item) =>
                  item.action ? (
                    /* Dressed as a section header, but it opens a dialog. */
                    <div
                      key={item.id}
                      id={`settings-${item.id}`}
                      className="bg-chrome clip-corner-lg overflow-hidden"
                    >
                      <button type="button" onClick={item.action} className={SECTION_HEADER_CLASS}>
                        <item.icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 text-sm font-medium truncate">
                          {item.title}
                        </span>
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </div>
                  ) : item.inline ? (
                    /* Single-item section: its row IS the list entry. */
                    <div
                      key={item.id}
                      id={`settings-${item.id}`}
                      className="bg-chrome clip-corner-lg overflow-hidden [&>*]:border-chrome [&>*:not(:first-child)]:border-t"
                    >
                      {sectionBody(item.id)}
                    </div>
                  ) : (
                    /* Multi-control section: collapsible header, expands in place. */
                    <Collapsible
                      key={item.id}
                      id={`settings-${item.id}`}
                      defaultOpen={item.id === targetSection}
                      className="bg-chrome clip-corner-lg overflow-hidden"
                    >
                      <CollapsibleTrigger asChild>
                        <button type="button" className={SECTION_HEADER_CLASS}>
                          <item.icon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 text-sm font-medium truncate">
                            {item.title}
                          </span>
                          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
                        <div className="border-t border-chrome [&>*]:border-chrome [&>*:not(:first-child)]:border-t">
                          {sectionBody(item.id)}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  ),
                )}
              </div>
            </section>
          ))}

          {user && (
            <AccountStandingDialog open={standingOpen} onOpenChange={setStandingOpen} />
          )}

          {user && (
            <Suspense fallback={null}>
              <RequestToVanishDialog open={deleteAccountOpen} onOpenChange={setDeleteAccountOpen} />
            </Suspense>
          )}

          {/* Bottom ornament */}
          <div className="flex items-center gap-2 px-6 pt-2 pb-1">
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/20 to-primary/30" />
            <svg width="22" height="22" viewBox="0 0 128 128" fill="none" aria-hidden className="text-primary/30 shrink-0">
              <path d="M64 4.225l-39.97 88.5h17.13l2.31-5.2 2.76-6.22-2.22-1.43-1.42-12.84h9.99l4.89-11.01L64 41.335l11.42 25.7h9.99l-1.43 12.84-2.22 1.43 2.77 6.22 2.31 5.2h17.13z" fill="currentColor" />
            </svg>
            <div className="h-px flex-1 bg-gradient-to-l from-transparent via-primary/20 to-primary/30" />
          </div>

          {/* Version footer — links to the changelog, with terms/privacy beside it */}
          <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/50 select-none pt-1 pb-2">
            <Link to="/changelog" className="flex items-center gap-1 hover:text-muted-foreground transition-colors">
              <ScrollText className="size-3" />
              v{import.meta.env.VERSION}{import.meta.env.COMMIT_TAG ? "" : "+"} ({new Date(import.meta.env.BUILD_DATE).toLocaleDateString()})
            </Link>
            <span aria-hidden className="text-muted-foreground/30">·</span>
            <Link to="/downloads" className="flex items-center gap-1 hover:text-muted-foreground transition-colors">
              <Download className="size-3" />
              Apps
            </Link>
            <span aria-hidden className="text-muted-foreground/30">·</span>
            <Link to="/terms" className="flex items-center gap-1 hover:text-muted-foreground transition-colors">
              <FileText className="size-3" />
              Terms
            </Link>
            <span aria-hidden className="text-muted-foreground/30">·</span>
            <Link to="/privacy" className="flex items-center gap-1 hover:text-muted-foreground transition-colors">
              <Shield className="size-3" />
              Privacy
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
