import { nip19 } from "nostr-tools";
import { z } from "zod";

/**
 * Bot commands and manifests.
 *
 * A bot publishes a replaceable **manifest** (`kind:10304`) declaring the
 * slash-commands it answers, each with a typed, positional argument list. An
 * **invocation** is an ordinary chat message whose content is the command text
 * (`/price btc`), optionally carrying a `["bot", <pubkey-hex>]` tag naming which
 * bot should act. There is no invocation event kind: any client that can send a
 * message can send a command, and a rich client layers discovery and validation
 * on top.
 *
 * This module is the wire layer — validate a manifest, parse and type-check an
 * invocation, render one back out canonically. Pure: no React, no network.
 *
 * The routing tag carries the bot's **hex** pubkey and MUST ride inside whatever
 * encryption envelope the transport uses (for Concord, on the inner rumor), never
 * on an outer wrap: hoisting it out would publish "this pubkey is commanding that
 * bot" to every relay storing the wrap.
 */

/** Replaceable manifest: one authoritative command catalog per bot pubkey. */
export const BOT_MANIFEST_KIND = 10304;

/** Routing tag naming the bot that should act. Routing, NOT authorization. */
export const BOT_TAG = "bot";

// Manifest limits. A manifest is untrusted input; these bound what a hostile one
// can cost us to store and render.
const MAX_COMMANDS = 64;
const MAX_ARGS = 8;
const MAX_CHOICES = 32;
const MAX_CHOICE_BYTES = 32;
const MAX_DESCRIPTION_BYTES = 200;
const MAX_MANIFEST_BYTES = 32768;
/** Per-argument value cap on the wire. Longer ⇒ the text is not an invocation. */
export const MAX_ARG_VALUE_BYTES = 1024;
/** At most this many bots may be addressed by one message. */
export const MAX_BOT_TAGS = 8;

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * Length in BYTES. Every limit here is a byte limit, never a character one — a
 * field's `maxLength` counts UTF-16 units, which emoji clear long before the
 * wire cap does.
 */
export const byteLength = (s: string): number => new TextEncoder().encode(s).length;

// ── Manifest ─────────────────────────────────────────────────────────────────

export type BotArgType = "string" | "int" | "number" | "bool" | "user" | "choice";

/**
 * Unknown object fields are stripped rather than rejected (zod objects strip by
 * default), so a manifest from a newer producer stays usable here.
 */
const BotArgSchema = z
  .object({
    name: z.string().regex(NAME_RE),
    type: z.enum(["string", "int", "number", "bool", "user", "choice"]),
    description: z.string().optional(),
    required: z.boolean().optional(),
    choices: z.array(z.string()).optional(),
  })
  .superRefine((a, ctx) => {
    if (byteLength(a.description ?? "") > MAX_DESCRIPTION_BYTES) {
      ctx.addIssue({ code: "custom", message: "argument description too long" });
    }
    const choices = a.choices ?? [];
    if (a.type === "choice") {
      if (choices.length < 1 || choices.length > MAX_CHOICES) {
        ctx.addIssue({ code: "custom", message: "a choice argument needs 1-32 choices" });
      }
      if (choices.some((c) => byteLength(c) < 1 || byteLength(c) > MAX_CHOICE_BYTES)) {
        ctx.addIssue({ code: "custom", message: "choice value out of bounds" });
      }
    } else if (choices.length > 0) {
      ctx.addIssue({ code: "custom", message: "choices on a non-choice argument" });
    }
  })
  .transform((a) => ({
    name: a.name,
    type: a.type,
    description: a.description ?? "",
    required: a.required ?? false,
    choices: a.choices ?? [],
  }));

const BotCommandSchema = z
  .object({
    name: z.string().regex(NAME_RE),
    description: z.string().optional(),
    args: z.array(BotArgSchema).max(MAX_ARGS).optional(),
  })
  .superRefine((c, ctx) => {
    if (byteLength(c.description ?? "") > MAX_DESCRIPTION_BYTES) {
      ctx.addIssue({ code: "custom", message: "command description too long" });
    }
    const args = c.args ?? [];
    const names = new Set(args.map((a) => a.name));
    if (names.size !== args.length) {
      ctx.addIssue({ code: "custom", message: "duplicate argument name" });
    }
    // Required-before-optional. A positional invocation cannot express a hole,
    // so an optional argument ahead of a required one would be unparseable.
    const firstOptional = args.findIndex((a) => !a.required);
    if (firstOptional !== -1 && args.slice(firstOptional).some((a) => a.required)) {
      ctx.addIssue({ code: "custom", message: "a required argument follows an optional one" });
    }
  })
  .transform((c) => ({
    name: c.name,
    description: c.description ?? "",
    args: c.args ?? [],
  }));

const BotManifestSchema = z
  .object({
    v: z.literal(1),
    commands: z.array(BotCommandSchema).max(MAX_COMMANDS).optional(),
  })
  .superRefine((m, ctx) => {
    const commands = m.commands ?? [];
    const names = new Set(commands.map((c) => c.name));
    if (names.size !== commands.length) {
      ctx.addIssue({ code: "custom", message: "duplicate command name" });
    }
  })
  .transform((m) => ({ v: m.v, commands: m.commands ?? [] }));

export type BotArg = z.infer<typeof BotArgSchema>;
export type BotCommand = z.infer<typeof BotCommandSchema>;
export type BotManifest = z.infer<typeof BotManifestSchema>;

/**
 * Parse a manifest event's `content`. Fail-closed: a manifest that breaks any
 * rule has no usable interface and is ignored entirely rather than partially
 * rendered.
 */
export function parseBotManifest(content: string): BotManifest | undefined {
  if (byteLength(content) > MAX_MANIFEST_BYTES) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return undefined;
  }
  const parsed = BotManifestSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

// ── The routing tag ──────────────────────────────────────────────────────────

/** The routing tag for a bot, by hex pubkey. */
export function botTag(pubkeyHex: string): string[] {
  return [BOT_TAG, pubkeyHex];
}

/** Hex pubkeys a message addresses. Empty ⇒ broadcast: any matching bot may answer. */
export function addressedBots(tags: string[][]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (t[0] !== BOT_TAG || !t[1]) continue;
    if (!out.includes(t[1])) out.push(t[1]);
    if (out.length === MAX_BOT_TAGS) break;
  }
  return out;
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

type Token =
  | { kind: "token"; value: string; next: number }
  /** No token remains (only trailing whitespace). */
  | { kind: "end" }
  /** An unterminated quote: the text is malformed and is NOT an invocation. */
  | { kind: "malformed" };

/**
 * ASCII whitespace only, matching the reference parser. JavaScript's `\s` also
 * matches Unicode spaces (a non-breaking space, say, which mobile keyboards and
 * pasted text produce freely). Splitting on those would let this client read
 * `/calc 1<NBSP>add 2` as three tokens while a bot reads it as one — the client
 * would call it valid and the bot would reject it.
 */
const isSpace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * One shell-style token from `s` at `start`: a bare word, or a `"quoted span"`
 * in which `\"` is a literal quote and `\\` a literal backslash.
 */
function nextToken(s: string, start: number): Token {
  let i = start;
  while (i < s.length && isSpace(s[i])) i++;
  if (i >= s.length) return { kind: "end" };

  if (s[i] === '"') {
    i++;
    let value = "";
    while (i < s.length) {
      if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) {
        value += s[i + 1];
        i += 2;
      } else if (s[i] === '"') {
        return { kind: "token", value, next: i + 1 };
      } else {
        value += s[i];
        i++;
      }
    }
    return { kind: "malformed" };
  }

  const from = i;
  while (i < s.length && !isSpace(s[i])) i++;
  return { kind: "token", value: s.slice(from, i), next: i };
}

/** Strip leading / trailing ASCII whitespace, on the same class as the tokenizer. */
const trimAsciiStart = (s: string): string => {
  let i = 0;
  while (i < s.length && isSpace(s[i])) i++;
  return s.slice(i);
};
const trimAsciiEnd = (s: string): string => {
  let i = s.length;
  while (i > 0 && isSpace(s[i - 1])) i--;
  return s.slice(0, i);
};

// ── Invocation ───────────────────────────────────────────────────────────────

export interface ParsedInvocation {
  command: BotCommand;
  /** The bot that declared it, hex. Meaningless when `ambiguous`. */
  bot: string;
  /** Values in declared order. Shorter than `command.args` when optionals were omitted. */
  args: string[];
  /**
   * More than one bot declares this name and the user picked none of them. An
   * untagged invocation is a broadcast that any matching bot may answer, so a
   * caller MUST NOT invent a routing tag here: naming one bot tells the other to
   * stay silent, and it may be the one the user meant.
   */
  ambiguous: boolean;
}

/** A command paired with the bot that declared it. */
export interface BotCommandEntry {
  /** Hex pubkey. */
  bot: string;
  command: BotCommand;
}

/**
 * Match `content` against the commands available in this conversation.
 *
 * Returns undefined when the text is not an invocation at all — an unknown
 * `/word` is ordinary chat and MUST still send. `preferBot` disambiguates when
 * two bots declare the same command name (the picker passes the one the user
 * actually chose).
 *
 * The command word is matched case-insensitively (manifest names are lowercase
 * slugs, so `/Help` resolves to `help`); argument VALUES keep their case, and a
 * `choice` is matched exactly.
 */
export function parseInvocation(
  content: string,
  entries: BotCommandEntry[],
  preferBot?: string,
): ParsedInvocation | undefined {
  const text = content.trim();
  if (!text.startsWith("/")) return undefined;
  const rest = text.slice(1);

  const head = nextToken(rest, 0);
  // A quoted first token is not a command word.
  if (head.kind !== "token" || !head.value || rest.startsWith('"')) return undefined;

  const name = head.value.toLowerCase();
  const matches = entries.filter((e) => e.command.name === name);
  if (matches.length === 0) return undefined;
  const picked = preferBot ? matches.find((e) => e.bot === preferBot) : undefined;
  const entry = picked ?? matches[0];
  const ambiguous = !picked && matches.length > 1;
  const spec = entry.command;

  const args: string[] = [];
  let cursor = head.next;
  for (let i = 0; i < spec.args.length; i++) {
    const remainder = trimAsciiStart(rest.slice(cursor));
    if (!remainder) break;

    const isLast = i === spec.args.length - 1;
    let value: string;
    if (isLast && spec.args[i].type === "string" && !remainder.startsWith('"')) {
      // Greedy tail: the final free-text argument takes the raw remainder, so
      // `/say hello there` needs no quoting. Two multi-word values are still
      // expressible by quoting both.
      value = trimAsciiEnd(remainder);
      cursor = rest.length;
    } else {
      const tok = nextToken(rest, cursor);
      if (tok.kind === "malformed") return undefined;
      if (tok.kind === "end") break;
      value = tok.value;
      cursor = tok.next;
    }
    if (byteLength(value) > MAX_ARG_VALUE_BYTES) return undefined;
    args.push(value);
  }

  return { command: spec, bot: entry.bot, args, ambiguous };
}

/**
 * Canonical invocation text: values containing whitespace or a quote are wrapped
 * in `"…"` with `\"`/`\\` escapes, so the text re-parses to exactly these
 * arguments on the bot's side.
 */
export function buildInvocationText(name: string, values: string[]): string {
  let out = `/${name}`;
  for (const v of values) {
    out += " ";
    if (v === "" || /[\s"]/.test(v)) {
      out += `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    } else {
      out += v;
    }
  }
  return out;
}

// ── Typing ───────────────────────────────────────────────────────────────────

/**
 * Check one value against one argument spec. Returns the canonical failure
 * reason, or undefined when the value is good.
 *
 * The reasons are fixed by the spec so that errors are byte-identical across
 * implementations and a client can parse them rather than merely display them.
 */
export function argReason(spec: BotArg, value: string): string | undefined {
  switch (spec.type) {
    case "int": {
      // Signed 64-bit, so the range matters: a bot parsing into an i64 rejects
      // what a bare digit test would wave through.
      if (!/^[+-]?\d+$/.test(value)) return "not an integer";
      const n = BigInt(value);
      return n >= -(2n ** 63n) && n <= 2n ** 63n - 1n ? undefined : "not an integer";
    }
    case "number":
      // Decimal only. `Number()` alone would also accept JavaScript's own
      // literal forms (`0x1f`, `0b101`, whitespace-padded), none of which a bot
      // parsing a float will take — so we would call them valid and it would not.
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))
        ? undefined
        : "not a number";
    case "bool":
      return ["true", "false", "yes", "no", "1", "0"].includes(value.toLowerCase())
        ? undefined
        : "not a boolean";
    case "user":
      return normalizeUser(value) ? undefined : "not an npub";
    case "choice":
      return spec.choices.includes(value)
        ? undefined
        : `not one of ${spec.choices.join(", ")}`;
    case "string":
      return undefined;
  }
}

/**
 * A `user` value as a bare npub, or undefined when it isn't one. Accepts the
 * NIP-21 `nostr:npub1…` URI as well as the bare form (clients insert mentions as
 * URIs), and verifies the bech32 checksum rather than just the prefix.
 */
export function normalizeUser(value: string): string | undefined {
  const raw = value.startsWith("nostr:") ? value.slice(6) : value;
  if (!raw.startsWith("npub1")) return undefined;
  try {
    return nip19.decode(raw).type === "npub" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate a parsed invocation's arguments. Returns the canonical first line of
 * an error (`{argument}: {reason}`), or undefined when every argument is good.
 */
export function validateInvocation(command: BotCommand, args: string[]): string | undefined {
  for (let i = 0; i < command.args.length; i++) {
    const spec = command.args[i];
    const value = args[i];
    // Absent is not the same as empty. `/announce "" body` supplies a title —
    // an empty one — and a bot accepts it, so refusing it here would have this
    // client reject an invocation the spec calls legal. An empty value that its
    // type cannot accept still fails below, on its own reason.
    if (value === undefined) {
      if (spec.required) return `${spec.name}: required`;
      continue;
    }
    const reason = argReason(spec, value);
    if (reason) return `${spec.name}: ${reason}`;
  }
  return undefined;
}

/** How an argument's type renders in a usage line. */
function typeLabel(type: BotArgType): string {
  switch (type) {
    case "string":
      return "text";
    case "bool":
      return "true|false";
    case "user":
      return "npub";
    default:
      return type;
  }
}

/**
 * The command's usage line: `/name <required:type> [optional:type]`. Bots put
 * this on the second line of an error reply, so a client renders (and parses)
 * the same shape it would have produced itself.
 */
export function usageLine(command: BotCommand): string {
  const parts = command.args.map((a) =>
    a.required ? `<${a.name}:${typeLabel(a.type)}>` : `[${a.name}:${typeLabel(a.type)}]`,
  );
  return [`/${command.name}`, ...parts].join(" ");
}
