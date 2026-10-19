/**
 * Buzz-specific timeline rows: system messages (40099), diffs (40008), huddle
 * cards (48100), workflows. Chat-like kinds and agent-job events render via ChatMessage.
 */

import { AudioLines, GitBranch, Workflow } from "lucide-react";
import { useMemo, useState } from "react";

import {
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
} from "@/buzz/kinds";
import { parseSystemMessage } from "@/buzz/protocol";
import { DisplayName } from "@/components/DisplayName";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { shortTimeAgo } from "@/lib/formatTime";
import { cn } from "@/lib/utils";
import { defineMessages, FormattedMessage, useIntl } from "@/i18n";

import type { NostrRumor } from "@/lib/nostrRumor";

function Name({ pubkey }: { pubkey: string | undefined }) {
  if (!pubkey) return null;
  return (
    <span className="font-medium text-foreground/80">
      <DisplayName pubkey={pubkey} />
    </span>
  );
}

function SystemLine({ icon, children, createdAt }: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  createdAt: number;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-xs text-muted-foreground">
      {icon ?? <span className="inline-block size-1.5 rounded-full bg-muted-foreground/40 shrink-0" />}
      <span className="min-w-0">{children}</span>
      <span className="shrink-0 text-3xs text-muted-foreground/60">{shortTimeAgo(createdAt)}</span>
    </div>
  );
}

/** Kind 40099: a relay-signed system message row ("Alice joined", …). */
export function BuzzSystemRow({ event }: { event: NostrRumor }) {
  const sys = useMemo(() => parseSystemMessage(event), [event]);
  if (!sys) {
    return <SystemLine createdAt={event.created_at}>
        <FormattedMessage id="buzzRows.systemEvent" defaultMessage="System event" />
      </SystemLine>;
  }
  const body = (() => {
    switch (sys.type) {
      case "member_joined":
        return <FormattedMessage id="buzzRows.memberJoined" defaultMessage="{name} joined the channel" values={{ name: <Name pubkey={sys.target ?? sys.actor} /> }} />;
      case "member_left":
        return <FormattedMessage id="buzzRows.memberLeft" defaultMessage="{name} left the channel" values={{ name: <Name pubkey={sys.target ?? sys.actor} /> }} />;
      case "channel_created":
        return <FormattedMessage id="buzzRows.channelCreated" defaultMessage="{name} created the channel" values={{ name: <Name pubkey={sys.actor} /> }} />;
      case "channel_deleted":
        return <FormattedMessage id="buzzRows.channelDeleted" defaultMessage="{name} deleted the channel" values={{ name: <Name pubkey={sys.actor} /> }} />;
      case "channel_archived":
        return <FormattedMessage id="buzzRows.channelArchived" defaultMessage="{name} archived the channel" values={{ name: <Name pubkey={sys.actor} /> }} />;
      case "channel_unarchived":
        return <FormattedMessage id="buzzRows.channelUnarchived" defaultMessage="{name} unarchived the channel" values={{ name: <Name pubkey={sys.actor} /> }} />;
      case "channel_auto_archived":
        return <FormattedMessage id="buzzRows.autoArchived" defaultMessage="Channel auto-archived after inactivity" />;
      case "topic_changed":
        return sys.topic ? (
          <FormattedMessage
            id="buzzRows.topicSet"
            defaultMessage="{name} set the topic: “{topic}”"
            values={{ name: <Name pubkey={sys.actor} />, topic: sys.topic }}
          />
        ) : (
          <FormattedMessage
            id="buzzRows.topicChanged"
            defaultMessage="{name} set the topic"
            values={{ name: <Name pubkey={sys.actor} /> }}
          />
        );
      case "purpose_changed":
        return <FormattedMessage id="buzzRows.purposeChanged" defaultMessage="{name} updated the channel purpose" values={{ name: <Name pubkey={sys.actor} /> }} />;
      case "visibility_changed":
        return (
          <FormattedMessage
            id="buzzRows.visibilityChanged"
            defaultMessage="{name} made the channel {visibility, select, private {private} other {public}}"
            values={{ name: <Name pubkey={sys.actor} />, visibility: sys.visibility === "private" ? "private" : "public" }}
          />
        );
      case "ttl_changed":
        return sys.ttlSeconds
          ? (
            <FormattedMessage
              id="buzzRows.ttlSet"
              defaultMessage="{name} set messages to expire after {duration}"
              values={{ name: <Name pubkey={sys.actor} />, duration: formatDuration(sys.ttlSeconds) }}
            />
          )
          : <FormattedMessage id="buzzRows.ttlDisabled" defaultMessage="{name} disabled message expiry" values={{ name: <Name pubkey={sys.actor} /> }} />;
      case "message_deleted":
        return <FormattedMessage id="buzzRows.messageDeleted" defaultMessage="{name} deleted a message" values={{ name: <Name pubkey={sys.actor} /> }} />;
      case "dm_created":
        return <FormattedMessage id="buzzRows.dmCreated" defaultMessage="Conversation started" />;
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

const DIFF_COLLAPSE_LINES = 16;

/** Kind 40008: a diff message — unified diff rendered as its own card. */
export function BuzzDiffRow({ event }: { event: NostrRumor }) {
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
      <div className="clip-hairline-lg [--fill:var(--secondary)/0.4] [--fill-hover:var(--secondary)/0.4] p-px overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs text-muted-foreground border-b border-border/60">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="font-medium text-foreground/80"><DisplayName pubkey={event.pubkey} name={name} /></span>
          {file && <code className="font-mono">{file}</code>}
          {commit && <code className="font-mono text-3xs opacity-70">{commit.slice(0, 8)}</code>}
          {repo && <span className="truncate max-w-48 opacity-70">{repo}</span>}
          <span className="ml-auto shrink-0 text-3xs text-muted-foreground/60">{shortTimeAgo(event.created_at)}</span>
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
                <FormattedMessage
                  id="buzzRows.showMoreLines"
                  defaultMessage="{count, plural, other {Show # more lines}}"
                  values={{ count: lines.length - DIFF_COLLAPSE_LINES }}
                />
              </button>
            )}
            {truncated && <span className="text-muted-foreground/60">
                <FormattedMessage id="buzzRows.diffTruncated" defaultMessage="diff truncated by the relay" />
              </span>}
          </div>
        )}
      </div>
    </div>
  );
}

const workflowLabels = defineMessages({
  triggered: { id: "buzzRows.workflow.triggered", defaultMessage: "Workflow triggered" },
  stepStarted: { id: "buzzRows.workflow.stepStarted", defaultMessage: "Step started" },
  stepCompleted: { id: "buzzRows.workflow.stepCompleted", defaultMessage: "Step completed" },
  stepFailed: { id: "buzzRows.workflow.stepFailed", defaultMessage: "Step failed" },
  completed: { id: "buzzRows.workflow.completed", defaultMessage: "Workflow completed" },
  failed: { id: "buzzRows.workflow.failed", defaultMessage: "Workflow failed" },
  cancelled: { id: "buzzRows.workflow.cancelled", defaultMessage: "Workflow cancelled" },
  approvalRequested: { id: "buzzRows.workflow.approvalRequested", defaultMessage: "Approval requested" },
  approvalGranted: { id: "buzzRows.workflow.approvalGranted", defaultMessage: "Approval granted" },
  approvalDenied: { id: "buzzRows.workflow.approvalDenied", defaultMessage: "Approval denied" },
  trigger: { id: "buzzRows.workflow.trigger", defaultMessage: "Workflow trigger" },
  event: { id: "buzzRows.workflow.event", defaultMessage: "Workflow event" },
});

/** Human label for a workflow execution kind (46001–46012, 46020 trigger). */
function workflowKindLabel(kind: number) {
  switch (kind) {
    case 46001: return workflowLabels.triggered;
    case 46002: return workflowLabels.stepStarted;
    case 46003: return workflowLabels.stepCompleted;
    case 46004: return workflowLabels.stepFailed;
    case 46005: return workflowLabels.completed;
    case 46006: return workflowLabels.failed;
    case 46007: return workflowLabels.cancelled;
    case 46010: return workflowLabels.approvalRequested;
    case 46011: return workflowLabels.approvalGranted;
    case 46012: return workflowLabels.approvalDenied;
    case 46020: return workflowLabels.trigger;
    default: return workflowLabels.event;
  }
}

/** Kinds 46001–46012 / 46020: a workflow run/approval lifecycle row. */
export function BuzzWorkflowEventRow({ event }: { event: NostrRumor }) {
  const preview = event.content.replace(/\s+/g, " ").trim();
  return (
    <SystemLine icon={<Workflow className="size-3.5 shrink-0" />} createdAt={event.created_at}>
      <span className="font-medium text-foreground/80">
        <FormattedMessage {...workflowKindLabel(event.kind)} />
      </span>
      {preview && <span className="opacity-80">: {preview.length > 160 ? `${preview.slice(0, 159)}…` : preview}</span>}
    </SystemLine>
  );
}

/** Kind 30620: a workflow definition card (name + collapsible YAML source). */
export function BuzzWorkflowDefinitionRow({ event }: { event: NostrRumor }) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const author = useAuthor(event.pubkey);
  const name = useScopedDisplayName(event.pubkey, author.data?.metadata);
  const label = useMemo(() => {
    const m = event.content.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    if (m) return m[1];
    return event.tags.find(([n]) => n === "d")?.[1] ?? intl.formatMessage({ id: "buzzRows.workflow.fallbackName", defaultMessage: "Workflow" });
  }, [event.content, event.tags, intl]);
  return (
    <div className="px-4 py-1.5">
      <div className="clip-hairline-lg [--fill:var(--secondary)/0.4] [--fill-hover:var(--secondary)/0.4] p-px overflow-hidden">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-foreground/5 transition-colors"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <Workflow className="size-4 shrink-0 text-primary/80" />
          <span className="font-medium truncate flex-1">{label}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            <FormattedMessage
              id="buzzRows.workflow.by"
              defaultMessage="by {name}"
              values={{ name: <DisplayName pubkey={event.pubkey} name={name} /> }}
            />
          </span>
          <span className="text-3xs text-muted-foreground/60 shrink-0">{shortTimeAgo(event.created_at)}</span>
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
  event: NostrRumor;
  /** All 48101/48102/48103 events in the loaded window (any huddle). */
  lifecycle: NostrRumor[];
}) {
  const author = useAuthor(event.pubkey);
  const name = useScopedDisplayName(event.pubkey, author.data?.metadata);

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
    const matches = (ev: NostrRumor) => {
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
      <div className="clip-hairline-lg [--fill:var(--secondary)/0.4] [--fill-hover:var(--secondary)/0.4] px-3 py-2.5 flex items-center gap-3">
        <AudioLines className={cn("size-5 shrink-0", ended ? "text-muted-foreground" : "text-success")} />
        <div className="min-w-0 flex-1">
          <div className="text-sm">
            <FormattedMessage
              id="buzzRows.huddle.title"
              defaultMessage="{name} <muted>{ended, select, yes {held a huddle} other {started a huddle}}</muted>"
              values={{
                name: <span className="font-medium"><DisplayName pubkey={event.pubkey} name={name} /></span>,
                ended: ended ? "yes" : "no",
                muted: (chunks) => <span className="text-muted-foreground">{chunks}</span>,
              }}
            />
          </div>
          {!ended && participants.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <FormattedMessage
                id="buzzRows.huddle.participants"
                defaultMessage="{count, plural, one {# participant} other {# participants}} in the huddle"
                values={{ count: participants.length }}
              />
            </div>
          )}
          {ended && (
            <div className="text-xs text-muted-foreground/70">
              <FormattedMessage id="buzzRows.huddle.ended" defaultMessage="Huddle ended" />
            </div>
          )}
        </div>
        <span className="shrink-0 text-3xs text-muted-foreground/60">{shortTimeAgo(event.created_at)}</span>
      </div>
    </div>
  );
}
