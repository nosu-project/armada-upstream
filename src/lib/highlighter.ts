/**
 * Syntax highlighting for fenced code blocks: highlight.js through lowlight,
 * which returns a hast tree rather than an HTML string, so the renderer builds
 * React elements from it and never touches `innerHTML`.
 *
 * This module carries the grammars. UI code reaches it only through
 * `codeHighlight.ts`, which imports it on demand so the grammars stay out of
 * the main bundle until the first code block that names a language.
 */
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import haskell from "highlight.js/lib/languages/haskell";
import julia from "highlight.js/lib/languages/julia";
import nix from "highlight.js/lib/languages/nix";
import ocaml from "highlight.js/lib/languages/ocaml";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import scala from "highlight.js/lib/languages/scala";
import { common, createLowlight } from "lowlight";

import type { Root } from "hast";

/** highlight.js's `common` set (JS/TS, JSON, Python, Rust, Go, shell, …) plus
 *  a few grammars chat tends to see that it leaves out. */
const lowlight = createLowlight(common);
lowlight.register({ dart, dockerfile, elixir, erlang, haskell, julia, nix, ocaml, powershell, protobuf, scala });

/**
 * Fence names people write that highlight.js has no alias for, mapped onto a
 * grammar it does have. Names it already aliases (`js`, `ts`, `py`, `sh`,
 * `yml`, `jsx`, `tsx`, `html`, `c++`, `golang`, …) resolve without help.
 */
const ALIASES: Readonly<Record<string, string>> = {
  cjs: "javascript",
  cts: "typescript",
  docker: "dockerfile",
  dotenv: "ini",
  env: "ini",
  erl: "erlang",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  htm: "xml",
  jl: "julia",
  json5: "json",
  mjs: "javascript",
  ml: "ocaml",
  mts: "typescript",
  node: "javascript",
  proto: "protobuf",
  pwsh: "powershell",
  svelte: "xml",
  svg: "xml",
  vue: "xml",
};

/** Resolve a fence's language name to a registered grammar, or null when unknown. */
export function resolveLanguage(lang: string | undefined): string | null {
  if (!lang) return null;
  const name = lang.trim().toLowerCase();
  if (name === "") return null;
  const mapped = ALIASES[name] ?? name;
  return lowlight.registered(mapped) ? mapped : null;
}

/** Largest block that gets highlighted. Highlighting is synchronous on the
 *  main thread, so a pasted log beyond this renders plain instead of stalling
 *  the message list. */
export const MAX_HIGHLIGHT_CHARS = 20_000;

/**
 * Highlight `code` as `lang`. Null when the language is unknown, the block is
 * over `MAX_HIGHLIGHT_CHARS`, or the grammar throws — callers then show the
 * code plain, which is what every block looked like before.
 */
export function highlightCode(lang: string | undefined, code: string): Root | null {
  const name = resolveLanguage(lang);
  if (!name || code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    return lowlight.highlight(name, code);
  } catch {
    return null;
  }
}
