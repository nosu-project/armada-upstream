/**
 * Recording file names, Mumble-style: a template whose `%user`, `%date`,
 * `%time`, `%host` and `%channel` expand per file, and whose `/` separates
 * folders. Every expanded value is a sender- or user-chosen string, so each
 * one is made filename-safe before it can become a path segment.
 */

export interface TemplateVars {
  /** The recorded person's display name, or "Mixdown". */
  user: string;
  /** The community. */
  host: string;
  channel: string;
  /** When the recording started. */
  date: Date;
}

export const TEMPLATE_VARIABLES = ["%user", "%date", "%time", "%host", "%channel"] as const;

export const DEFAULT_TEMPLATE = "%host/%date %time/%user";

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD`, local time. */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `HH-MM-SS`, local time: colons are not allowed in Windows file names. */
export function formatTime(d: Date): string {
  return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** One path segment safe on Windows, macOS, Linux and Android's MediaStore. */
export function sanitizeSegment(value: string): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 120)
    .trim();
  return cleaned;
}

/**
 * Expand `template` into path segments, the last being the file's base name
 * (no extension). In multichannel mode a template without `%user` would name
 * every file alike, so the user is appended to the base name.
 */
export function expandTemplate(template: string, vars: TemplateVars, opts: { perUser: boolean }): string[] {
  let source = template.trim() || DEFAULT_TEMPLATE;
  if (opts.perUser && !source.includes("%user")) source = `${source} - %user`;
  const values: Record<string, string> = {
    "%user": sanitizeSegment(vars.user) || "user",
    "%date": formatDate(vars.date),
    "%time": formatTime(vars.date),
    "%host": sanitizeSegment(vars.host) || "Armada",
    "%channel": sanitizeSegment(vars.channel) || "call",
  };
  const segments = source
    .split(/[/\\]+/)
    .map((segment) =>
      sanitizeSegment(segment.replace(/%(user|date|time|host|channel)/g, (token) => values[token] ?? token)),
    )
    .filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.length > 0 ? segments : [values["%user"]];
}

/**
 * `name.ext`, or `name (2).ext`, `name (3).ext`… — the first not in `taken`
 * (compared case-insensitively, as macOS and Windows file systems do).
 */
export function uniqueName(base: string, ext: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  let candidate = `${base}.${ext}`;
  for (let n = 2; lower.has(candidate.toLowerCase()); n++) candidate = `${base} (${n}).${ext}`;
  return candidate;
}
