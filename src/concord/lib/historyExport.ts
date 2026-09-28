/**
 * Concord history export: one self-contained HTML file (Chat / Text / JSON tabs)
 * with inline CSS/JS and `data:` URIs, so it opens offline and leaks nothing.
 * Pure and synchronous over an {@link ExportModel} built from the local rumor store.
 */

import { sanitizeUrl } from "@/lib/sanitizeUrl";

export interface ExportProfile {
  pubkey: string;
  /** Resolved display name; empty falls back to a short npub at render time. */
  name: string;
  /** Avatar src: a `data:` URI when embedded offline, an https URL, or undefined. */
  picture?: string;
}

export interface ExportAttachment {
  url: string;
  mime?: string;
  /** Inlined `data:` URI when embedded; absent = link-only (see {@link failed}). */
  dataUri?: string;
  /** An encrypted attachment whose bytes could not be fetched/decrypted for embedding. */
  failed?: boolean;
}

export interface ExportReaction {
  emoji: string;
  count: number;
}

export interface ExportMessage {
  rumorId: string;
  author: string;
  /** Send time (epoch ms): `created_at*1000 + ms`. */
  ms: number;
  kind: number;
  content: string;
  edited?: boolean;
  /** Thread-root rumor id for a reply, if any. */
  replyTo?: string;
  reactions: ExportReaction[];
  attachments: ExportAttachment[];
}

export interface ExportChannel {
  channelIdHex: string;
  name: string;
  isPrivate: boolean;
  messages: ExportMessage[];
}

export interface ExportModel {
  communityName: string;
  communityIdHex: string;
  /** When the export was produced (epoch ms). */
  generatedAtMs: number;
  /** Community icon, embedded as a `data:` URI when available. */
  icon?: string;
  profiles: Record<string, ExportProfile>;
  channels: ExportChannel[];
}

/** UTC ISO timestamp, locale-independent so an export is byte-reproducible. */
export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function nameOf(model: ExportModel, pubkey: string): string {
  const p = model.profiles[pubkey];
  if (p?.name) return p.name;
  return pubkey.length > 12 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}` : pubkey;
}

export function exportJson(model: ExportModel): string {
  return JSON.stringify(model, null, 2) + "\n";
}

export function buildTranscript(model: ExportModel): string {
  const out: string[] = [];
  out.push(model.communityName);
  out.push(`Community ${model.communityIdHex}`);
  out.push(`Exported ${isoTime(model.generatedAtMs)}`);
  out.push("");
  for (const ch of model.channels) {
    out.push("=".repeat(56));
    out.push(`#${ch.name}${ch.isPrivate ? " (private)" : ""}  ${ch.messages.length} message(s)`);
    out.push("=".repeat(56));
    for (const m of ch.messages) {
      const who = nameOf(model, m.author);
      const flags = [m.replyTo ? "reply" : "", m.edited ? "edited" : ""].filter(Boolean).join(", ");
      out.push(`[${isoTime(m.ms)}] ${who}${flags ? ` (${flags})` : ""}`);
      if (m.content) out.push(m.content.split("\n").map((l) => `    ${l}`).join("\n"));
      for (const a of m.attachments) {
        out.push(`    <attachment${a.failed ? " (undecryptable)" : ""}: ${a.url}>`);
      }
      if (m.reactions.length) out.push(`    ${m.reactions.map((r) => `${r.emoji} ${r.count}`).join("  ")}`);
    }
    out.push("");
  }
  return out.join("\n");
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape untrusted text for HTML text/attribute context. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * A media URL safe for `href`/`src`, or `undefined`. Only `data:` and http(s)
 * pass, so a `javascript:` URL can't ride in via `imeta`/kind-0.
 */
function safeMediaUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.startsWith("data:") ? raw : sanitizeUrl(raw);
}

/** Characters that may sit unescaped inside `url("…")` in a `<style>`. */
const CSS_URL_SAFE = /[^\w!#$&+,\-./:;=?@[\]~%]/g;

/**
 * The URL, safe inside `url("…")` in a `<style>`. `<style>` is RAWTEXT, so a
 * literal `</style>` would escape it — percent-encode, not just strip quotes.
 */
function cssUrl(raw: string | undefined): string | undefined {
  const safe = safeMediaUrl(raw);
  if (safe === undefined) return undefined;
  return safe.replace(CSS_URL_SAFE, (c) =>
    [...new TextEncoder().encode(c)]
      .map((b) => `%${b.toString(16).padStart(2, "0").toUpperCase()}`)
      .join(""),
  );
}

function renderContent(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" rel="noopener noreferrer" target="_blank">${url}</a>`);
  return linked.replace(/\n/g, "<br>");
}

/**
 * Avatar markup. The image is embedded once per author via {@link avatarStyleParts}
 * and referenced by class, so it isn't duplicated per message.
 */
function avatarHtml(model: ExportModel, pubkey: string): string {
  // Must agree with avatarStyleParts, or the class has no rule behind it.
  if (avatarCssUrl(model, pubkey) !== undefined) return `<span class="avatar av-${pubkey}"></span>`;
  const initial = escapeHtml(nameOf(model, pubkey).slice(0, 1).toUpperCase() || "?");
  return `<span class="avatar avatar-fallback">${initial}</span>`;
}

/** Guards class-selector interpolation so a non-hex key can't close the `<style>`. */
const CSS_CLASS_SAFE = /^[0-9A-Za-z_-]+$/;

/** The `url(…)` for an author's avatar, or `undefined` to render the monogram. */
function avatarCssUrl(model: ExportModel, pubkey: string): string | undefined {
  if (!CSS_CLASS_SAFE.test(pubkey)) return undefined;
  return cssUrl(model.profiles[pubkey]?.picture);
}

function avatarStyleParts(model: ExportModel): string[] {
  const parts: string[] = [];
  for (const pk of Object.keys(model.profiles)) {
    const url = avatarCssUrl(model, pk);
    if (url !== undefined) parts.push(`.av-${pk}{background-image:url("${url}")}`);
  }
  return parts;
}

function attachmentHtml(a: ExportAttachment): string {
  // The URL only reaches an href via safeMediaUrl; if rejected, render unlinked text.
  if (a.failed) {
    const source = safeMediaUrl(a.url);
    const link = source
      ? ` <a href="${escapeHtml(source)}" rel="noopener noreferrer" target="_blank">Source link</a>`
      : "";
    return `<div class="attachment failed">Attachment could not be decrypted for offline embedding.${link}</div>`;
  }
  const src = safeMediaUrl(a.dataUri ?? a.url);
  if (src === undefined) return `<div class="attachment file">${escapeHtml(a.url)}</div>`;
  if ((a.mime ?? "").startsWith("image/") || a.dataUri?.startsWith("data:image/")) {
    return `<img class="attachment" src="${escapeHtml(src)}" alt="" loading="lazy">`;
  }
  return `<div class="attachment file"><a href="${escapeHtml(src)}" rel="noopener noreferrer" target="_blank">${escapeHtml(a.url)}</a></div>`;
}

function messageHtml(model: ExportModel, m: ExportMessage): string {
  const head =
    `<div class="msg-head"><span class="author">${escapeHtml(nameOf(model, m.author))}</span>` +
    `<span class="time">${escapeHtml(isoTime(m.ms))}</span>` +
    (m.replyTo ? `<span class="tag">reply</span>` : "") +
    (m.edited ? `<span class="tag">edited</span>` : "") +
    `</div>`;
  const body = m.content ? `<div class="content">${renderContent(m.content)}</div>` : "";
  const atts = m.attachments.map(attachmentHtml).join("");
  const reactions = m.reactions.length
    ? `<div class="reactions">${m.reactions
        .map((r) => `<span class="reaction">${escapeHtml(r.emoji)} <b>${r.count}</b></span>`)
        .join("")}</div>`
    : "";
  return `<div class="msg">${avatarHtml(model, m.author)}<div class="msg-body">${head}${body}${atts}${reactions}</div></div>`;
}

const APP_STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: #17121d; color: #ece6f0; font: 15px/1.5 system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; }
a { color: #c9a9ff; }
.muted { color: #9a8fa6; }
.tabbar { display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-bottom: 1px solid #2c2435; background: #120e17; }
.tab { border: 0; background: transparent; color: #b9adc6; font: inherit; font-size: 14px; padding: 5px 12px; border-radius: 7px; cursor: pointer; }
.tab:hover { background: #221a2e; color: #ece6f0; }
.tab.active { background: #2c2138; color: #fff; }
.views { flex: 1; min-height: 0; position: relative; }
.view { display: none; height: 100%; }
.view.active { display: block; }
.view-text.active, .view-json.active { overflow: auto; padding: 16px 20px; }
.view-text pre, .view-json pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #d8ccdf; }
.view-chat.active { overflow: hidden; }
.app { display: flex; height: 100%; }
.sidebar { width: 260px; flex: 0 0 260px; background: #120e17; border-right: 1px solid #2c2435; display: flex; flex-direction: column; }
.community { display: flex; align-items: center; gap: 10px; padding: 16px; border-bottom: 1px solid #2c2435; font-weight: 700; }
.community img { width: 32px; height: 32px; border-radius: 9px; object-fit: cover; }
.community .fallback { width: 32px; height: 32px; border-radius: 9px; background: #34294a; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
.channels { flex: 1; overflow-y: auto; padding: 8px; }
.ch { display: flex; width: 100%; align-items: center; gap: 6px; padding: 7px 10px; border: 0; border-radius: 7px; background: transparent; color: #b9adc6; font: inherit; text-align: left; cursor: pointer; }
.ch:hover { background: #221a2e; color: #ece6f0; }
.ch.active { background: #2c2138; color: #fff; }
.ch .hash { color: #6f6480; font-weight: 700; }
.ch .count { margin-left: auto; font-size: 12px; color: #7d7189; }
.exported { padding: 10px 16px; border-top: 1px solid #2c2435; font-size: 11px; color: #7d7189; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-bottom: 1px solid #2c2435; }
.topbar .title { font-weight: 700; }
.panes { flex: 1; overflow-y: auto; }
.pane { display: none; padding: 12px 20px 40px; }
.pane.active { display: block; }
.empty { color: #7d7189; padding: 24px 0; text-align: center; }
.msg { display: flex; gap: 12px; padding: 7px 0; }
.avatar { width: 40px; height: 40px; border-radius: 50%; flex: 0 0 40px; background: #34294a center/cover no-repeat; }
.avatar-fallback { display: inline-flex; align-items: center; justify-content: center; font-weight: 600; color: #d8ccdf; }
.msg-body { min-width: 0; flex: 1; }
.msg-head { display: flex; align-items: baseline; gap: 8px; }
.author { font-weight: 600; }
.time { color: #8f8398; font-size: 12px; }
.tag { color: #8f8398; font-size: 11px; background: #241c30; border-radius: 6px; padding: 0 6px; }
.content { overflow-wrap: anywhere; }
.attachment { max-width: min(400px, 100%); border-radius: 8px; margin-top: 6px; display: block; }
.attachment.file { font-size: 13px; }
.attachment.failed { color: #ffb0b0; font-size: 13px; }
.reactions { margin-top: 5px; }
.reaction { display: inline-block; background: #241c30; border: 1px solid #372b47; border-radius: 12px; padding: 1px 9px; margin-right: 5px; font-size: 13px; }
`;

const SWITCH_SCRIPT = `
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var views = Array.prototype.slice.call(document.querySelectorAll('.view'));
  function showView(v) {
    views.forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-view') === v); });
    tabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-view') === v); });
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { showView(t.getAttribute('data-view')); }); });

  var buttons = Array.prototype.slice.call(document.querySelectorAll('.ch'));
  var panes = Array.prototype.slice.call(document.querySelectorAll('.pane'));
  var title = document.getElementById('pane-title');
  function select(id, name) {
    panes.forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-pane') === id); });
    buttons.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-ch') === id); });
    if (title && name != null) title.textContent = name;
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () { select(b.getAttribute('data-ch'), b.getAttribute('data-name')); });
  });
  if (buttons.length) select(buttons[0].getAttribute('data-ch'), buttons[0].getAttribute('data-name'));
})();
`;

function communityGlyph(model: ExportModel): string {
  const icon = safeMediaUrl(model.icon);
  if (icon) return `<img src="${escapeHtml(icon)}" alt="">`;
  const initial = escapeHtml((model.communityName.slice(0, 1) || "#").toUpperCase());
  return `<span class="fallback">${initial}</span>`;
}

function channelButton(ch: ExportChannel): string {
  return (
    `<button class="ch" data-ch="${escapeHtml(ch.channelIdHex)}" data-name="${escapeHtml(ch.name)}">` +
    `<span class="hash">${ch.isPrivate ? "🔒" : "#"}</span>` +
    `<span class="name">${escapeHtml(ch.name)}</span>` +
    `<span class="count">${ch.messages.length}</span>` +
    `</button>`
  );
}

/**
 * The model without inlined `data:` bytes, for the JSON view — serializing them
 * twice pushed large exports past the browser's max string size.
 */
function lightenForJson(model: ExportModel): ExportModel {
  const strip = (u: string | undefined) => (u && u.startsWith("data:") ? undefined : u);
  return {
    ...model,
    icon: strip(model.icon),
    profiles: Object.fromEntries(
      Object.entries(model.profiles).map(([k, p]) => [k, { ...p, picture: strip(p.picture) }]),
    ),
    channels: model.channels.map((ch) => ({
      ...ch,
      messages: ch.messages.map((m) => ({
        ...m,
        attachments: m.attachments.map(({ dataUri: _dataUri, ...a }) => a),
      })),
    })),
  };
}

/**
 * The export as HTML fragments for `new Blob(parts, …)`, never one giant string
 * (large media throws "allocation size overflow" when concatenated).
 */
export function exportHtmlParts(model: ExportModel): string[] {
  const channels = model.channels;
  const firstName = channels[0]?.name ?? "";
  const rail = channels.map(channelButton).join("") || '<div class="empty">No channels</div>';

  const parts: string[] = [];
  parts.push(
    `<!doctype html>\n<html lang="en">\n<head>\n` +
      `<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
      `<title>${escapeHtml(model.communityName)} Concord export</title>\n<style>${APP_STYLE}</style>\n<style>`,
  );
  parts.push(...avatarStyleParts(model));
  parts.push(
    `</style>\n</head>\n<body>\n` +
      `<div class="tabbar"><button class="tab active" data-view="chat">Chat</button>` +
      `<button class="tab" data-view="text">Text</button><button class="tab" data-view="json">JSON</button></div>\n` +
      `<div class="views"><section class="view view-chat active" data-view="chat"><div class="app">` +
      `<aside class="sidebar"><div class="community">${communityGlyph(model)}<span>${escapeHtml(model.communityName)}</span></div>` +
      `<nav class="channels">${rail}</nav>` +
      `<div class="exported">Exported ${escapeHtml(isoTime(model.generatedAtMs))}<br>${escapeHtml(model.communityIdHex.slice(0, 16))}…</div></aside>` +
      `<main class="main"><div class="topbar"><span class="title"><span class="hash muted">#</span> ` +
      `<span id="pane-title">${escapeHtml(firstName)}</span></span></div><div class="panes">`,
  );

  if (channels.length === 0) {
    parts.push('<div class="empty">Nothing to show.</div>');
  } else {
    for (const ch of channels) {
      parts.push(`<section class="pane" data-pane="${escapeHtml(ch.channelIdHex)}">`);
      if (ch.messages.length === 0) {
        parts.push('<div class="empty">No messages in this channel.</div>');
      } else {
        for (const m of ch.messages) parts.push(messageHtml(model, m));
      }
      parts.push(`</section>`);
    }
  }

  parts.push(`</div></main></div></section>`);
  parts.push(`<section class="view view-text" data-view="text"><pre>${escapeHtml(buildTranscript(model))}</pre></section>`);
  parts.push(`<section class="view view-json" data-view="json"><pre>${escapeHtml(exportJson(lightenForJson(model)))}</pre></section>`);
  parts.push(`</div>\n<script>${SWITCH_SCRIPT}</script>\n</body>\n</html>\n`);
  return parts;
}

/** {@link exportHtmlParts} joined into one string; fine for tests, unsafe for huge exports. */
export function exportHtml(model: ExportModel): string {
  return exportHtmlParts(model).join("");
}

export type ExportFormat = "html";

export const EXPORT_FORMATS: Record<ExportFormat, { extension: string; mime: string; write: (m: ExportModel) => string }> = {
  html: { extension: "html", mime: "text/html", write: exportHtml },
};

/** A filesystem-safe base name for the export (community-id-date shape). */
export function exportFileName(model: ExportModel, format: ExportFormat): string {
  const safe = model.communityName.replace(/[^\p{L}\p{N}\-_. ]/gu, "_").trim() || "community";
  const date = isoTime(model.generatedAtMs).slice(0, 10);
  return `${safe} [${model.communityIdHex.slice(0, 8)}] ${date}.${EXPORT_FORMATS[format].extension}`;
}
