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
  KeyRound,
  LifeBuoy,
  Link2,
  Mail,
  MessageSquare,
  MessageSquareLock,
  Mic,
  Monitor,
  Palette,
  RefreshCw,
  ScrollText,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smile,
  SpellCheck,
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
import { AccountStandingDialog } from "@/components/settings/AccountStandingDialog";
import { EmojiPackSettings } from "@/components/settings/EmojiPackSettings";
import { FontScaleSettings } from "@/components/settings/FontScaleSettings";
import { ProfileSettings } from "@/components/ProfileSettings";
import { NotificationSettings } from "@/components/NotificationSettings";
import { DmInboxNotice } from "@/components/DmInboxNotice";
import { RelayListEditor } from "@/components/RelayListEditor";
import { RelayBootstrapForm } from "@/components/RelayBootstrapForm";
import { SetupListRow } from "@/components/SetupListRow";
import { DesktopSettings } from "@/components/settings/DesktopSettings";
import { DiagnosticsSettings } from "@/components/settings/DiagnosticsSettings";
import { KeyBackupSettings } from "@/components/settings/KeyBackupSettings";
import { MediaPrivacySettings } from "@/components/settings/MediaPrivacySettings";
import { MutedPeopleSettings } from "@/components/settings/MutedPeopleSettings";
import { MutedWordsSettings } from "@/components/settings/MutedWordsSettings";
import { ChatSearchBar } from "@/components/chat/ChatSearchBar";
import { QuickReactionsSettings } from "@/components/settings/QuickReactionsSettings";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { useSettingsFilter } from "@/components/settings/settingsSearch";
import { WalletSettings } from "@/components/settings/WalletSettings";
import { ThemeSelector } from "@/components/ThemeSelector";
import { VoiceDeviceSettings } from "@/components/VoiceDeviceSettings";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/hooks/useAppContext";
import { useBackOrHome } from "@/hooks/useBackOrHome";
import { useBlossomServerList } from "@/hooks/useBlossomServerList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { recommendedDmInbox } from "@/hooks/useDmInboxSetup";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { useIsTouch } from "@/hooks/useIsMobile";
import { usePullPortableSetup } from "@/hooks/usePullPortableSetup";
import { usePublishPortableSetup } from "@/hooks/usePublishPortableSetup";
import { useSearchRelayList } from "@/hooks/useSearchRelayList";
import { toast } from "@/hooks/useToast";
import { isDesktop } from "@/lib/desktop";
import { APP_BLOSSOM_SERVERS, uploadTargets } from "@/lib/blossom";
import { APP_RELAYS, BROADCAST_RELAYS, COMMUNITY_RELAYS, SEARCH_RELAYS, SUPPORT_EMAIL } from "@/lib/platform";
import {
  getAudioProcessing,
  setAudioProcessing,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";
import { rnnoiseSupported } from "@/lib/rnnoiseSupport";
import { sendsOnEnter } from "@/lib/sendOnEnter";
import { cn } from "@/lib/utils";

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
  | "muted-words"
  | "appearance"
  | "desktop"
  | "voice"
  | "app-relays"
  | "sync"
  | "dms"
  | "chat"
  | "media"
  | "links"
  | "discover"
  | "emojis"
  | "wallet"
  | "install"
  | "diagnostics"
  | "support"
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

/** Section ids older links may still carry, and where they now live. */
const SECTION_ALIASES: Record<string, SectionId> = { uploads: "app-relays" };

/** The lists Settings › Relays shows, in the signup wizard's order and with its names. */
type RelayRow = "home" | "dm" | "search" | "blossom" | "community" | "broadcast";

/** Mono URL list for prose: hosts joined by commas. */
function hostList(urls: string[]): ReactNode {
  return urls.map((url, index) => (
    <span key={url}>
      {index > 0 && ", "}
      <span className="font-mono text-foreground">{url.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "")}</span>
    </span>
  ));
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
  const requestedSection = section ?? routedSection;
  const targetSection = SECTION_ALIASES[requestedSection] ?? requestedSection;
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
  // Searching mounts every relay row and the advanced rows so settings search can match them.
  const [relaysAdvancedOpen, setRelaysAdvancedOpen] = useState(false);
  const showAdvanced = relaysAdvancedOpen || searching;
  // One list open at a time, as in the signup wizard.
  const [openRelayRow, setOpenRelayRow] = useState<RelayRow | null>(null);
  const [publishedListOpen, setPublishedListOpen] = useState(false);
  const relayRowOpen = (row: RelayRow) => searching || openRelayRow === row;
  const setRelayRowOpen = (row: RelayRow) => (open: boolean) => setOpenRelayRow(open ? row : null);

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
   * One choice over two flags; "neither" is unreachable from here since it
   * empties the pool. Publishes nothing: `relayMetadata` is a read-only mirror
   * of kind 10002.
   */
  const setRelaySources = (value: string) => {
    updateConfig((current) => ({
      ...current,
      useAppRelays: value !== "published",
      useUserRelays: value !== "home",
    }));
  };
  const relaySources = config.useAppRelays
    ? (config.useUserRelays ? "both" : "home")
    : (config.useUserRelays ? "published" : "");

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

  const setShowDmPreviews = (value: boolean) => {
    updateConfig((current) => ({ ...current, showDmPreviews: value }));
  };

  const setShowRecentRailDms = (value: boolean) => {
    updateConfig((current) => ({ ...current, showRecentRailDms: value }));
  };

  /** Bypasses Discover's curated allow-list (a foot-gun). */
  const setDiscoverAllContent = (value: boolean) => {
    updateConfig((current) => ({ ...current, discoverAllContent: value }));
  };

  /**
   * Publish the user's kind 10050 with exactly the edited list — the one
   * legitimate reason to write it. No refetch, so an in-flight fetch can't
   * clobber the edit.
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
        { id: "muted-words", title: "Muted words", icon: SpellCheck },
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
      { id: "app-relays", title: "Relays", icon: Waypoints },
    );
    if (user) {
      appItems.push({ id: "sync", title: "Sync", icon: RefreshCw });
    }
    appItems.push(
      { id: "dms", title: "Direct messages", icon: MessageSquareLock },
      { id: "chat", title: "Chat", icon: MessageSquare },
      { id: "media", title: "Media privacy", icon: EyeOff },
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
      { heading: "Help", items: [{ id: "support", title: "Help & support", icon: LifeBuoy, inline: true }] },
    ];
    if (user) {
      groups.push({ heading: "Danger zone", items: [{ id: "danger", title: "Delete account", icon: AlertTriangle, inline: true }] });
    }
    return groups;
  }, [user, logins, canInstall, needsManualInstall, config.accountStandingSeen, openStanding]);

  // The user's published NIP-65 list (`relayMetadata`), read-only here; ignored when it belongs to another login.
  const ownsRelayList =
    !config.relayMetadata.pubkey || config.relayMetadata.pubkey === user?.pubkey;
  const userRelayUrls = ownsRelayList
    ? config.relayMetadata.relays.map((r) => r.url)
    : [];
  const userWriteRelayUrls = ownsRelayList
    ? config.relayMetadata.relays.filter((r) => r.write).map((r) => r.url)
    : [];

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
      case "muted-words":
        return <MutedWordsSettings />;
      case "notifications":
        return (
          <SettingsRow>
            <NotificationSettings />
          </SettingsRow>
        );
      case "appearance":
        return (
          <>
            <FontScaleSettings />
            <SettingsRow>
              <ThemeSelector />
            </SettingsRow>
          </>
        );
      case "desktop":
        return <DesktopSettings />;
      case "app-relays": {
        const targets = uploadTargets(config.blossomServerMetadata);
        const ownServers = config.blossomServerMetadata.servers.length > 0;
        const publishedMatchesHome =
          userRelayUrls.length === config.appRelays.length &&
          userRelayUrls.every((url) => config.appRelays.includes(url));
        const publishedOpen = searching || publishedListOpen;
        return (
          <>
            <SettingsRow>
              <p className="text-xs text-muted-foreground leading-snug">
                Relays are servers that store and pass along your profile, messages and lists.
                Armada picked these for you; change any of them here, just as at sign-up.
              </p>
            </SettingsRow>
            {!config.useAppRelays && !(config.useUserRelays && userRelayUrls.length > 0) && (
              <SettingsRow>
                <p className="text-sm text-destructive leading-snug">
                  No home relays in use. Your profile and lists won't load or sync
                  until you add one.
                </p>
              </SettingsRow>
            )}
            <SetupListRow
              label="Home"
              hint="Stores your profile, follows and settings."
              detail="Stores your profile, follows and settings. Every other list here may be empty; this one can't."
              urls={config.appRelays}
              open={relayRowOpen("home")}
              onOpenChange={setRelayRowOpen("home")}
              padX="px-4"
            >
              <RelayListEditor
                relays={config.appRelays}
                onChange={setAppRelays}
                onReset={() => setAppRelays([...APP_RELAYS])}
                emptyText="None. Add a relay, or reset to Armada's defaults."
              />
              {user && (
                <Collapsible
                  open={publishedOpen}
                  onOpenChange={setPublishedListOpen}
                  className="clip-corner bg-background/40"
                >
                  <CollapsibleTrigger asChild>
                    <button type="button" className="flex w-full items-start gap-3 px-3 py-2.5 text-left">
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="text-sm font-medium leading-tight">Published relay list</div>
                        <div className="text-xs text-muted-foreground leading-snug">
                          {userRelayUrls.length === 0
                            ? "Not published yet, so other Nostr apps can't find where your account lives. Publish your home relays to fix that."
                            : publishedMatchesHome
                              ? "Other Nostr apps find your account through this signed list (NIP-65). It matches your home relays."
                              : <>Other Nostr apps find your account through this signed list (NIP-65). It names {hostList(userRelayUrls)}, which differs from your home relays above.</>}
                        </div>
                      </div>
                      <ChevronDown
                        className={cn(
                          "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                          publishedOpen && "rotate-180",
                        )}
                      />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
                    <div className="px-3 pb-3">
                      <RelayBootstrapForm />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </SetupListRow>
            <SetupListRow
              label="Messages"
              hint="Other apps deliver your direct messages here."
              detail="Other apps deliver your direct messages here. Armada also checks your home relays."
              urls={config.dmRelays}
              open={relayRowOpen("dm")}
              onOpenChange={setRelayRowOpen("dm")}
              padX="px-4"
            >
              <DmInboxNotice />
              <RelayListEditor
                relays={config.dmRelays}
                onChange={setDmRelays}
                onReset={() => setDmRelays(recommendedDmInbox(config))}
                emptyText="None. Armada users can still reach you on your home relays; other apps can't."
                placeholder="wss://dm-relay.example.com"
              />
            </SetupListRow>
            <SetupListRow
              label="Search"
              hint="Used to find people and communities."
              detail="Used to find people and communities by name (NIP-50)."
              urls={config.searchRelays}
              open={relayRowOpen("search")}
              onOpenChange={setRelayRowOpen("search")}
              padX="px-4"
            >
              <RelayListEditor
                relays={config.searchRelays}
                onChange={setSearchRelays}
                onReset={() => setSearchRelays([...SEARCH_RELAYS])}
                emptyText="None. Search uses your home relays."
              />
            </SetupListRow>
            <SetupListRow
              label="Media"
              hint="Your uploads go here. Links use the first server."
              detail={(
                <>
                  Your uploads go here. A file is sent to every server in the list; links point
                  at the primary one, first in the list, and the others keep a copy in case it
                  goes away.
                  {!ownServers && (
                    " These are Armada's servers. Changing the list makes it your own and saves it to your account."
                  )}
                </>
              )}
              urls={targets.servers}
              kind="blossom"
              open={relayRowOpen("blossom")}
              onOpenChange={setRelayRowOpen("blossom")}
              padX="px-4"
            >
              <BlossomServerListEditor
                servers={targets.servers}
                primary={targets.preferred ?? null}
                defaults={!ownServers}
                onChange={setBlossomServers}
                onReset={() => setBlossomServers([...APP_BLOSSOM_SERVERS])}
              />
            </SetupListRow>
            <SetupListRow
              label="Communities"
              hint="Default relays for communities you create."
              detail="Default relays for communities you create. Each community can change its own afterwards."
              urls={config.communityRelays}
              open={relayRowOpen("community")}
              onOpenChange={setRelayRowOpen("community")}
              padX="px-4"
            >
              <RelayListEditor
                relays={config.communityRelays}
                onChange={setCommunityRelays}
                onReset={() => setCommunityRelays([...COMMUNITY_RELAYS])}
                emptyText="None. New communities use the shared Concord relays."
              />
            </SetupListRow>
            <SetupListRow
              label="Broadcast"
              hint="Extra relays your public profile is sent to."
              detail="Extra relays your public profile is sent to, so people on other Nostr apps see it. Armada never reads from them or sends messages here."
              urls={config.broadcastRelays}
              open={relayRowOpen("broadcast")}
              onOpenChange={setRelayRowOpen("broadcast")}
              padX="px-4"
            >
              <RelayListEditor
                relays={config.broadcastRelays}
                onChange={setBroadcastRelays}
                onReset={() => setBroadcastRelays([...BROADCAST_RELAYS])}
                emptyText="None. Your public profile goes only to your home relays."
              />
            </SetupListRow>
            <SettingsRow>
              <button
                type="button"
                aria-expanded={showAdvanced}
                className="flex w-full items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setRelaysAdvancedOpen((open) => !open)}
              >
                Advanced
                <ChevronDown className={cn("size-4 transition-transform duration-200", showAdvanced && "rotate-180")} />
              </button>
            </SettingsRow>
            {showAdvanced && (
              <>
                <SettingsRow
                  stack
                  label="Connect to"
                  description={userRelayUrls.length > 0
                    ? "Which relays Armada reads and writes your account data on: the Home list above, the relay list you published for other apps, or both."
                    : "Which relays Armada reads and writes your account data on. Publish a relay list under Home to choose it here."}
                >
                  <Select value={relaySources} onValueChange={setRelaySources}>
                    <SelectTrigger className="w-full sm:w-56" aria-label="Connect to">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="home">Home relays</SelectItem>
                      <SelectItem value="published" disabled={userRelayUrls.length === 0}>Published relay list</SelectItem>
                      <SelectItem value="both" disabled={userRelayUrls.length === 0}>Both</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingsRow>
              </>
            )}
          </>
        );
      }
      case "sync":
        return (
          <>
            <SettingsRow
              label="Automatic settings sync"
              description="Keep private settings and your DM list the same on your other devices. Applies to this device only."
            >
              <Switch
                checked={config.automaticSettingsSync !== false}
                onCheckedChange={setAutomaticSettingsSync}
              />
            </SettingsRow>
            {userWriteRelayUrls.length === 0 && (
              <SettingsRow>
                <p className="text-xs text-muted-foreground leading-snug">
                  Publish a relay list under Relays › Home to copy your lists, settings and
                  communities to your other devices.
                </p>
              </SettingsRow>
            )}
            {userWriteRelayUrls.length > 0 && (
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
                    variant="secondary"
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
      case "dms":
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
                <SettingsRow>
                  <p className="text-xs text-muted-foreground leading-snug">
                    Where messages from other apps arrive is under Relays › Messages.
                  </p>
                </SettingsRow>
                <SettingsRow
                  label="Message requests"
                  description="Show DMs from strangers under Requests. Off hides them."
                >
                  <Switch checked={config.showDmRequests} onCheckedChange={setShowDmRequests} />
                </SettingsRow>
                <SettingsRow
                  label="Message previews"
                  description="Show the latest message under each conversation in your DM list."
                >
                  <Switch checked={config.showDmPreviews} onCheckedChange={setShowDmPreviews} />
                </SettingsRow>
                <SettingsRow
                  label="Recent DMs in the rail"
                  description="Show unread DMs at the top of the server rail."
                >
                  <Switch checked={config.showRecentRailDms} onCheckedChange={setShowRecentRailDms} />
                </SettingsRow>
              </>
            )}
          </>
        );
      case "media":
        return <MediaPrivacySettings />;
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
            {user && <QuickReactionsSettings />}
            <SettingsRow
              label="Typing indicators"
              description="Share and see typing status in DMs and channels."
            >
              <Switch checked={config.dmTypingIndicators} onCheckedChange={setDmTypingIndicators} />
            </SettingsRow>
            {Capacitor.getPlatform() === "android" && (
              <SettingsRow
                label="Back leaves the app"
                description="Off, back switches between the channel list and the chat."
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
      case "support":
        return (
          <>
            <Link to="/support" className={SECTION_HEADER_CLASS}>
              <LifeBuoy className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-sm font-medium leading-tight">Help &amp; safety</div>
                <div className="text-xs text-muted-foreground leading-snug">
                  Blocking, hiding, muted words, reporting and getting help.
                </div>
              </div>
            </Link>
            <a href={`mailto:${SUPPORT_EMAIL}`} className={SECTION_HEADER_CLASS}>
              <Mail className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-sm font-medium leading-tight">Contact support</div>
                <div className="text-xs text-muted-foreground leading-snug">
                  Report inappropriate activity or ask for help at {SUPPORT_EMAIL}.
                </div>
              </div>
            </a>
          </>
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
      <header className="relative h-12 touch:h-[3.25rem] mx-gutter mt-1 sidebar:mt-3 w-[calc(100%-2*var(--gutter))] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
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
            <span aria-hidden className="text-muted-foreground/30">·</span>
            <Link to="/support" className="flex items-center gap-1 hover:text-muted-foreground transition-colors">
              <LifeBuoy className="size-3" />
              Support
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
