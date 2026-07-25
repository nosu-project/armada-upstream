/**
 * Buzz-specific timeline rows: relay-signed system messages (40099), diff
 * cards (40008), agent-job lifecycle rows (43001–43006) and huddle session
 * cards (48100). Chat-like kinds (9/40001/40002, forum posts/comments) render
 * through the shared ChatMessage instead.
 */

import { AudioLines, Bot, GitBranch, Workflow } from "lucide-react";
import { useMemo, useState } from "react";

import {
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
} from "@/buzz/kinds";
import { jobKindLabel, parseSystemMessage } from "@/buzz/protocol";
import { DisplayName } from "@/components/DisplayName";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { shortTimeAgo } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

import type { NostrEvent } from "@nostrify/nostrify";

/** Resolve a pubkey to its scoped display name (per-server nickname aware). */
function Name({ pubkey }: { pubkey: string | undefined }) {
  if (!pubkey) return null;
  return (
    <span className="font-medium text-foreground/80">
      <DisplayName pubkey={pubkey} />
    </span>
  );
}

/** The muted centered chrome every non-conversational row shares. */
function SystemLine({ icon, children, createdAt }: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  createdAt: number;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-xs text-muted-foreground">
      {icon ?? <span className="inline-block size-1.5 rounded-full bg-muted-foreground/40 shrink-0" />}
      <span className="min-w-0">{children}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground/60">{shortTimeAgo(createdAt)}</span>
    </div>
  );
}

/** Kind 40099: a relay-signed system message row ("Alice joined", …). */
export function BuzzSystemRow({ event }: { event: NostrEvent }) {
  const sys = useMemo(() => parseSystemMessage(event), [event]);
  if (!sys) {
    return <SystemLine createdAt={event.created_at}>System event</SystemLine>;
  }
  const body = (() => {
    switch (sys.type) {
      case "member_joined":
        return <><Name pubkey={sys.target ?? sys.actor} /> joined the channel</>;
      case "member_left":
        return <><Name pubkey={sys.target ?? sys.actor} /> left the channel</>;
      case "channel_created":
        return <><Name pubkey={sys.actor} /> created the channel</>;
      case "channel_deleted":
        return <><Name pubkey={sys.actor} /> deleted the channel</>;
      case "channel_archived":
        return <><Name pubkey={sys.actor} /> archived the channel</>;
      case "channel_unarchived":
        return <><Name pubkey={sys.actor} /> unarchived the channel</>;
      case "channel_auto_archived":
        return <>Channel auto-archived after inactivity</>;
      case "topic_changed":
        return <><Name pubkey={sys.actor} /> set the topic{sys.topic ? <>: “{sys.topic}”</> : null}</>;
      case "purpose_changed":
        return <><Name pubkey={sys.actor} /> updated the channel purpose</>;
      case "visibility_changed":
        return <><Name pubkey={sys.actor} /> made the channel {sys.visibility === "private" ? "private" : "public"}</>;
      case "ttl_changed":
        return sys.ttlSeconds
          ? <><Name pubkey={sys.actor} /> set messages to expire after {formatDuration(sys.ttlSeconds)}</>
          : <><Name pubkey={sys.actor} /> disabled message expiry</>;
      case "message_deleted":
        return <><Name pubkey={sys.actor} /> deleted a message</>;
      case "dm_created":
        return <>Conversation started</>;
      default:
        return <>{sys.type.replaceAll("_", " ")}</>;
    }
  })();
  return <SystemLine createdAt={event.created_at}>{body}</SystemLine>;
}

function formatDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** How many diff lines show before the card collapses behind "Show more". */
const DIFF_COLLAPSE_LINES = 16;

/** Kind 40008: a diff message — unified diff rendered as its own card. */
export function BuzzDiffRow({ event }: { event: NostrEvent }) {
  const author = useAuthor(event.pubkey);
  const name = useScopedDisplayName(event.pubkey, author.data?.metadata);
  const [expanded, setExpanded] = useState(false);

  const tag = (n: string) => event.tags.find(([t]) => t === n)?.[1];
  const repo = tag("repo");
  const commit = tag("commit");
  const file = tag("file");
  const description = tag("description");
  const truncated = event.tags.some(([n, v]) => n === "truncated" && v === "true");

  const lines = useMemo(() => event.content.split("\n"), [event.content]);
  const shown = expanded ? lines : lines.slice(0, DIFF_COLLAPSE_LINES);
  const collapsed = lines.length > DIFF_COLLAPSE_LINES && !expanded;

  return (
    <div className="px-4 py-1.5">
      <div className="clip-corner-lg border border-border/60 bg-secondary/40 overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs text-muted-foreground border-b border-border/60">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="font-medium text-foreground/80"><DisplayName pubkey={event.pubkey} name={name} /></span>
          {file && <code className="font-mono">{file}</code>}
          {commit && <code className="font-mono text-[10px] opacity-70">{commit.slice(0, 8)}</code>}
          {repo && <span className="truncate max-w-48 opacity-70">{repo}</span>}
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">{shortTimeAgo(event.created_at)}</span>
        </div>
        {description && (
          <div className="px-3 pt-2 text-sm whitespace-pre-wrap break-words">{description}</div>
        )}
        <pre className="m-0 px-3 py-2 overflow-x-auto text-xs leading-relaxed font-mono">
          {shown.map((line, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre",
                line.startsWith("+") && !line.startsWith("+++") && "text-success bg-success/10",
                line.startsWith("-") && !line.startsWith("---") && "text-destructive bg-destructive/10",
                (line.startsWith("@@") || line.startsWith("diff ")) && "text-primary/80",
              )}
            >
              {line || " "}
            </div>
          ))}
        </pre>
        {(collapsed || truncated) && (
          <div className="px-3 pb-2 flex items-center gap-2 text-xs">
            {collapsed && (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setExpanded(true)}
              >
                Show {lines.length - DIFF_COLLAPSE_LINES} more lines
              </button>
            )}
            {truncated && <span className="text-muted-foreground/60">diff truncated by the relay</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Kinds 43001–43006: an agent-job lifecycle row. */
export function BuzzJobRow({ event }: { event: NostrEvent }) {
  const preview = event.content.replace(/\s+/g, " ").trim();
  return (
    <SystemLine icon={<Bot className="size-3.5 shrink-0" />} createdAt={event.created_at}>
      <span className="font-medium text-foreground/80">{jobKindLabel(event.kind)}</span>
      {preview && <span className="opacity-80"> — {preview.length > 160 ? `${preview.slice(0, 159)}…` : preview}</span>}
      {" "}
      <Name pubkey={event.pubkey} />
    </SystemLine>
  );
}

/** Human label for a workflow execution kind (46001–46012, 46020 trigger). */
function workflowKindLabel(kind: number): string {
  switch (kind) {
    case 46001: return "Workflow triggered";
    case 46002: return "Step started";
    case 46003: return "Step completed";
    case 46004: return "Step failed";
    case 46005: return "Workflow completed";
    case 46006: return "Workflow failed";
    case 46007: return "Workflow cancelled";
    case 46010: return "Approval requested";
    case 46011: return "Approval granted";
    case 46012: return "Approval denied";
    case 46020: return "Workflow trigger";
    default: return "Workflow event";
  }
}

/** Kinds 46001–46012 / 46020: a workflow run/approval lifecycle row. */
export function BuzzWorkflowEventRow({ event }: { event: NostrEvent }) {
  const preview = event.content.replace(/\s+/g, " ").trim();
  return (
    <SystemLine icon={<Workflow className="size-3.5 shrink-0" />} createdAt={event.created_at}>
      <span className="font-medium text-foreground/80">{workflowKindLabel(event.kind)}</span>
      {preview && <span className="opacity-80"> — {preview.length > 160 ? `${preview.slice(0, 159)}…` : preview}</span>}
    </SystemLine>
  );
}

/** Kind 30620: a workflow definition card (name + collapsible YAML source). */
export function BuzzWorkflowDefinitionRow({ event }: { event: NostrEvent }) {
  const [expanded, setExpanded] = useState(false);
  const author = useAuthor(event.pubkey);
  const name = useScopedDisplayName(event.pubkey, author.data?.metadata);
  // Best-effort display name: a top-level `name:` key in the YAML, else the d tag.
  const label = useMemo(() => {
    const m = event.content.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    if (m) return m[1];
    return event.tags.find(([n]) => n === "d")?.[1] ?? "Workflow";
  }, [event.content, event.tags]);
  return (
    <div className="px-4 py-1.5">
      <div className="clip-corner-lg border border-border/60 bg-secondary/40 overflow-hidden">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-foreground/5 transition-colors"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <Workflow className="size-4 shrink-0 text-primary/80" />
          <span className="font-medium truncate flex-1">{label}</span>
          <span className="text-xs text-muted-foreground shrink-0">by <DisplayName pubkey={event.pubkey} name={name} /></span>
          <span className="text-[10px] text-muted-foreground/60 shrink-0">{shortTimeAgo(event.created_at)}</span>
        </button>
        {expanded && (
          <pre className="m-0 px-3 py-2 overflow-x-auto text-xs leading-relaxed font-mono border-t border-border/60 whitespace-pre">
            {event.content}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Kind 48100: a huddle session card, with joined/left/ended lifecycle folded
 * in by the caller (participants currently known + whether it ended).
 */
export function BuzzHuddleRow({ event, lifecycle }: {
  event: NostrEvent;
  /** All 48101/48102/48103 events in the loaded window (any huddle). */
  lifecycle: NostrEvent[];
}) {
  const author = useAuthor(event.pubkey);
  const name = useScopedDisplayName(event.pubkey, author.data?.metadata);

  // The huddle's ephemeral channel id links lifecycle events to this card.
  const huddleId = useMemo(() => {
    try {
      const raw = JSON.parse(event.content) as { ephemeral_channel_id?: string };
      return raw.ephemeral_channel_id;
    } catch {
      return undefined;
    }
  }, [event.content]);

  const { participants, ended } = useMemo(() => {
    const inHuddle = new Set<string>();
    let isEnded = false;
    const matches = (ev: NostrEvent) => {
      if (!huddleId) return false;
      try {
        const raw = JSON.parse(ev.content) as { ephemeral_channel_id?: string };
        return raw.ephemeral_channel_id === huddleId;
      } catch {
        return false;
      }
    };
    for (const ev of lifecycle) {
      if (!matches(ev)) continue;
      const p = ev.tags.find(([n]) => n === "p")?.[1];
      if (ev.kind === KIND_HUDDLE_PARTICIPANT_JOINED && p) inHuddle.add(p);
      else if (ev.kind === KIND_HUDDLE_PARTICIPANT_LEFT && p) inHuddle.delete(p);
      else if (ev.kind === KIND_HUDDLE_ENDED) isEnded = true;
    }
    return { participants: [...inHuddle], ended: isEnded };
  }, [lifecycle, huddleId]);

  return (
    <div className="px-4 py-1.5">
      <div className="clip-corner-lg border border-border/60 bg-secondary/40 px-3 py-2.5 flex items-center gap-3">
        <AudioLines className={cn("size-5 shrink-0", ended ? "text-muted-foreground" : "text-success")} />
        <div className="min-w-0 flex-1">
          <div className="text-sm">
            <span className="font-medium"><DisplayName pubkey={event.pubkey} name={name} /></span>{" "}
            <span className="text-muted-foreground">{ended ? "held a huddle" : "started a huddle"}</span>
          </div>
          {!ended && participants.length > 0 && (
            <div className="text-xs text-muted-foreground">
              {participants.length} participant{participants.length === 1 ? "" : "s"} in the huddle
            </div>
          )}
          {ended && <div className="text-xs text-muted-foreground/70">Huddle ended</div>}
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground/60">{shortTimeAgo(event.created_at)}</span>
      </div>
    </div>
  );
}
