import { Capacitor } from "@capacitor/core";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bell,
  ChevronDown,
  Compass,
  Download,
  EyeOff,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";

import { LoginArea } from "@/components/auth/LoginArea";
import { BlossomServerListEditor } from "@/components/BlossomServerListEditor";
import { PreferredBlossomServerField } from "@/components/PreferredBlossomServerField";
import { AccountStandingDialog } from "@/components/settings/AccountStandingDialog";
import { EmojiPackSettings } from "@/components/settings/EmojiPackSettings";
import { ProfileSettings } from "@/components/ProfileSettings";
import { NotificationSettings } from "@/components/NotificationSettings";
import { RelayListEditor } from "@/components/RelayListEditor";
import { RelayBootstrapForm } from "@/components/RelayBootstrapForm";
import { DesktopSettings } from "@/components/settings/DesktopSettings";
import { DiagnosticsSettings } from "@/components/settings/DiagnosticsSettings";
import { KeyBackupSettings } from "@/components/settings/KeyBackupSettings";
import { MediaPrivacySettings } from "@/components/settings/MediaPrivacySettings";
import { MutedPeopleSettings } from "@/components/settings/MutedPeopleSettings";
import { ChatSearchBar } from "@/components/chat/ChatSearchBar";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { useSettingsFilter } from "@/components/settings/settingsSearch";
import { WalletSettings } from "@/components/settings/WalletSettings";
import { ThemeSelector } from "@/components/ThemeSelector";
import { VoiceDeviceSettings } from "@/components/VoiceDeviceSettings";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useBackOrHome } from "@/hooks/useBackOrHome";
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
import { APP_RELAYS, BROADCAST_RELAYS, COMMUNITY_RELAYS, DM_RELAYS, SEARCH_RELAYS } from "@/lib/platform";
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
  | "uploads"
  | "links"
  | "discover"
  | "emojis"
  | "wallet"
  | "install"
  | "diagnostics"
  | "danger";

interface NavItem {
  id: SectionId;
  title: string;
  icon: LucideIcon;
  /** Render the row(s) directly with no collapsible header (single-item sections). */
  inline?: boolean;
  /** Open something on tap instead of expanding (still drawn as a section header). */
  action?: () => void;
}

/** Section header row, shared by collapsible and dialog-opening sections. */
const SECTION_HEADER_CLASS =
  "flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/40";

interface NavGroup {
  heading: string;
  items: NavItem[];
}

/** App settings: one scrolling list; multi-control sections collapse, single-item ones render inline. */
export function SettingsPage({
  section,
  onClose,
}: {
  /** Set when drawn as an overlay (`lib/settingsOverlay.ts`), where `useLocation()` is the page underneath. */
  section?: string;
  onClose?: () => void;
} = {}) {
  const back = useBackOrHome();
  // Deep-linked section (e.g. /settings#profile) renders expanded and scrolled into view.
  const routedSection = useLocation().hash.slice(1);
  const targetSection = section ?? routedSection;
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(
    () => new Set(targetSection ? [targetSection] : []),
  );
  useEffect(() => {
    if (!targetSection) return;
    setOpenSections((prev) => (prev.has(targetSection) ? prev : new Set(prev).add(targetSection)));
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

  // Mic-processing prefs are device-local (localStorage), not synced AppConfig.
  const [voiceProcessing, setVoiceProcessing] = useState<AudioProcessingPrefs>(() =>
    getAudioProcessing(),
  );
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);
  const searching = query.trim() !== "";
  const listRef = useRef<HTMLDivElement>(null);
  const visibleSections = useSettingsFilter(listRef, query);
  const toggleSection = useCallback((id: string, open: boolean) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const [standingOpen, setStandingOpen] = useState(false);

  /** Retire Account Standing's nag dot on open (not close). */
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
   * App relays travel in encrypted NIP-78; search relays also publish their
   * interoperable NIP-51 kind 10007 list.
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

  /** Update added servers by diffing the kind 10009 list (their only store). */
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
   * Toggle the app's default DM relays for THIS client (`effectiveDmRelays`).
   * Local-only: app defaults must NEVER enter the user's published kind 10050.
   */
  const setUseAppDmRelays = (value: boolean) => {
    updateConfig((current) => ({ ...current, useAppDmRelays: value }));
  };

  const setUseOwnDmRelays = (value: boolean) => {
    updateConfig((current) => ({ ...current, useOwnDmRelays: value }));
  };

  /** Off is a foot-gun: with no other relays the pool is empty. */
  const setUseAppRelays = (value: boolean) => {
    updateConfig((current) => ({ ...current, useAppRelays: value }));
  };

  /** Publishes nothing: `relayMetadata` is a read-only mirror of kind 10002. */
  const setUseUserRelays = (value: boolean) => {
    updateConfig((current) => ({ ...current, useUserRelays: value }));
  };

  const setDmTypingIndicators = (value: boolean) => {
    updateConfig((current) => ({ ...current, dmTypingIndicators: value }));
  };

  /** Empties every DM subscription's relay set; deletes no conversations and keeps the 10050. */
  const setDmsDisabled = (value: boolean) => {
    updateConfig((current) => ({ ...current, dmsDisabled: value }));
  };

  /** Display only: hiding the request tier drops no messages. */
  const setShowDmRequests = (value: boolean) => {
    updateConfig((current) => ({ ...current, showDmRequests: value }));
  };

  const setShowRecentRailDms = (value: boolean) => {
    updateConfig((current) => ({ ...current, showRecentRailDms: value }));
  };

  /** Bypasses Discover's curated allow-list (a foot-gun). */
  const setDiscoverAllContent = (value: boolean) => {
    updateConfig((current) => ({ ...current, discoverAllContent: value }));
  };

  /**
   * Publish the user's kind 10050 with exactly the edited personal list (never
   * app defaults) — the one legitimate reason to write it. No refetch, so an
   * in-flight fetch can't clobber the edit.
   */
  const setDmRelays = (relays: string[]) => {
    updateConfig((current) => ({ ...current, dmRelays: relays }));
    if (user) {
      dmRelayList.publish(relays).catch((err) =>
        console.warn("DM relay list (kind 10050) publish failed:", err));
    }
  };

  /** Persist Blossom servers and republish the canonical BUD-03 kind 10063 list. */
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

  const setUseAppBlossomServers = (value: boolean) => {
    updateConfig((current) => ({ ...current, useAppBlossomServers: value }));
  };

  const setStripTrackingParams = (value: boolean) => {
    updateConfig((current) => ({ ...current, stripTrackingParams: value }));
  };

  /** Toggle send-on-Enter, stored per device class — see AppConfig.sendOnEnter. */
  const setSendOnEnter = (value: boolean) => {
    const key = isTouch ? "touch" : "desktop";
    updateConfig((current) => ({
      ...current,
      sendOnEnter: { ...current.sendOnEnter, [key]: value },
    }));
  };

  /** Toggle Android back from the revealed list pane: leave the app vs. walk history. Per-device. */
  const setAndroidBackLeavesApp = (value: boolean) => {
    updateConfig((current) => ({ ...current, androidBackLeavesApp: value }));
  };

  const navGroups = useMemo<NavGroup[]>(() => {
    const userItems: NavItem[] = [
      { id: "account", title: "Account", icon: UserCircle, inline: true },
    ];
    if (user) {
      // Only nsec logins have a key this client can show/back up.
      const activeLogin = logins[0];
      // Wears an alert shield until opened (the dialog reveals it's a joke).
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
        // The only place to unblock: blocked people appear in no other list.
        { id: "muted", title: "Blocked people", icon: UserX },
      );
    }
    const appItems: NavItem[] = [
      { id: "appearance", title: "Appearance", icon: Palette },
    ];
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
      { id: "media", title: "Media privacy", icon: EyeOff },
      { id: "uploads", title: "Media uploads", icon: Image },
      { id: "links", title: "Links", icon: Link2 },
      { id: "discover", title: "Discover", icon: Compass },
    );
    if (user) {
      appItems.push({ id: "emojis", title: "Emoji packs", icon: Smile });
    }
    if (user) {
      // Reachable even with zaps off, since its enable toggle lives inside.
      appItems.push({ id: "wallet", title: "Wallet", icon: Zap });
    }
    if (canInstall || needsManualInstall) {
      appItems.push({ id: "install", title: "Install app", icon: Download, inline: true });
    }
    if (import.meta.env.VITE_PROFILE === "1") {
      appItems.push({ id: "diagnostics", title: "Diagnostics", icon: Activity });
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

  const sectionBody = (id: SectionId): ReactNode => {
    switch (id) {
      case "account":
        return (
          <SettingsRow>
            <LoginArea className="w-full flex" />
          </SettingsRow>
        );
      case "standing":
        // Header-only: it opens AccountStandingDialog.
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
                Where Armada keeps your profile, follows, emoji packs and other
                account data.
              </p>
            </SettingsRow>
            <SettingsRow
              label="Use app relays"
              description="Keep account data on the relays below."
            >
              <Switch checked={config.useAppRelays} onCheckedChange={setUseAppRelays} />
            </SettingsRow>
            {!config.useAppRelays && !(config.useUserRelays && userRelayUrls.length > 0) && (
              <SettingsRow>
                <p className="text-sm text-destructive leading-snug">
                  No account relays. Your profile and lists won't load or sync
                  until you add one.
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
                Broadcast relays. Your public profile is also published here
                for other Nostr apps. Armada never reads from them, and never
                sends messages here.
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
              description="Also use the relays in your NIP-65 relay list."
            >
              <Switch checked={config.useUserRelays} onCheckedChange={setUseUserRelays} />
            </SettingsRow>
            {user && (
              <SettingsRow
                stack
                label={userRelayUrls.length > 0 ? "Edit my signed relay list" : "Find or publish my relay list"}
                description={userRelayUrls.length > 0
                  ? "Changes apply when you save and sign."
                  : "Look up your NIP-65 list from one relay, or publish one."}
              >
                <RelayBootstrapForm />
              </SettingsRow>
            )}
            {user && (
              <SettingsRow
                label="Automatic settings sync"
                description="Sync private settings and DM list with your other devices. Applies to this device only."
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
                        ? "Your setup syncs automatically. Sync now pushes it to every relay again."
                        : "Communities and servers sync; private settings wait for Sync now."
                      : "Copy your lists, settings and communities to your NIP-65 relays."}
                    {" "}Device, audio and wallet settings stay here.
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
                Default relays for communities you create. Each community can
                override them in its own settings.
              </p>
            </SettingsRow>
            <SettingsRow>
              <RelayListEditor
                relays={config.communityRelays}
                onChange={setCommunityRelays}
                onReset={() => setCommunityRelays([...COMMUNITY_RELAYS])}
                emptyText="No community relays. New communities use the shared Concord relays."
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
                emptyText="No search relays. Search uses your app relays."
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
              description="Stop receiving DMs on all your devices. Existing conversations are kept."
            >
              <Switch checked={config.dmsDisabled} onCheckedChange={setDmsDisabled} />
            </SettingsRow>
            {/* With DMs disabled, only the master toggle remains. */}
            {!config.dmsDisabled && (
              <>
                <SettingsRow
                  label="Use app DM relays"
                  description="Use your app relays and the DM relays below."
                >
                  <Switch checked={config.useAppDmRelays} onCheckedChange={setUseAppDmRelays} />
                </SettingsRow>
                <SettingsRow
                  stack
                  label="Additional app DM relays"
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
                  description="Also use your own DM relays below."
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
                  description="Show DMs from strangers under Requests. Off hides them."
                >
                  <Switch checked={config.showDmRequests} onCheckedChange={setShowDmRequests} />
                </SettingsRow>
                <SettingsRow
                  label="Recent DMs in the rail"
                  description="Show unread DMs at the top of the server rail."
                >
                  <Switch checked={config.showRecentRailDms} onCheckedChange={setShowRecentRailDms} />
                </SettingsRow>
                <SettingsRow
                  label="Typing indicators"
                  description="Share and see typing status in DMs."
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
                      No DM relays. Turn on an option above to send and
                      receive DMs.
                    </p>
                  </SettingsRow>
                )}
              </>
            )}
          </>
        );
      }
      case "media":
        return <MediaPrivacySettings />;
      case "uploads":
        return (
          <>
            <SettingsRow
              label="Use app media servers"
              description="Also upload to the app media servers."
            >
              <Switch
                checked={config.useAppBlossomServers}
                onCheckedChange={setUseAppBlossomServers}
              />
            </SettingsRow>
            <SettingsRow
              stack
              label="App media servers"
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
            <SettingsRow
              stack
              label="Preferred media server"
              description="Links point here when it accepts the file."
            >
              <PreferredBlossomServerField
                value={config.preferredBlossomServer}
                onChange={(server) => updateConfig((current) => ({ ...current, preferredBlossomServer: server }))}
              />
            </SettingsRow>
            {!config.useAppBlossomServers
              && !config.preferredBlossomServer
              && config.blossomServerMetadata.servers.length === 0 && (
              <SettingsRow>
                <p className="text-sm text-destructive">
                  No media servers. Add one to upload files.
                </p>
              </SettingsRow>
            )}
          </>
        );
      case "chat":
        return (
          <>
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
            {Capacitor.getPlatform() === "android" && (
              <SettingsRow
                label="Back leaves the app"
                description="Off, back steps through recent chats."
              >
                <Switch
                  checked={config.androidBackLeavesApp}
                  onCheckedChange={setAndroidBackLeavesApp}
                />
              </SettingsRow>
            )}
          </>
        );
      case "links":
        return (
          <SettingsRow
            label="Clean up links"
            description="Strip tracking parameters like utm_ and ?si= from links."
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
              description={
                <>
                  Show everything posted to your relays, not just curated picks and
                  people you follow.
                  {config.discoverAllContent && (
                    <span className="mt-1 flex items-start gap-1.5 text-destructive">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        Unmoderated. Expect spam and offensive content.
                      </span>
                    </span>
                  )}
                </>
              }
            >
              <Switch
                checked={config.discoverAllContent}
                onCheckedChange={setDiscoverAllContent}
              />
            </SettingsRow>
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
                description="Filters out keyboards, fans and chatter (RNNoise). Applies to your next call."
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
      case "diagnostics":
        return import.meta.env.VITE_PROFILE === "1" ? <DiagnosticsSettings /> : null;
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
      <header className="relative h-12 touch:h-14 mx-gutter mt-3 w-[calc(100%-2*var(--gutter))] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          aria-label="Back"
          onClick={onClose ?? back}
        >
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="min-w-0 flex-1 font-semibold truncate leading-tight">Settings</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search settings"
          aria-pressed={searchOpen}
          className="size-9 shrink-0 text-muted-foreground"
          onClick={() => setSearchOpen(true)}
        >
          <Search className="size-4" />
        </Button>
        <ChatSearchBar
          open={searchOpen}
          value={query}
          onChange={setQuery}
          onClose={closeSearch}
          placeholder="Search settings…"
          label="Search settings"
        />
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto pb-safe">
        <div ref={listRef} className="max-w-2xl mx-auto px-4 sm:px-6 pb-12 pt-4 space-y-6">
          {searching && visibleSections === 0 && (
            <p className="px-1 py-8 text-center text-sm text-muted-foreground">
              No settings match “{query.trim()}”.
            </p>
          )}
          {navGroups.map((group) => (
            <section key={group.heading} data-settings-group className="space-y-1.5">
              <h2 className="px-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.heading}
              </h2>
              <div className="space-y-1.5">
                {group.items.map((item) =>
                  item.action ? (
                    <div
                      key={item.id}
                      id={`settings-${item.id}`}
                      data-settings-section
                      data-settings-title={item.title}
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
                    <div
                      key={item.id}
                      id={`settings-${item.id}`}
                      data-settings-section
                      data-settings-title={item.title}
                      data-settings-body
                      className="bg-chrome clip-corner-lg overflow-hidden [&>*]:border-chrome [&>*:not(:first-child)]:border-t"
                    >
                      {sectionBody(item.id)}
                    </div>
                  ) : (
                    <Collapsible
                      key={item.id}
                      id={`settings-${item.id}`}
                      data-settings-section
                      data-settings-title={item.title}
                      // Searching opens every section so its rows can be matched.
                      open={searching || openSections.has(item.id)}
                      onOpenChange={(open) => toggleSection(item.id, open)}
                      disabled={searching}
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
                        <div data-settings-body className="border-t border-chrome [&>*]:border-chrome [&>*:not(:first-child)]:border-t">
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

          <div className="flex items-center gap-2 px-6 pt-2 pb-1">
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/20 to-primary/30" />
            <svg width="22" height="22" viewBox="0 0 128 128" fill="none" aria-hidden className="text-primary/30 shrink-0">
              <path d="M64 4.225l-39.97 88.5h17.13l2.31-5.2 2.76-6.22-2.22-1.43-1.42-12.84h9.99l4.89-11.01L64 41.335l11.42 25.7h9.99l-1.43 12.84-2.22 1.43 2.77 6.22 2.31 5.2h17.13z" fill="currentColor" />
            </svg>
            <div className="h-px flex-1 bg-gradient-to-l from-transparent via-primary/20 to-primary/30" />
          </div>

          <div className="flex items-center justify-center gap-1.5 text-2xs text-muted-foreground/50 select-none pt-1 pb-2">
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
