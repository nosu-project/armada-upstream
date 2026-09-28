/**
 * Code highlighting via lowlight (hast, never `innerHTML`). Load only through
 * `codeHighlight.ts`, which imports this on demand to keep grammars out of the main bundle.
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

/** highlight.js `common` plus a few extra grammars. */
const lowlight = createLowlight(common);
lowlight.register({ dart, dockerfile, elixir, erlang, haskell, julia, nix, ocaml, powershell, protobuf, scala });

/** Fence names highlight.js has no alias for, mapped to a grammar it has. */
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

/** Highlighting is synchronous on the main thread; larger blocks render plain. */
export const MAX_HIGHLIGHT_CHARS = 20_000;

/** Highlight `code` as `lang`; null (render plain) when unknown, too large, or the grammar throws. */
export function highlightCode(lang: string | undefined, code: string): Root | null {
  const name = resolveLanguage(lang);
  if (!name || code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    return lowlight.highlight(name, code);
  } catch {
    return null;
  }
}
