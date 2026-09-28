/**
 * Buzz (https://github.com/block/buzz) protocol kind registry, client side.
 * Authoritative source: buzz-core's `kind.rs`; kind-set semantics mirror the
 * Buzz desktop client's `shared/constants/kinds.ts`.
 */

/** NIP-09 deletion — a deletion marker alongside kind 9005. */
export const KIND_DELETE = 5;
/** NIP-25 reaction. Custom emoji rides `["emoji", shortcode, url]` (NIP-30). */
export const KIND_REACTION = 7;
/** Stream (chat) message — markdown content, `h` channel tag, NIP-10 threads. */
export const KIND_STREAM_MESSAGE = 9;
/** Buzz/moderator deletion (relay soft-deletes the target). */
export const KIND_BUZZ_DELETE_EVENT = 9005;

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

// Job lifecycle (agent jobs; rendered as timeline rows)
export const KIND_JOB_REQUEST = 43001;
export const KIND_JOB_ACCEPTED = 43002;
export const KIND_JOB_PROGRESS = 43003;
export const KIND_JOB_RESULT = 43004;
export const KIND_JOB_CANCEL = 43005;
export const KIND_JOB_ERROR = 43006;

/** Forum post (root; content markdown, `h` + mentions + imeta tags). */
export const KIND_FORUM_POST = 45001;
/** Forum vote: content `+` / `-`, tags `h` + `e` target. */
export const KIND_FORUM_VOTE = 45002;
/** Forum comment (`h` + NIP-10 thread tags). */
export const KIND_FORUM_COMMENT = 45003;

/** Huddle session card (client-emitted when a huddle starts). */
export const KIND_HUDDLE_STARTED = 48100;
export const KIND_HUDDLE_PARTICIPANT_JOINED = 48101;
export const KIND_HUDDLE_PARTICIPANT_LEFT = 48102;
export const KIND_HUDDLE_ENDED = 48103;

/** Presence heartbeat: content "online"/"away"/"offline", 90s TTL. */
export const KIND_PRESENCE = 20001;
/** Typing indicator: `h` channel tag + optional thread `e` tags. */
export const KIND_TYPING_INDICATOR = 20002;

/** DM open/re-open command: 1–8 `p` tags → relay creates a hidden channel. */
export const KIND_DM_OPEN = 41010;
/** Relay-signed per-viewer DM-visibility snapshot (hidden DM `h` tags). */
export const KIND_DM_VISIBILITY = 30622;

/** Workflow definition (param-replaceable, `d` = workflow UUID, YAML content). */
export const KIND_WORKFLOW_DEFINITION = 30620;
/** Client-signed workflow trigger. */
export const KIND_WORKFLOW_TRIGGER = 46020;
/**
 * Extra content kinds a workflow channel renders: definitions plus relay-emitted
 * run/approval events (sparse; approvals 46010–46012 are the live ones).
 */
export const BUZZ_WORKFLOW_EXTRA_KINDS = [
  KIND_WORKFLOW_DEFINITION,
  KIND_WORKFLOW_TRIGGER,
  46001, 46002, 46003, 46004, 46005, 46006, 46007, 46010, 46011, 46012,
] as const;

/** NIP-51 emoji set; Buzz custom-emoji palette uses `d = "buzz:custom-emoji"`. */
export const KIND_EMOJI_SET = 30030;
export const BUZZ_EMOJI_SET_D = "buzz:custom-emoji";

/**
 * Content kinds the stream timeline renders as rows. Thread replies share these
 * kinds and are partitioned out by NIP-10 marked `e` tags. Forum kinds excluded.
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
 * Forum window kinds. Comments (45003) must be included or threads can't load;
 * the fold partitions them into per-root buckets.
 */
export const BUZZ_FORUM_CONTENT_KINDS = [KIND_FORUM_POST, KIND_FORUM_COMMENT] as const;

/**
 * Non-row kinds that overlay or hide a message: deletions and edits. Reactions
 * and forum votes are handled elsewhere.
 */
export const BUZZ_AUX_KINDS = [
  KIND_DELETE,
  KIND_BUZZ_DELETE_EVENT,
  KIND_STREAM_MESSAGE_EDIT,
] as const;

/** Standing live-subscription kinds per Buzz relay (with `#h` = every known channel). */
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
 * Unread-trigger kinds. System rows, job lifecycle and huddle overlays are
 * excluded: they'd create phantom unreads.
 */
export const BUZZ_UNREAD_KINDS = [
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
] as const;
