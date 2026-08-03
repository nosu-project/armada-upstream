import type { NostrEvent } from "@nostrify/nostrify";
import { AlertTriangle, Check, Hash, Loader2, Lock, Plus, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { DiscordMark } from "@/components/ImportFromDiscord";
import { WizardShell, WizardStepBody } from "@/components/onboarding/WizardShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useCommunityActions2 } from "@/concord-v2/hooks/useCommunityActions2";
import { parseInviteLink } from "@/concord-v2/lib/invite";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import {
  BridgeApiError,
  confirmImport,
  connectDiscord,
  getBridgeMe,
  getImportStatus,
  prepareImport,
  previewImport,
  retryImport,
  bridgeToken,
  type BridgeMe,
  type ImportChannel,
  type ImportPlanView,
  type ImportStatus,
} from "@/lib/bridgeApi";
import { cn } from "@/lib/utils";

const STEPS = ["connect", "server", "review", "import", "done"] as const;
type Step = 0 | 1 | 2 | 3 | 4;

const errText = (e: unknown) =>
  e instanceof BridgeApiError || e instanceof Error ? e.message : "Something went wrong.";

/**
 * Import a Discord server into Armada, in-app.
 *
 * The portal does everything requiring a Discord secret (OAuth, bot reads, the
 * publish pipeline); this drives it over {@link bridgeApi}. The reason it lives
 * here rather than being a link to the portal: step 3 signs the community's
 * founding events, and the signer the user is already logged in with is right
 * here. Sending them to another origin to re-authenticate a Nostr identity they
 * have already proven is both worse UX and a worse habit to teach.
 *
 * The wizard is resumable only within a tab — the portal keeps the import row
 * server-side, but the token lives in `sessionStorage`.
 */
export function DiscordImportWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { join } = useCommunityActions2();

  const [step, setStep] = useState<Step>(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [me, setMe] = useState<BridgeMe | null>(null);
  const [guildId, setGuildId] = useState("");
  const [installUrl, setInstallUrl] = useState("");
  const [importId, setImportId] = useState("");
  const [plan, setPlan] = useState<ImportPlanView | null>(null);

  const [defaultRelays, setDefaultRelays] = useState<string[]>([]);
  const [relays, setRelays] = useState<string[]>([]);
  const [editRelays, setEditRelays] = useState(false);
  const [newRelay, setNewRelay] = useState("");
  const [consent, setConsent] = useState(false);

  const [signingStep, setSigningStep] = useState("");
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [joining, setJoining] = useState(false);

  // ── Session ───────────────────────────────────────────────────────────────

  const loadMe = useCallback(async () => {
    try {
      const res = await getBridgeMe();
      setMe(res);
      if (res.user) setStep((s) => (s === 0 ? 1 : s));
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  // A token from earlier in this tab means we can skip the connect step.
  useEffect(() => {
    if (bridgeToken()) void loadMe();
    else void getBridgeMe().then(setMe).catch(() => {});
  }, [loadMe]);

  async function handleConnect() {
    setBusy(true);
    setError("");
    try {
      await connectDiscord();
      await loadMe();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  // ── Preview ───────────────────────────────────────────────────────────────

  async function preview(gid: string) {
    setBusy(true);
    setError("");
    setInstallUrl("");
    try {
      const res = await previewImport(gid);
      if (!res.present) {
        setInstallUrl(res.installUrl);
        return;
      }
      setImportId(res.importId);
      setPlan(res.plan);
      setDefaultRelays(res.defaultRelays);
      setRelays(res.defaultRelays);
      setStep(2);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleChannel(discordId: string, field: "selected" | "bridge" | "history") {
    setPlan((prev) =>
      !prev
        ? prev
        : {
            ...prev,
            channels: prev.channels.map((c) => {
              if (c.discordId !== discordId) return c;
              // Each flag implies the one above it: history needs a live
              // bridge, a live bridge needs the channel itself.
              if (field === "selected") {
                const selected = !c.selected;
                return { ...c, selected, bridge: selected && c.bridge, history: selected && c.history };
              }
              if (field === "bridge") {
                const bridge = !c.bridge;
                return { ...c, bridge, history: bridge && c.history };
              }
              return { ...c, history: !c.history };
            }),
          },
    );
  }

  // ── Sign + confirm ────────────────────────────────────────────────────────

  async function startImport() {
    if (!plan || !user) return;
    setBusy(true);
    setError("");
    try {
      setSigningStep("Preparing the community…");
      const prep = await prepareImport(importId, {
        ownerNpub: user.pubkey,
        relays: editRelays ? relays : undefined,
        channels: plan.channels.map((c) => ({
          discordId: c.discordId,
          selected: c.selected,
          bridge: c.bridge,
          history: c.history,
        })),
      });

      const signed: NostrEvent[] = [];
      for (let i = 0; i < prep.templates.length; i++) {
        setSigningStep(`Signing as owner (${i + 1} of ${prep.templates.length})…`);
        signed.push(await user.signer.signEvent(prep.templates[i].template));
      }

      setSigningStep("");
      await confirmImport(importId, signed);
      setStep(3);
    } catch (e) {
      setSigningStep("");
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  // ── Progress polling ──────────────────────────────────────────────────────

  const importIdRef = useRef(importId);
  importIdRef.current = importId;
  useEffect(() => {
    if (step !== 3) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await getImportStatus(importIdRef.current);
        if (stop) return;
        setStatus(res);
        setPlan(res.plan);
        if (res.status === "done") {
          setStep(4);
          return;
        }
      } catch {
        // Transient (the portal restarts mid-import); keep polling.
      }
      if (!stop) timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [step]);

  async function retry() {
    setError("");
    try {
      await retryImport(importId);
      setStatus(null);
    } catch (e) {
      setError(errText(e));
    }
  }

  /**
   * Open the finished community. The owner signed its genesis, but this client
   * still has no local membership state for it — so this is the same join any
   * invite does, just without making them copy a link between tabs.
   */
  async function openCommunity() {
    if (!status?.inviteUrl) return;
    setJoining(true);
    setError("");
    try {
      const invite = parseInviteLink(status.inviteUrl);
      if (!invite) throw new Error("The portal returned an invite link Armada couldn't read.");
      const { communityId, name } = await join({ invite });
      toast({ title: "Imported from Discord", description: name });
      onClose();
      navigate(`/c/${encodeURIComponent(communityId)}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setJoining(false);
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const guilds = me?.guilds ?? [];
  const selected = plan?.channels.filter((c) => c.selected) ?? [];
  const bridged = selected.filter((c) => c.bridge);
  const published = selected.filter((c) => c.publishedAt);
  const wired = plan?.channels.filter((c) => c.bridgeId) ?? [];
  const historyCount = plan?.channels.reduce((n, c) => n + (c.historyImported ?? 0), 0) ?? 0;
  const newRelayValid = /^wss?:\/\/\S+$/.test(newRelay.trim()) && !relays.includes(newRelay.trim());

  const back = useMemo(() => {
    if (step === 1 && installUrl) return () => setInstallUrl("");
    if (step === 1) return () => setStep(0);
    if (step === 2) return () => { setPlan(null); setStep(1); };
    return undefined; // Past the point of no return: the import is running.
  }, [step, installUrl]);

  return (
    <WizardShell
      index={step}
      total={STEPS.length}
      stepKey={`${STEPS[step]}${installUrl ? "-install" : ""}`}
      maxWidth={step === 2 ? "max-w-xl" : "max-w-md"}
      zClassName="z-[250]"
      onBack={back}
      onClose={step === 3 ? undefined : onClose}
    >
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {step === 0 && (
        <ConnectStep me={me} busy={busy} onConnect={handleConnect} />
      )}

      {step === 1 && !installUrl && (
        <ServerStep
          guilds={guilds}
          guildId={guildId}
          busy={busy}
          onPick={setGuildId}
          onContinue={() => void preview(guildId)}
        />
      )}

      {step === 1 && installUrl && (
        <InstallBotStep
          installUrl={installUrl}
          busy={busy}
          onRecheck={() => void preview(guildId)}
        />
      )}

      {step === 2 && plan && (
        <ReviewStep
          plan={plan}
          relays={relays}
          defaultRelays={defaultRelays}
          editRelays={editRelays}
          newRelay={newRelay}
          newRelayValid={newRelayValid}
          consent={consent}
          busy={busy}
          signingStep={signingStep}
          signedIn={Boolean(user)}
          selectedCount={selected.length}
          bridgeCount={bridged.length}
          onToggleChannel={toggleChannel}
          onSetConsent={setConsent}
          onEditRelays={() => setEditRelays(true)}
          onNewRelay={setNewRelay}
          onAddRelay={() => {
            if (!newRelayValid) return;
            setRelays([...relays, newRelay.trim()]);
            setNewRelay("");
          }}
          onRemoveRelay={(r) => setRelays(relays.filter((x) => x !== r))}
          onResetRelays={() => {
            setRelays(defaultRelays);
            setEditRelays(false);
            setNewRelay("");
          }}
          onStart={() => void startImport()}
        />
      )}

      {step === 3 && (
        <ProgressStep
          plan={plan}
          status={status}
          selectedCount={selected.length}
          publishedCount={published.length}
          bridgeCount={bridged.length}
          wiredCount={wired.length}
          historyCount={historyCount}
          onRetry={() => void retry()}
        />
      )}

      {step === 4 && (
        <DoneStep
          plan={plan}
          status={status}
          publishedCount={published.length}
          wiredCount={wired.length}
          historyCount={historyCount}
          joining={joining}
          onOpen={() => void openCommunity()}
        />
      )}
    </WizardShell>
  );
}

// ── Steps ───────────────────────────────────────────────────────────────────

const glyph = <DiscordMark className="size-14 text-[#5865F2]" />;

function ConnectStep({
  me,
  busy,
  onConnect,
}: {
  me: BridgeMe | null;
  busy: boolean;
  onConnect: () => void;
}) {
  if (me && !me.discordConfigured) {
    return (
      <WizardStepBody
        glyph={glyph}
        title="not available here"
        description="This bridge portal has no Discord application configured, so it can't import servers. That's an operator setting, not something you can fix from here."
      >
        <span />
      </WizardStepBody>
    );
  }

  return (
    <WizardStepBody
      glyph={glyph}
      title="import from discord"
      description="Turn a Discord server you run into an encrypted Armada community — channels, roles, custom emoji, and optionally its message history. You'll sign for it with your own key, so you own it outright."
    >
      <div className="w-full space-y-3">
        <Button size="lg" className="h-12 w-full clip-corner-lg text-base" disabled={busy} onClick={onConnect}>
          {busy ? (
            <><Loader2 className="size-4 mr-2 animate-spin" /> Waiting for Discord…</>
          ) : (
            <><DiscordMark className="size-4 mr-2" /> Connect Discord</>
          )}
        </Button>
        <p className="text-xs text-muted-foreground">
          Opens Discord's sign-in in a new window. Armada never sees your Discord
          password, and only servers where you hold Manage Server are listed.
        </p>
      </div>
    </WizardStepBody>
  );
}

function ServerStep({
  guilds,
  guildId,
  busy,
  onPick,
  onContinue,
}: {
  guilds: Array<{ id: string; name: string; icon?: string }>;
  guildId: string;
  busy: boolean;
  onPick: (id: string) => void;
  onContinue: () => void;
}) {
  return (
    <WizardStepBody
      glyph={glyph}
      title="pick a server"
      description="The whole server becomes a brand-new Armada community that you own. Only servers where you hold Manage Server are shown."
    >
      <div className="w-full space-y-3">
        {guilds.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No servers found where you hold Manage Server.
          </p>
        )}
        <div className="space-y-1.5">
          {guilds.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => onPick(g.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors",
                guildId === g.id
                  ? "border-primary bg-primary/10"
                  : "border-border bg-secondary/40 hover:bg-secondary/70",
              )}
            >
              {g.icon ? (
                <img src={g.icon} alt="" className="size-9 shrink-0 rounded-full" referrerPolicy="no-referrer" />
              ) : (
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted font-mono text-xs">
                  {g.name.slice(0, 2).toLowerCase()}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
              {guildId === g.id && <Check className="size-4 shrink-0 text-primary" />}
            </button>
          ))}
        </div>
        <Button
          size="lg"
          className="h-12 w-full clip-corner-lg text-base"
          disabled={!guildId || busy}
          onClick={onContinue}
        >
          {busy ? <><Loader2 className="size-4 mr-2 animate-spin" /> Reading the server…</> : "Continue"}
        </Button>
      </div>
    </WizardStepBody>
  );
}

function InstallBotStep({
  installUrl,
  busy,
  onRecheck,
}: {
  installUrl: string;
  busy: boolean;
  onRecheck: () => void;
}) {
  return (
    <WizardStepBody
      glyph={glyph}
      title="install the bot"
      description="The bridge bot isn't in this server yet. It's what reads the channels and mirrors messages, so it has to be invited before the import can read anything."
    >
      <div className="w-full space-y-3">
        <Button asChild size="lg" className="h-12 w-full clip-corner-lg text-base">
          <a href={installUrl} target="_blank" rel="noopener noreferrer">
            <DiscordMark className="size-4 mr-2" /> Install the bot
          </a>
        </Button>
        <Button variant="outline" className="w-full clip-corner-lg" disabled={busy} onClick={onRecheck}>
          {busy ? <><Loader2 className="size-4 mr-2 animate-spin" /> Checking…</> : "I installed it — check again"}
        </Button>
      </div>
    </WizardStepBody>
  );
}

function ChannelRow({
  channel,
  historyAllowed,
  onToggle,
}: {
  channel: ImportChannel;
  historyAllowed: boolean;
  onToggle: (field: "selected" | "bridge" | "history") => void;
}) {
  const Icon = channel.private ? Lock : channel.kind === "voice" ? Volume2 : Hash;
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary/50">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
        <Checkbox checked={channel.selected} onCheckedChange={() => onToggle("selected")} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm">{channel.name}</span>
        {channel.category && (
          <span className="shrink-0 truncate text-xs text-muted-foreground">· {channel.category}</span>
        )}
      </label>
      {channel.bridgeable && (
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
          <Checkbox
            checked={channel.bridge}
            disabled={!channel.selected}
            onCheckedChange={() => onToggle("bridge")}
          />
          <span className="text-xs text-muted-foreground">bridge</span>
        </label>
      )}
      {channel.bridgeable && historyAllowed && (
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
          <Checkbox
            checked={channel.history}
            disabled={!channel.selected || !channel.bridge}
            onCheckedChange={() => onToggle("history")}
          />
          <span className="text-xs text-muted-foreground">history</span>
        </label>
      )}
    </div>
  );
}

function ReviewStep(props: {
  plan: ImportPlanView;
  relays: string[];
  defaultRelays: string[];
  editRelays: boolean;
  newRelay: string;
  newRelayValid: boolean;
  consent: boolean;
  busy: boolean;
  signingStep: string;
  signedIn: boolean;
  selectedCount: number;
  bridgeCount: number;
  onToggleChannel: (id: string, field: "selected" | "bridge" | "history") => void;
  onSetConsent: (v: boolean) => void;
  onEditRelays: () => void;
  onNewRelay: (v: string) => void;
  onAddRelay: () => void;
  onRemoveRelay: (r: string) => void;
  onResetRelays: () => void;
  onStart: () => void;
}) {
  const { plan } = props;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-3 text-center">
        {plan.guild.iconUrl ? (
          <img src={plan.guild.iconUrl} alt="" className="size-14 rounded-2xl" referrerPolicy="no-referrer" />
        ) : (
          glyph
        )}
        <div className="space-y-1.5">
          <h1 className="font-mono text-2xl font-bold lowercase tracking-tight">{plan.communityName}</h1>
          <p className="text-sm text-muted-foreground">
            {props.selectedCount} {props.selectedCount === 1 ? "channel" : "channels"} ·{" "}
            {props.bridgeCount} live-bridged · {plan.roles.length}{" "}
            {plan.roles.length === 1 ? "role" : "roles"}
          </p>
        </div>
      </div>

      <Section title="Channels">
        <div className="rounded-lg bg-secondary/30 p-1">
          {plan.channels.map((c) => (
            <ChannelRow
              key={c.discordId}
              channel={c}
              historyAllowed={plan.historyAllowed}
              onToggle={(f) => props.onToggleChannel(c.discordId, f)}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {plan.historyAllowed
            ? "History imports the newest 10,000 messages per channel, keeping their original times and authors."
            : `Message history isn't available for servers with more than 100 members${
                plan.memberCount ? ` (this one has about ${plan.memberCount})` : ""
              }.`}
        </p>
        {plan.emojis.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {plan.emojis.length} custom emoji will be published as an Armada emoji pack.
          </p>
        )}
        {plan.channels.some((c) => c.private) && (
          <p className="text-xs text-muted-foreground">
            <Lock className="mr-1 inline size-3" />
            Gated channels import as private — key-gated, invisible to members
            without the role. Mirroring one is off unless you turn it on.
          </p>
        )}
      </Section>

      {/* Only once they've actually ticked one: a warning about a thing you
          didn't choose is noise, and teaches people to skip the real ones. */}
      {plan.channels.some((c) => c.private && c.selected && c.bridge) && (
        <Alert variant="destructive">
          <Lock className="size-4" />
          <AlertDescription className="text-xs leading-relaxed">
            You're mirroring a private channel. Its key is handed to the bridge's
            own identity so it can read the room, and everything posted there is
            copied to Discord in plaintext — a gated room on this side is an
            ordinary Discord channel on the other. You can revoke the bridge's
            access from the channel's role in Armada at any time; note that doing
            so rotates the key, and the bridge stays silent on that channel until
            you re-grant it.
          </AlertDescription>
        </Alert>
      )}

      {plan.roles.length > 0 && (
        <Section title="Roles">
          <div className="space-y-1">
            {plan.roles.map((r) => (
              <p key={r.discordId} className="text-sm">
                {r.name}
                {r.dropped.length > 0 && (
                  <span className="text-xs text-muted-foreground"> · loses {r.dropped.join(", ")}</span>
                )}
              </p>
            ))}
          </div>
        </Section>
      )}

      {plan.skipped.length > 0 && (
        <Section title="Not imported">
          <div className="space-y-1">
            {plan.skipped.map((s, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                {s.name} — {s.reason}
              </p>
            ))}
          </div>
        </Section>
      )}

      <Section title="Relays">
        <div className="space-y-1">
          {props.relays.map((r) => (
            <div key={r} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{r}</span>
              {props.editRelays && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${r}`}
                  onClick={() => props.onRemoveRelay(r)}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
        {!props.editRelays ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline hover:text-foreground"
            onClick={props.onEditRelays}
          >
            Change relays
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                value={props.newRelay}
                onChange={(e) => props.onNewRelay(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    props.onAddRelay();
                  }
                }}
                placeholder="wss://relay.example.com"
                className="h-9 min-w-0 font-mono text-xs"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-9 shrink-0"
                aria-label="Add relay"
                disabled={!props.newRelayValid}
                onClick={props.onAddRelay}
              >
                <Plus className="size-4" />
              </Button>
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground underline hover:text-foreground"
              onClick={props.onResetRelays}
            >
              Reset to the standard set
            </button>
          </div>
        )}
      </Section>

      <Alert>
        <AlertTriangle className="size-4" />
        <AlertDescription className="text-xs leading-relaxed">
          You'll sign the community's founding events with your key, in this app — it
          never leaves your device, and the community is yours. The bridge keeps an
          Admin role to run the import and the live bridges; you can revoke it from
          Armada at any time. <strong>Bridged channels leave end-to-end encryption:</strong>{" "}
          their messages are mirrored to Discord in plaintext. The import runs once and
          can't be undone from here.
        </AlertDescription>
      </Alert>

      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox
          checked={props.consent}
          onCheckedChange={(v) => props.onSetConsent(v === true)}
          className="mt-0.5"
        />
        <span className="text-xs leading-relaxed text-muted-foreground">
          I understand that I own this community, and that bridged channels are not
          end-to-end encrypted.
        </span>
      </label>

      <Button
        size="lg"
        className="h-12 w-full clip-corner-lg text-base"
        disabled={
          !props.consent ||
          !props.signedIn ||
          props.selectedCount === 0 ||
          props.relays.length === 0 ||
          props.busy
        }
        onClick={props.onStart}
      >
        {props.signingStep ? (
          <><Loader2 className="size-4 mr-2 animate-spin" /> {props.signingStep}</>
        ) : props.busy ? (
          <><Loader2 className="size-4 mr-2 animate-spin" /> Working…</>
        ) : (
          "Import the server"
        )}
      </Button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 text-left">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      {children}
    </div>
  );
}

function ProgressStep({
  plan,
  status,
  selectedCount,
  publishedCount,
  bridgeCount,
  wiredCount,
  historyCount,
  onRetry,
}: {
  plan: ImportPlanView | null;
  status: ImportStatus | null;
  selectedCount: number;
  publishedCount: number;
  bridgeCount: number;
  wiredCount: number;
  historyCount: number;
  onRetry: () => void;
}) {
  const failed = status?.status === "failed";
  const rows: Array<[string, string]> = [
    ["community", plan?.checkpoints?.communityIdHex ? "minted, owned by your key" : "minting…"],
    ["channels published", `${publishedCount} / ${selectedCount}`],
    ["roles published", `${plan?.roles.filter((r) => r.publishedAt).length ?? 0} / ${plan?.roles.length ?? 0}`],
    ["bridges wired", `${wiredCount} / ${bridgeCount}`],
  ];
  if (plan?.historyAllowed && plan.channels.some((c) => c.history)) {
    rows.push([
      "history messages",
      `${historyCount}${status?.status === "history" ? " (importing…)" : ""}`,
    ]);
  }

  return (
    <WizardStepBody
      glyph={failed ? <AlertTriangle className="size-14 text-destructive" /> : (
        <Loader2 className="size-14 animate-spin text-[#5865F2]" />
      )}
      title={failed ? "import stopped" : "importing…"}
      description={
        failed
          ? "The import stopped partway. Nothing is lost — retrying picks up where it left off."
          : "Minting the community, publishing channels and roles, then wiring the live bridges. This can take a few minutes for a big server."
      }
    >
      <div className="w-full space-y-3">
        <div className="space-y-1 rounded-lg bg-secondary/40 p-3 text-left">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-foreground">{label}</span>
              <span className="font-mono text-xs">{value}</span>
            </div>
          ))}
        </div>
        {failed && (
          <>
            {status?.statusDetail && (
              <Alert variant="destructive">
                <AlertDescription className="text-xs">{status.statusDetail}</AlertDescription>
              </Alert>
            )}
            <Button className="w-full clip-corner-lg" onClick={onRetry}>
              Retry from where it stopped
            </Button>
          </>
        )}
      </div>
    </WizardStepBody>
  );
}

function DoneStep({
  plan,
  status,
  publishedCount,
  wiredCount,
  historyCount,
  joining,
  onOpen,
}: {
  plan: ImportPlanView | null;
  status: ImportStatus | null;
  publishedCount: number;
  wiredCount: number;
  historyCount: number;
  joining: boolean;
  onOpen: () => void;
}) {
  const bits = [
    `${publishedCount} ${publishedCount === 1 ? "channel" : "channels"}`,
    wiredCount > 0 ? `${wiredCount} live ${wiredCount === 1 ? "bridge" : "bridges"}` : null,
    historyCount > 0 ? `${historyCount} history messages` : null,
    plan && plan.emojis.length > 0 ? `${plan.emojis.length} custom emoji` : null,
  ].filter(Boolean);

  return (
    <WizardStepBody
      glyph={<Check className="size-14 text-success" />}
      title={`${plan?.communityName ?? "your community"} is live`}
      description={`${bits.join(", ")} — owned by your key.`}
    >
      <div className="w-full space-y-3">
        <Button
          size="lg"
          className="h-12 w-full clip-corner-lg text-base"
          disabled={joining || !status?.inviteUrl}
          onClick={onOpen}
        >
          {joining ? <><Loader2 className="size-4 mr-2 animate-spin" /> Opening…</> : "Open your community"}
        </Button>
        {plan && plan.skipped.length > 0 && (
          <div className="space-y-1 rounded-lg bg-secondary/40 p-3 text-left">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Not imported
            </span>
            {plan.skipped.map((s, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                {s.name} — {s.reason}
              </p>
            ))}
          </div>
        )}
      </div>
    </WizardStepBody>
  );
}
