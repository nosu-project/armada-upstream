/**
 * Buzz protocol kind registry (client side).
 *
 * Buzz (https://github.com/block/buzz) is a NIP-29-based team-communication
 * relay heavily extended with custom kinds. Armada renders Buzz relays through
 * the shared NIP-29 pages, branching into this module for everything
 * Buzz-specific. The authoritative registry is buzz-core's `kind.rs`; the
 * client-relevant subset (and the timeline/aux kind-set semantics) mirrors the
 * Buzz desktop client's `shared/constants/kinds.ts`.
 */

// ── Shared NIP kinds (same numbers as lib/nip29.ts, re-declared for clarity) ─
/** NIP-09 deletion — a deletion marker alongside kind 9005. */
export const KIND_DELETE = 5;
/** NIP-25 reaction. Custom emoji rides `["emoji", shortcode, url]` (NIP-30). */
export const KIND_REACTION = 7;
/** Stream (chat) message — markdown content, `h` channel tag, NIP-10 threads. */
export const KIND_STREAM_MESSAGE = 9;
/** Buzz/moderator deletion (relay soft-deletes the target). */
export const KIND_BUZZ_DELETE_EVENT = 9005;

// ── Buzz stream extensions ───────────────────────────────────────────────────
/** Legacy pre-migration stream message (read-only; render like kind 9). */
export const KIND_STREAM_MESSAGE_LEGACY = 40001;
/** Stream message v2 "rich content" — treated identically to kind 9. */
export const KIND_STREAM_MESSAGE_V2 = 40002;
/** Message edit: `e` target, content = full replacement, imeta overlay. */
export const KIND_STREAM_MESSAGE_EDIT = 40003;
/** Diff message: unified diff in content, renders its own row. */
export const KIND_STREAM_MESSAGE_DIFF = 40008;
/** Relay-signed system message (JSON content: member_joined, topic_changed…). */
export const KIND_SYSTEM_MESSAGE = 40099;
/** Shared per-channel canvas document (content = the document text). */
export const KIND_CANVAS = 40100;

// ── Job lifecycle (agent jobs; rendered as timeline rows) ────────────────────
export const KIND_JOB_REQUEST = 43001;
export const KIND_JOB_ACCEPTED = 43002;
export const KIND_JOB_PROGRESS = 43003;
export const KIND_JOB_RESULT = 43004;
export const KIND_JOB_CANCEL = 43005;
export const KIND_JOB_ERROR = 43006;

// ── Forum channels ───────────────────────────────────────────────────────────
/** Forum post (root; content markdown, `h` + mentions + imeta tags). */
export const KIND_FORUM_POST = 45001;
/** Forum vote: content `+` / `-`, tags `h` + `e` target. */
export const KIND_FORUM_VOTE = 45002;
/** Forum comment (`h` + NIP-10 thread tags). */
export const KIND_FORUM_COMMENT = 45003;

// ── Huddles (voice) ─────────────────────────────────────────────────────────
/** Huddle session card (client-emitted when a huddle starts). */
export const KIND_HUDDLE_STARTED = 48100;
export const KIND_HUDDLE_PARTICIPANT_JOINED = 48101;
export const KIND_HUDDLE_PARTICIPANT_LEFT = 48102;
export const KIND_HUDDLE_ENDED = 48103;

// ── Ephemeral ────────────────────────────────────────────────────────────────
/** Presence heartbeat: content "online"/"away"/"offline", 90s TTL. */
export const KIND_PRESENCE = 20001;
/** Typing indicator: `h` channel tag + optional thread `e` tags. */
export const KIND_TYPING_INDICATOR = 20002;

// ── Membership / notifications ───────────────────────────────────────────────
/** Relay-signed member-added notification (p-gated: filter must carry #p=me). */
export const KIND_MEMBER_ADDED = 44100;
/** Relay-signed member-removed notification (p-gated). */
export const KIND_MEMBER_REMOVED = 44101;
/** Relay-signed replaceable relay-membership roster snapshot. */
export const KIND_RELAY_ROSTER = 13534;

// ── DMs (hidden NIP-29 channels) ────────────────────────────────────────────
/** DM open/re-open command: 1–8 `p` tags → relay creates a hidden channel. */
export const KIND_DM_OPEN = 41010;
/** Relay-signed per-viewer DM-visibility snapshot (hidden DM `h` tags). */
export const KIND_DM_VISIBILITY = 30622;

// ── Workflows ────────────────────────────────────────────────────────────────
/** Workflow definition (param-replaceable, `d` = workflow UUID, YAML content). */
export const KIND_WORKFLOW_DEFINITION = 30620;
/** Client-signed workflow trigger. */
export const KIND_WORKFLOW_TRIGGER = 46020;
/** Relay-emitted workflow execution events (46001–46012). */
export const KIND_WORKFLOW_RUN_FIRST = 46001;
export const KIND_WORKFLOW_RUN_LAST = 46012;

/**
 * Content kinds a workflow channel's timeline additionally renders: the
 * workflow definitions themselves plus any relay-emitted run/approval events
 * (the relay currently persists most run history DB-side, so these may be
 * sparse — approvals, kind 46010–46012, are the live ones).
 */
export const BUZZ_WORKFLOW_EXTRA_KINDS = [
  KIND_WORKFLOW_DEFINITION,
  KIND_WORKFLOW_TRIGGER,
  46001, 46002, 46003, 46004, 46005, 46006, 46007, 46010, 46011, 46012,
] as const;

// ── Agents (display-only surface) ────────────────────────────────────────────
/** Replaceable agent profile (content JSON: name, agent_type, status…). */
export const KIND_AGENT_PROFILE = 10100;
/** Persona definition (param-replaceable, public JSON content). */
export const KIND_PERSONA = 30175;

// ── Misc ────────────────────────────────────────────────────────────────────
/** NIP-51 emoji set; Buzz custom-emoji palette uses `d = "buzz:custom-emoji"`. */
export const KIND_EMOJI_SET = 30030;
/** The `d` tag identifying a member's Buzz custom-emoji set. */
export const BUZZ_EMOJI_SET_D = "buzz:custom-emoji";
/** NIP-38 user status. */
export const KIND_USER_STATUS = 30315;

// ── Kind sets (mirror the Buzz desktop client's timeline semantics) ─────────

/**
 * Visible content kinds the main stream timeline renders as their own rows.
 * Thread replies share these kinds and are partitioned out by their NIP-10
 * marked `e` tags (see protocol.ts). Forum kinds are NOT here — forum channels
 * use their own content set.
 */
export const BUZZ_TIMELINE_CONTENT_KINDS = [
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_LEGACY,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  KIND_JOB_REQUEST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_HUDDLE_STARTED,
] as const;

/**
 * Content kinds a forum channel's window loads. Posts (45001) render as
 * timeline rows; comments (45003) carry NIP-10 marked reply tags, so the fold
 * partitions them out of the timeline into per-root thread buckets (and a
 * `#e` thread backfill can find them). Both must be in the set — omitting
 * comments would drop them from the window entirely, so threads couldn't load.
 */
export const BUZZ_FORUM_CONTENT_KINDS = [KIND_FORUM_POST, KIND_FORUM_COMMENT] as const;

/**
 * Auxiliary (non-row) kinds that overlay onto or hide an existing message:
 * deletions and edits. Reactions (kind 7) are handled by the shared batched
 * reactions hook, and forum votes (45002) by the forum overlay.
 */
export const BUZZ_AUX_KINDS = [
  KIND_DELETE,
  KIND_BUZZ_DELETE_EVENT,
  KIND_STREAM_MESSAGE_EDIT,
] as const;

/**
 * The standing live-subscription kind set the wire holds per Buzz relay
 * (alongside `#h` = every known channel). Content rows + overlays + huddle
 * lifecycle + forum activity, so open timelines and unread badges stay live.
 */
export const BUZZ_WIRE_KINDS = [
  KIND_DELETE,
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
  KIND_BUZZ_DELETE_EVENT,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  KIND_JOB_REQUEST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_FORUM_COMMENT,
  KIND_HUDDLE_STARTED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_ENDED,
  KIND_CANVAS,
] as const;

/**
 * Human-visible "new content" kinds — the unread trigger set. System rows,
 * job lifecycle and huddle overlays are deliberately excluded (they land after
 * the last human message and would create phantom unreads).
 */
export const BUZZ_UNREAD_KINDS = [
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
] as const;
