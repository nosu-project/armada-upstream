#!/usr/bin/env node
/**
 * What grew between two heap snapshots of the SAME page session (heap object
 * ids are stable within one), for leak hunting:
 *
 *   node --max-old-space-size=8192 scripts/heap-diff.mjs early.heapsnapshot late.heapsnapshot [--json out.json]
 *
 * - growers: objects alive in both whose backing store grew (a Map/Set/array
 *   or object gaining entries), each with the path that keeps it alive. A
 *   module cache with no eviction or a listener set nobody unsubscribes from
 *   tops this list.
 * - new by class: objects only the later snapshot has, by constructor.
 * - detached DOM: elements out of the document but still referenced.
 *
 * Closures on a path are resolved to source through the profile build's
 * sourcemaps (`dist-perf/assets/*.map`), so minified module scopes still read
 * as file:line. A path through "DevTools console" is the harness's own
 * retention (the performance-entry buffer), not the app's, and is marked.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = resolve(root, "dist-perf/assets");

function load(path) {
  const snap = JSON.parse(readFileSync(path, "utf8"));
  const meta = snap.snapshot.meta;
  const nf = meta.node_fields.length;
  const ef = meta.edge_fields.length;
  const f = (name) => meta.node_fields.indexOf(name);
  const fields = { type: f("type"), name: f("name"), id: f("id"), size: f("self_size"), edges: f("edge_count"), detached: f("detachedness") };
  const n = snap.nodes.length / nf;
  const firstEdge = new Uint32Array(n + 1);
  for (let i = 0, e = 0; i < n; i++) {
    firstEdge[i] = e;
    e += snap.nodes[i * nf + fields.edges] * ef;
    firstEdge[i + 1] = e;
  }
  const byId = new Map();
  for (let i = 0; i < n; i++) byId.set(snap.nodes[i * nf + fields.id], i);
  const lf = meta.location_fields ?? [];
  const loc = new Map();
  const li = { obj: lf.indexOf("object_index"), script: lf.indexOf("script_object_index"), line: lf.indexOf("line"), col: lf.indexOf("column") };
  for (let i = 0; i < (snap.locations ?? []).length; i += lf.length) {
    const L = snap.locations;
    loc.set(L[i + li.obj] / nf, { script: li.script >= 0 ? L[i + li.script] / nf : -1, line: L[i + li.line], col: L[i + li.col] });
  }
  const g = {
    snap, meta, nf, ef, fields, n, firstEdge, byId, loc,
    type: (i) => meta.node_types[0][snap.nodes[i * nf + fields.type]],
    name: (i) => String(snap.strings[snap.nodes[i * nf + fields.name]]),
    id: (i) => snap.nodes[i * nf + fields.id],
    size: (i) => snap.nodes[i * nf + fields.size],
    detached: (i) => (fields.detached >= 0 ? snap.nodes[i * nf + fields.detached] : 0),
    *edges(i) {
      for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += ef) {
        const type = meta.edge_types[0][snap.edges[e]];
        const raw = snap.edges[e + 1];
        const name = type === "element" || type === "hidden" ? raw : String(snap.strings[raw]);
        yield { type, name, to: snap.edges[e + 2] / nf };
      }
    },
  };
  return g;
}

/** A container's own bytes plus its backing stores, and how many entries those hold. */
function measure(g, i) {
  let bytes = g.size(i);
  let entries = 0;
  for (const e of g.edges(i)) {
    if (e.type === "property" && g.type(i) === "object") entries++;
    if (!(e.name === "table" || e.name === "elements" || e.name === "properties")) continue;
    const t = g.type(e.to);
    if (t !== "array" && t !== "hidden" && t !== "object") continue;
    bytes += g.size(e.to);
    for (const inner of g.edges(e.to)) if (inner.type === "element" || inner.type === "internal") entries++;
  }
  return { bytes, entries };
}

const CONTAINERS = new Set(["object", "array", "closure"]);

/**
 * Module variables of the profiler itself (`src/lib/perf.ts`, `perfRuntime.ts`,
 * `memoryProbes.ts`): what they gain is the measurement, not the app.
 */
const PROFILER_OWNERS = new Set([
  "marks", "buckets", "probes", "state", "relays", "socketSubs", "socketKeys",
  "liveIntervals", "instrumentedCache", "samples",
]);

// ─── Sourcemaps ────────────────────────────────────────────────────────────

const B64 = Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));
const maps = new Map();
function sourceMap(url) {
  const file = basename(url.split("?")[0]);
  if (maps.has(file)) return maps.get(file);
  const path = resolve(ASSETS, `${file}.map`);
  let parsed = null;
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    // Per generated line: [genCol, srcIdx, srcLine][] (names unused).
    const lines = [];
    let src = 0, sLine = 0, sCol = 0;
    for (const line of raw.mappings.split(";")) {
      const segs = [];
      let gCol = 0;
      for (const seg of line.split(",")) {
        if (!seg) continue;
        const v = [];
        let shift = 0, value = 0;
        for (const ch of seg) {
          const d = B64[ch];
          value += (d & 31) << shift;
          if (d & 32) shift += 5;
          else {
            v.push(value & 1 ? -(value >>> 1) : value >>> 1);
            shift = value = 0;
          }
        }
        gCol += v[0];
        if (v.length >= 4) {
          src += v[1]; sLine += v[2]; sCol += v[3];
          segs.push([gCol, src, sLine]);
        }
      }
      lines.push(segs);
    }
    parsed = { lines, sources: raw.sources };
  }
  maps.set(file, parsed);
  return parsed;
}

function original(url, line, col) {
  const m = sourceMap(url);
  const segs = m?.lines[line];
  if (!segs?.length) return `${basename(url)}:${line + 1}:${col + 1}`;
  let best = segs[0];
  for (const s of segs) if (s[0] <= col) best = s;
  const src = m.sources[best[1]].replace(/^(\.\.\/)+/, "").replace(/^node_modules\//, "~");
  return `${src}:${best[2] + 1}`;
}

/** file:line of a closure, through its script and the build's sourcemap. */
function closureSite(g, i) {
  const l = g.loc.get(i);
  if (!l || l.script < 0) return "";
  const url = g.name(l.script).replace(/^system \/ Script \/ /, "");
  if (!/\/assets\//.test(url)) return "";
  return original(url, l.line, l.col);
}

// ─── Retainers ─────────────────────────────────────────────────────────────

/** Shortest strong path from the GC roots to every node (BFS tree). */
function retainerTree(g) {
  const parent = new Int32Array(g.n).fill(-1);
  const via = new Array(g.n);
  parent[0] = 0;
  const queue = new Uint32Array(g.n);
  let head = 0, tail = 0;
  queue[tail++] = 0;
  while (head < tail) {
    const i = queue[head++];
    for (const e of g.edges(i)) {
      if (e.type === "weak" || e.type === "shortcut" || parent[e.to] !== -1) continue;
      parent[e.to] = i;
      via[e.to] = e.type === "element" || e.type === "hidden" ? `[${e.name}]` : `.${e.name}`;
      queue[tail++] = e.to;
    }
  }
  return { parent, via };
}

function label(g, i) {
  const t = g.type(i);
  let name = g.name(i);
  if (t === "string" || t === "concatenated string" || t === "sliced string") name = JSON.stringify(name.slice(0, 30));
  else name = name.slice(0, 60);
  const site = t === "closure" ? closureSite(g, i) : "";
  return `${t}:${name}${site ? ` @ ${site}` : ""}`;
}

/** The path to `i`, with the long context chains in the middle elided. */
function retainerPath(g, tree, i) {
  const steps = [];
  for (let cur = i; cur !== 0 && tree.parent[cur] !== -1 && steps.length < 2000; cur = tree.parent[cur]) {
    steps.push(`${tree.via[cur]} → ${label(g, cur)}`);
  }
  if (tree.parent[i] === -1) return { path: ["(unreachable)"], devtools: false, owner: "" };
  steps.reverse();
  const devtools = steps.some((s) => s.includes("DevTools console"));
  // The owning variable: the last name read off a scope (module or closure),
  // which in the unmangled perf build is the source identifier.
  let owner = "";
  for (let k = 1; k < steps.length; k++) {
    if (steps[k - 1].includes("system / Context") && steps[k].startsWith(".") && !steps[k].startsWith(".previous ") && !steps[k].startsWith(".context ")) {
      owner = steps[k].slice(1, steps[k].indexOf(" →"));
    }
  }
  // Root frames, then the owning closures/contexts nearest the object.
  const head = steps.slice(1, 6);
  const sites = steps.slice(6, -6).filter((s) => s.includes(" @ ")).slice(-4);
  const tailSteps = steps.slice(-6);
  const path = steps.length <= 12 ? steps.slice(1) : [...head, `… ${steps.length - 11} steps …`, ...sites, ...tailSteps];
  return { path, devtools, owner };
}

// ─── Diff ──────────────────────────────────────────────────────────────────

export function heapDiff(earlyPath, latePath, { top = 15 } = {}) {
  const a = load(earlyPath);
  const before = new Map();
  const classesA = new Map();
  const detachedA = new Map();
  for (let i = 0; i < a.n; i++) {
    const t = a.type(i);
    if (CONTAINERS.has(t)) before.set(a.id(i), measure(a, i));
    const k = `${t}:${a.name(i).slice(0, 60)}`;
    classesA.set(k, (classesA.get(k) ?? 0) + 1);
    if (a.detached(i) === 2) detachedA.set(a.name(i), (detachedA.get(a.name(i)) ?? 0) + 1);
  }
  const heapA = totalSize(a);
  const netA = classTotals(a);

  const b = load(latePath);
  const grown = [];
  const fresh = new Map();
  const detachedB = new Map();
  for (let i = 0; i < b.n; i++) {
    const t = b.type(i);
    const id = b.id(i);
    const prev = before.get(id);
    if (prev && CONTAINERS.has(t)) {
      const now = measure(b, i);
      const dBytes = now.bytes - prev.bytes;
      const dEntries = now.entries - prev.entries;
      if (dBytes > 0 || dEntries > 0) grown.push({ i, dBytes, dEntries, entries: now.entries });
    } else if (!prev) {
      const name = t === "string" || t === "concatenated string" || t === "sliced string" ? "(string)" : t === "code" ? "(code)" : b.name(i).slice(0, 60);
      const k = `${t}:${name}`;
      const e = fresh.get(k) ?? { count: 0, bytes: 0 };
      e.count++;
      e.bytes += b.size(i);
      fresh.set(k, e);
    }
    if (b.detached(i) === 2) detachedB.set(b.name(i), (detachedB.get(b.name(i)) ?? 0) + 1);
  }
  const heapB = totalSize(b);
  const netB = classTotals(b);
  // Net per class: "new objects" also counts churn that replaced freed ones; this doesn't.
  const netByClass = [...new Set([...netA.keys(), ...netB.keys()])]
    .map((k) => {
      const x = netA.get(k) ?? { count: 0, bytes: 0 };
      const y = netB.get(k) ?? { count: 0, bytes: 0 };
      return { class: k, count: y.count - x.count, bytes: y.bytes - x.bytes };
    })
    .sort((x, y) => y.bytes - x.bytes)
    .slice(0, 25);
  // Entries are the leak signal (a Map's table only grows in steps); bytes break ties.
  grown.sort((x, y) => y.dEntries - x.dEntries || y.dBytes - x.dBytes);
  const tree = retainerTree(b);
  const growers = [];
  for (const g of grown) {
    if (growers.filter((x) => !x.profiler && !x.devtools).length >= top) break;
    const { path, devtools, owner } = retainerPath(b, tree, g.i);
    const profiler = PROFILER_OWNERS.has(owner.replace(/\$\d+$/, ""));
    growers.push({ object: label(b, g.i), owner, entriesAdded: g.dEntries, entries: g.entries, bytesAdded: g.dBytes, devtools, profiler, path });
  }
  const newByClass = [...fresh.entries()]
    .map(([k, e]) => ({ class: k, count: e.count, bytes: e.bytes }))
    .sort((x, y) => y.bytes - x.bytes)
    .slice(0, 25);
  const detached = [...new Set([...detachedA.keys(), ...detachedB.keys()])]
    .map((name) => ({ name, before: detachedA.get(name) ?? 0, after: detachedB.get(name) ?? 0 }))
    .filter((d) => d.after > 0)
    .sort((x, y) => y.after - y.before - (x.after - x.before))
    .slice(0, 15);
  return {
    heapMB: { before: mb(heapA), after: mb(heapB) },
    detachedNodes: { before: sum(detachedA), after: sum(detachedB) },
    growers,
    netByClass,
    newByClass,
    detached,
  };
}

function classTotals(g) {
  const out = new Map();
  for (let i = 0; i < g.n; i++) {
    const t = g.type(i);
    const name = t === "string" || t === "concatenated string" || t === "sliced string" ? "(string)" : t === "code" ? "(code)" : g.name(i).slice(0, 60);
    const k = `${t}:${name}`;
    const e = out.get(k) ?? { count: 0, bytes: 0 };
    e.count++;
    e.bytes += g.size(i);
    out.set(k, e);
  }
  return out;
}

function totalSize(g) {
  let s = 0;
  for (let i = 0; i < g.n; i++) s += g.size(i);
  return s;
}
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const sum = (m) => [...m.values()].reduce((x, y) => x + y, 0);

export function formatDiff(d) {
  const out = [];
  out.push(`heap (self sizes): ${d.heapMB.before} → ${d.heapMB.after} MB; detached DOM nodes ${d.detachedNodes.before} → ${d.detachedNodes.after}`);
  out.push("\n── growers (alive in both, gained entries) ──");
  const app = d.growers.filter((g) => !g.profiler && !g.devtools);
  const harness = d.growers.filter((g) => g.profiler || g.devtools);
  for (const g of app) {
    out.push(`\n+${g.entriesAdded} entries (${g.entries} now, +${Math.round(g.bytesAdded / 1024)}KB) ${g.object}${g.owner ? `  owner: ${g.owner}` : ""}`);
    for (const p of g.path) out.push(`    ${p}`);
  }
  if (harness.length) {
    out.push(`\n(profiler/DevTools growth, not the app: ${harness.map((g) => `${g.owner || g.object} +${g.entriesAdded}`).join(", ")})`);
  }
  out.push("\n── net growth by class (later minus earlier) ──");
  for (const c of d.netByClass) out.push(`${String(Math.round(c.bytes / 1024)).padStart(8)}KB ${String(c.count).padStart(7)}  ${c.class}`);
  out.push("\n── new objects by class (includes churn) ──");
  for (const c of d.newByClass) out.push(`${String(Math.round(c.bytes / 1024)).padStart(8)}KB ${String(c.count).padStart(7)}  ${c.class}`);
  if (d.detached.length) {
    out.push("\n── detached DOM (before → after) ──");
    for (const x of d.detached) out.push(`${String(x.before).padStart(6)} → ${String(x.after).padStart(6)}  ${x.name}`);
  }
  return out.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [early, late] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!early || !late) {
    console.error("usage: node --max-old-space-size=8192 scripts/heap-diff.mjs early.heapsnapshot late.heapsnapshot [--json out.json]");
    process.exit(2);
  }
  const d = heapDiff(early, late);
  console.log(formatDiff(d));
  const j = process.argv.indexOf("--json");
  if (j > 0 && process.argv[j + 1]) writeFileSync(process.argv[j + 1], JSON.stringify(d, null, 2));
}
