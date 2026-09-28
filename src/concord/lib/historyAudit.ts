/**
 * Concord history audit — the completeness gate behind "ensure perfect history
 * before acting". No client can prove a relay handed over everything (EOSE is the
 * relay's word; see `planeSync.ts`), so this pure module reports instead:
 *
 *   1. coverage achieved (channels × held epochs, relays answering, epochs paged
 *      to their floor), from facts the orchestrator collected;
 *   2. every gap provable intrinsically (a reply root or edit target we don't hold)
 *      plus the fold's self-facts (`FoldedControl.incomplete`, truncation, quorum);
 *   3. a single {@link HistoryReport.ready} verdict with explicit {@link Blocker}s,
 *      so gates refuse a KNOWN-incomplete view.
 */

import { eTargetOf, replyTargetOf, type OpenedChat } from "@/concord/lib/chat";
import { KIND_COMMENT, KIND_EDIT } from "@/concord/lib/kinds";

/** One relay's participation in a sweep — what it answered, not what it holds. */
export interface RelayCoverage {
  url: string;
  /** Responded to at least one REQ (EOSE or events); silence doesn't count. */
  answered: boolean;
  /** Errored or timed out — its slice is unread. */
  failed: boolean;
}

/** One held epoch's coverage for a single channel. */
export interface EpochCoverage {
  /** Decimal string (bigint doesn't survive JSON). */
  epoch: string;
  /** Opened rumors (all kinds) attributed to this epoch in the collected set. */
  messageCount: number;
  /** A REQ was issued at this epoch's address (vs. skipped as unheld). */
  queried: boolean;
  /**
   * Paged to its floor on a quorum of relays — the strongest exhaustion signal
   * available, but not proof, so a non-exhausted queried epoch is a blocker.
   */
  exhausted: boolean;
}

/**
 * References to rumors NOT in the collected set — relay-independent evidence of
 * missing history. Only reply thread roots and edit targets count (they must
 * exist); reaction/zap/vote/delete targets may be legitimately deleted.
 */
export interface DanglingRefs {
  replyTargets: string[];
  editTargets: string[];
}

/** Everything the orchestrator collected for one channel, for the audit to judge. */
export interface ChannelCollection {
  channelIdHex: string;
  name: string;
  isPrivate: boolean;
  deleted: boolean;
  /** Raw opened rumors, ALL kinds (pre-fold), for the dangling analysis. */
  opened: OpenedChat[];
  /** Surviving timeline messages after {@link foldTimeline} — the export/count basis. */
  messageCount: number;
  /** Every held epoch a REQ was issued at, as decimal strings. */
  queriedEpochs: string[];
  /** The subset of {@link queriedEpochs} that paged to their floor on a quorum. */
  exhaustedEpochs: string[];
  /** Per-relay participation for this channel's sweep. */
  relays: RelayCoverage[];
}

/** Control-plane completeness facts, mostly lifted from the sweep + fold. */
export interface ControlCollection {
  /**
   * `FoldedControl.incomplete`: entities the served editions can't account for. A
   * hard blocker, since a Refounding MUST NOT compact while non-empty (CORD-06 §3).
   */
  incompleteEntities: string[];
  /** The control sweep stopped on our own event budget, not at a floor. */
  truncated: boolean;
  /** Enough of the community's relays answered the control sweep to trust coverage. */
  quorum: boolean;
  relays: RelayCoverage[];
  channelCount: number;
  memberCount: number;
}

export type BlockerKind =
  | "no-relays"
  | "control-incomplete"
  | "control-truncated"
  | "control-no-quorum"
  | "control-relay-failures"
  | "channel-not-exhausted"
  | "channel-relay-failures"
  | "dangling-references";

/** One reason the collected view is (or might be) incomplete. */
export interface Blocker {
  kind: BlockerKind;
  /** Human-readable specifics for the report UI. */
  detail: string;
  /** Set when the blocker is scoped to one channel. */
  channelIdHex?: string;
}

/** One channel's audited coverage. */
export interface ChannelAudit {
  channelIdHex: string;
  name: string;
  isPrivate: boolean;
  deleted: boolean;
  messageCount: number;
  /** All opened rumors incl. side events (the raw volume swept). */
  rawCount: number;
  epochs: EpochCoverage[];
  relays: RelayCoverage[];
  dangling: DanglingRefs;
  /** Every queried epoch reached its floor AND no relay failed (else `"channel-not-exhausted"`). */
  exhausted: boolean;
}

/** The control plane's audited coverage. */
export interface ControlAudit {
  incompleteEntities: string[];
  truncated: boolean;
  quorum: boolean;
  relays: RelayCoverage[];
  channelCount: number;
  memberCount: number;
}

export interface HistoryReport {
  communityIdHex: string;
  /** When the audit was computed (epoch ms). */
  generatedAtMs: number;
  control: ControlAudit;
  channels: ChannelAudit[];
  /** Sum of surviving timeline messages across channels. */
  totalMessages: number;
  /** No blockers: safe to act. Warnings are disclosed, not disqualifying. */
  ready: boolean;
  /** Reasons the view is known-incomplete; a non-empty list makes `ready` false. */
  blockers: Blocker[];
  /** Disclosed but non-fatal (e.g. dangling refs when not gated as blocking). */
  warnings: Blocker[];
}

export interface AuditOptions {
  /**
   * Treat dangling refs as blockers. Off by default (a member may legitimately lack
   * pre-join private history); set by callers about to COMPACT.
   */
  danglingIsBlocker?: boolean;
  /** Require every queried epoch to reach its floor (default on; off for a mere snapshot). */
  requireChannelExhaustion?: boolean;
}

export interface AuditInput {
  communityIdHex: string;
  control: ControlCollection;
  channels: ChannelCollection[];
  /** Clock injection for deterministic tests; defaults to `Date.now()`. */
  now?: number;
  options?: AuditOptions;
}

/**
 * A channel's dangling references. Per channel because the CORD-03 §3 binding keeps
 * references within their channel (a cross-channel target would be a binding violation).
 */
export function danglingRefsOf(opened: OpenedChat[]): DanglingRefs {
  const present = new Set(opened.map((o) => o.rumorId));
  const replyTargets = new Set<string>();
  const editTargets = new Set<string>();
  for (const ev of opened) {
    if (ev.kind === KIND_COMMENT) {
      const root = replyTargetOf(ev);
      if (root && !present.has(root)) replyTargets.add(root);
    } else if (ev.kind === KIND_EDIT) {
      const target = eTargetOf(ev);
      if (target && !present.has(target)) editTargets.add(target);
    }
  }
  return { replyTargets: [...replyTargets], editTargets: [...editTargets] };
}

/** Tally opened rumors per epoch, from each rumor's verified `epoch` coordinate. */
function epochCounts(opened: OpenedChat[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ev of opened) {
    const key = ev.epoch.toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function auditChannel(c: ChannelCollection, opts: Required<AuditOptions>): ChannelAudit {
  const counts = epochCounts(c.opened);
  const queried = new Set(c.queriedEpochs);
  const exhaustedEpochs = new Set(c.exhaustedEpochs);
  // Union queried epochs with any a rumor claims (itself coverage worth reporting).
  const epochKeys = new Set<string>([...queried, ...counts.keys()]);
  const epochs: EpochCoverage[] = [...epochKeys]
    .sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : BigInt(a) > BigInt(b) ? -1 : 0))
    .map((epoch) => ({
      epoch,
      messageCount: counts.get(epoch) ?? 0,
      queried: queried.has(epoch),
      exhausted: exhaustedEpochs.has(epoch),
    }));

  const dangling = danglingRefsOf(c.opened);
  // Only QUERIED epochs gate exhaustion.
  const allQueriedExhausted = c.queriedEpochs.every((e) => exhaustedEpochs.has(e));
  const exhausted =
    !opts.requireChannelExhaustion ||
    (allQueriedExhausted && !c.relays.some((r) => r.failed));

  return {
    channelIdHex: c.channelIdHex,
    name: c.name,
    isPrivate: c.isPrivate,
    deleted: c.deleted,
    messageCount: c.messageCount,
    rawCount: c.opened.length,
    epochs,
    relays: c.relays,
    dangling,
    exhausted,
  };
}

/**
 * Judge collected facts into a {@link HistoryReport}. Pure and deterministic, so
 * members never disagree about whether it's safe to act.
 */
export function auditHistory(input: AuditInput): HistoryReport {
  const opts: Required<AuditOptions> = {
    danglingIsBlocker: input.options?.danglingIsBlocker ?? false,
    requireChannelExhaustion: input.options?.requireChannelExhaustion ?? true,
  };
  const now = input.now ?? Date.now();

  const channels = input.channels.map((c) => auditChannel(c, opts));
  const blockers: Blocker[] = [];
  const warnings: Blocker[] = [];

  const control: ControlAudit = {
    incompleteEntities: input.control.incompleteEntities,
    truncated: input.control.truncated,
    quorum: input.control.quorum,
    relays: input.control.relays,
    channelCount: input.control.channelCount,
    memberCount: input.control.memberCount,
  };
  if (control.relays.length === 0) {
    blockers.push({ kind: "no-relays", detail: "the community has no readable relays" });
  }
  if (control.incompleteEntities.length > 0) {
    blockers.push({
      kind: "control-incomplete",
      detail: `${control.incompleteEntities.length} control entit${control.incompleteEntities.length === 1 ? "y is" : "ies are"} gap-held or unserved`,
    });
  }
  if (control.truncated) {
    blockers.push({
      kind: "control-truncated",
      detail: "the control sweep stopped on the local event budget before reaching the plane floor",
    });
  }
  if (!control.quorum) {
    blockers.push({
      kind: "control-no-quorum",
      detail: "too few of the community's relays answered the control sweep to trust coverage",
    });
  } else if (control.relays.some((r) => r.failed)) {
    warnings.push({
      kind: "control-relay-failures",
      detail: `${control.relays.filter((r) => r.failed).length} relay(s) failed the control sweep (quorum still met)`,
    });
  }

  for (const ch of channels) {
    if (opts.requireChannelExhaustion && !ch.exhausted) {
      const unreached = ch.epochs.filter((e) => e.queried && !e.exhausted).map((e) => e.epoch);
      blockers.push({
        kind: unreached.length ? "channel-not-exhausted" : "channel-relay-failures",
        detail: unreached.length
          ? `#${ch.name}: epoch(s) ${unreached.join(", ")} did not page to their floor`
          : `#${ch.name}: a relay failed mid-sweep, leaving part of the channel unread`,
        channelIdHex: ch.channelIdHex,
      });
    }
    const danglingCount = ch.dangling.replyTargets.length + ch.dangling.editTargets.length;
    if (danglingCount > 0) {
      const b: Blocker = {
        kind: "dangling-references",
        detail: `#${ch.name}: ${danglingCount} reference(s) to message(s) not in the collected history`,
        channelIdHex: ch.channelIdHex,
      };
      (opts.danglingIsBlocker ? blockers : warnings).push(b);
    }
  }

  const totalMessages = channels.reduce((n, c) => n + c.messageCount, 0);
  return {
    communityIdHex: input.communityIdHex,
    generatedAtMs: now,
    control,
    channels,
    totalMessages,
    ready: blockers.length === 0,
    blockers,
    warnings,
  };
}

/** A one-line human summary of a report's verdict, for logs and toasts. */
export function summarizeReport(report: HistoryReport): string {
  const scope = `${report.channels.length} channel(s), ${report.totalMessages} message(s)`;
  if (report.ready) {
    const warn = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
    return `history complete for this client: ${scope}${warn}`;
  }
  return `history INCOMPLETE (${report.blockers.length} blocker(s)): ${scope}`;
}
