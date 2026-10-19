#!/usr/bin/env node
/*
 * Translation catalogs.
 *
 *   node scripts/i18n.mjs extract   write src/i18n/locales/en.json from the source
 *   node scripts/i18n.mjs check     fail unless en.json matches the source and every
 *                                   catalog has exactly its ids, with the same
 *                                   placeholders and tags in each message
 *   node scripts/i18n.mjs missing [locale]
 *                                   print the English of every id a catalog lacks
 *                                   (or whose English changed is up to the editor)
 *
 * English is never loaded at runtime — it is each call site's defaultMessage —
 * so en.json exists for this check and for translators.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, TYPE } from "@formatjs/icu-messageformat-parser";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = join(root, "src/i18n/locales");
const TRANSLATED = ["de", "es", "fr", "it", "nl", "ja"];

function extract() {
  const dir = mkdtempSync(join(tmpdir(), "armada-i18n-"));
  const out = join(dir, "en.json");
  try {
    execFileSync(
      join(root, "node_modules/.bin/formatjs"),
      [
        "extract",
        "src/**/*.{ts,tsx}",
        "--ignore", "src/**/*.test.{ts,tsx}",
        "--ignore", "src/**/*.d.ts",
        "--additional-function-names", "t",
        "--format", "simple",
        "--throws",
        "--out-file", out,
      ],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
    );
    return sortKeys(JSON.parse(readFileSync(out, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

function serialize(obj) {
  return JSON.stringify(sortKeys(obj), null, 2) + "\n";
}

function readCatalog(locale) {
  return JSON.parse(readFileSync(join(localesDir, `${locale}.json`), "utf8"));
}

/** Argument names (with their kind) and tag names a message uses, as a comparable signature. */
function signature(message) {
  const found = new Set();
  const walk = (nodes) => {
    for (const node of nodes) {
      switch (node.type) {
        case TYPE.argument: found.add(`{${node.value}}`); break;
        case TYPE.number: found.add(`{${node.value}, number}`); break;
        case TYPE.date: found.add(`{${node.value}, date}`); break;
        case TYPE.time: found.add(`{${node.value}, time}`); break;
        case TYPE.select:
          found.add(`{${node.value}, select}`);
          for (const option of Object.values(node.options)) walk(option.value);
          break;
        case TYPE.plural:
          found.add(`{${node.value}, plural}`);
          for (const option of Object.values(node.options)) walk(option.value);
          break;
        case TYPE.tag:
          found.add(`<${node.value}>`);
          walk(node.children);
          break;
      }
    }
  };
  walk(parse(message));
  return [...found].sort().join(" ");
}

/**
 * Descriptors written in the source that the extractor did not see: one called
 * through an alias (`const m = intl.formatMessage`) or a bare object outside
 * `defineMessage`. They type-check and render, but only ever in English.
 */
function unextracted(source) {
  const found = [];
  const descriptor = /\bid\s*:\s*["']([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)["']\s*,\s*defaultMessage\s*:/g;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name)) {
        for (const [, id] of readFileSync(path, "utf8").matchAll(descriptor)) {
          if (!(id in source)) found.push(`${path.slice(root.length + 1)}: ${id}`);
        }
      }
    }
  };
  walk(join(root, "src"));
  return found;
}

function check() {
  const problems = [];
  const source = extract();
  const hidden = unextracted(source);
  if (hidden.length) {
    problems.push(
      `${hidden.length} message(s) the extractor cannot see — call intl.formatMessage/t() directly or wrap in defineMessage:\n  ${hidden.slice(0, 20).join("\n  ")}`,
    );
  }
  let committed = {};
  try {
    committed = readCatalog("en");
  } catch { /* reported below */ }
  if (serialize(source) !== serialize(committed)) {
    problems.push("src/i18n/locales/en.json is out of date with the source: run `npm run i18n:extract`.");
  }
  const english = Object.fromEntries(Object.entries(source).map(([id, msg]) => {
    try {
      return [id, signature(msg)];
    } catch (err) {
      problems.push(`en: ${id}: ${err.message}`);
      return [id, null];
    }
  }));
  for (const locale of TRANSLATED) {
    const catalog = readCatalog(locale);
    const missing = Object.keys(source).filter((id) => !(id in catalog));
    const extra = Object.keys(catalog).filter((id) => !(id in source));
    if (missing.length) problems.push(`${locale}: ${missing.length} missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`);
    if (extra.length) problems.push(`${locale}: ${extra.length} not in the source: ${extra.slice(0, 10).join(", ")}${extra.length > 10 ? ", …" : ""}`);
    for (const [id, msg] of Object.entries(catalog)) {
      if (!(id in source) || english[id] === null) continue;
      let sig;
      try {
        sig = signature(msg);
      } catch (err) {
        problems.push(`${locale}: ${id}: ${err.message}`);
        continue;
      }
      if (sig !== english[id]) problems.push(`${locale}: ${id}: uses ${sig || "nothing"}, English uses ${english[id] || "nothing"}`);
    }
    if (serialize(catalog) !== readFileSync(join(localesDir, `${locale}.json`), "utf8")) {
      problems.push(`${locale}.json is not sorted/formatted: run \`node scripts/i18n.mjs format\`.`);
    }
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`i18n: ${Object.keys(source).length} messages, ${TRANSLATED.length} catalogs complete.`);
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case "extract":
    writeFileSync(join(localesDir, "en.json"), serialize(extract()));
    break;
  case "format":
    for (const locale of ["en", ...TRANSLATED]) {
      writeFileSync(join(localesDir, `${locale}.json`), serialize(readCatalog(locale)));
    }
    break;
  case "check":
    check();
    break;
  case "missing": {
    const source = extract();
    const out = {};
    for (const locale of arg ? [arg] : TRANSLATED) {
      const catalog = readCatalog(locale);
      for (const [id, msg] of Object.entries(source)) if (!(id in catalog)) out[id] = msg;
    }
    process.stdout.write(serialize(out));
    break;
  }
  default:
    console.error("usage: node scripts/i18n.mjs extract|check|format|missing [locale]");
    process.exit(2);
}
