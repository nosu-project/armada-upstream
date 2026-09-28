#!/usr/bin/env node
/**
 * Publish a NIP-34 repository release (kind 30622) for a version tag.
 *
 * See `docs/releases.md` for the event shape and why it is not kind 30063.
 *
 * For each artifact this hashes the file, checks whether that blob is ALREADY on
 * Blossom, uploads it only if it isn't, and records it as an `artifact` tag.
 * The check matters: ngit-ci already uploads run artifacts to the same Blossom
 * server, so on a healthy run most files are hits and this only pays for the
 * ones the coordinator dropped (an upload that 413'd, a file past its per-job
 * cap, a budget it ran out of). Uploading unconditionally would re-send most of
 * a gigabyte for blobs already sitting there under the same hash.
 *
 * Blossom is redundant and no one server may be able to fail a release:
 *   - servers are probed first (a Blossom-level HEAD; a 5xx counts as down,
 *     because a proxy up in front of a dead backend is the common outage), so
 *     a dead one is skipped rather than given three fifteen-minute upload
 *     attempts per artifact;
 *   - an artifact is stored on the FIRST live server that takes it, and that
 *     is enough to publish;
 *   - only AFTER the release event is out are the other servers asked to
 *     mirror each blob (BUD-04 `PUT /mirror`), under one fixed budget. A slow
 *     or failing mirror can therefore delay the job, never block the release.
 *     Whatever it misses, the next release's probe-and-mirror finds again.
 *
 * Exactly ONE process may publish a given release. Kind 30622 is addressable,
 * replacement is whole-event rather than a tag union, and Nostr has no
 * compare-and-swap — two publishers racing the same `d` silently lose one
 * side's artifacts. That is why the `release` job `needs:` every build job
 * rather than each build publishing its own.
 *
 * Usage:
 *   node scripts/publish-release.mjs --version v1.2.3 --commit <sha> --dir <path> [options]
 *
 *   --version <tag>     Version tag, e.g. v1.2.3. Required.
 *   --commit <sha>      Commit the tag resolves to. Required unless --dry-run.
 *   --dir <path>        Directory of artifacts. Repeatable.
 *   --file <path>       A single artifact. Repeatable.
 *   --repo-id <id>      NIP-34 repo identifier (the 30617 `d`). Default "armada".
 *   --notes <text>      Release notes. Default: extracted from CHANGELOG.md.
 *   --notes-file <path> Release notes from a file.
 *   --dry-run           Print the event; upload nothing, publish nothing.
 *
 * Environment:
 *   NOSTR_BUNKER_URL    bunker:// URL of an already-established NIP-46 session.
 *   NOSTR_CLIENT_KEY    That session's client secret key (hex or nsec). Both
 *                       halves are required: a bunker URL whose one-time
 *                       `secret=` has been consumed is useless without the
 *                       client key the bunker authorized.
 *   BLOSSOM_SERVERS     Comma-separated, most trusted first. Default: the
 *                       `servers` of .nsite/config.json, the same list every
 *                       nsite deploy uses; https://blossom.ditto.pub if that
 *                       file cannot be read.
 *   RELAY_URLS          Comma-separated. Default: the relays /downloads reads.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process, { argv, env, exit, stderr, stdout } from 'node:process';

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { decode } from 'nostr-tools/nip19';
import { hexToBytes } from '@noble/hashes/utils';

/** See docs/releases.md. 30619-30621 are squatted; this is the first free slot. */
const RELEASE_KIND = 30622;
/** BUD-02 upload authorization (BUD-04 mirroring reuses it). */
const BLOSSOM_AUTH_KIND = 24242;
/** Attempts per blob per server, before the release is refused. */
const UPLOAD_ATTEMPTS = 3;
/** How long one relay gets to acknowledge the release event. */
const PUBLISH_TIMEOUT_MS = 30_000;
/** How long a server gets to answer the liveness probe. */
const PROBE_TIMEOUT_MS = 10_000;
/**
 * The whole post-publish mirror pass, all servers and artifacts together. It
 * runs after the release event is out, so this bounds how late the job ends,
 * never whether the release happens.
 */
const MIRROR_BUDGET_MS = 5 * 60_000;
/** sha256("") — well-formed, and no server stores an empty blob under it. */
const PROBE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const DEFAULT_BLOSSOM = 'https://blossom.ditto.pub';

/** The servers every nsite deploy uses, so the release artifacts live beside the site. */
function configuredServers() {
  try {
    const config = JSON.parse(readFileSync('.nsite/config.json', 'utf8'));
    const servers = Array.isArray(config.servers) ? config.servers.filter((s) => typeof s === 'string') : [];
    if (servers.length > 0) return servers.join(',');
  } catch {
    // Not run from the repo root, or no config: fall through to the default.
  }
  return DEFAULT_BLOSSOM;
}
/**
 * Where the release is broadcast. Must match `RELEASE_RELAYS` in
 * `src/lib/releases.ts` — a relay that is written but not read publishes into
 * the void, and one that is read but not written is a page with no downloads.
 *
 * `wss://relay.ngit.dev`, the repo's own relay, is deliberately absent. It
 * restricts writes to events that reference an accepted repository, and a
 * release names its repo through the derivable `D` tag rather than an `a` tag
 * (docs/releases.md), so it answered every release event with
 * `restricted: Event event must reference an accepted repository or accepted
 * event`. Adding the `a` tag back to satisfy one relay would reintroduce the
 * ambiguity `D` exists to remove; the release simply lives elsewhere.
 */
const DEFAULT_RELAYS = [
  'wss://relay.ditto.pub',
  'wss://relay.dreamith.to',
  'wss://relay.primal.net',
];

/**
 * How a built file is described on the wire.
 *
 * Ordered, first match wins: `-portable.exe` has to be tested before `.exe`,
 * and the per-arch mac zips before any generic `.zip`, or the more specific
 * build is labelled as the less specific one.
 */
const ARTIFACT_KINDS = [
  { match: /\.AppImage$/i, m: 'application/vnd.appimage', f: 'linux-x86_64', alt: 'Linux AppImage (x86_64)' },
  { match: /\.deb$/i, m: 'application/vnd.debian.binary-package', f: 'linux-x86_64', alt: 'Debian / Ubuntu package (x86_64)' },
  { match: /\.flatpak$/i, m: 'application/vnd.flatpak', f: 'linux-x86_64', alt: 'Flatpak bundle (x86_64)' },
  { match: /-portable\.exe$/i, m: 'application/vnd.microsoft.portable-executable', f: 'windows-x86_64', alt: 'Windows portable (x64)' },
  { match: /\.exe$/i, m: 'application/vnd.microsoft.portable-executable', f: 'windows-x86_64', alt: 'Windows installer (x64)' },
  { match: /-mac-arm64\.zip$/i, m: 'application/zip', f: 'darwin-aarch64', alt: 'macOS (Apple silicon)' },
  { match: /-mac-x64\.zip$/i, m: 'application/zip', f: 'darwin-x86_64', alt: 'macOS (Intel)' },
  { match: /\.apk$/i, m: 'application/vnd.android.package-archive', f: 'android-arm64-v8a', alt: 'Android APK' },
];

function usage(message) {
  if (message) stderr.write(`${message}\n`);
  stderr.write('Usage: publish-release.mjs --version <tag> --commit <sha> --dir <path> [--dry-run]\n');
  exit(2);
}

function parseArgs(args) {
  const opts = { dirs: [], files: [], repoId: 'armada', dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--version') opts.version = args[++i];
    else if (arg === '--commit') opts.commit = args[++i];
    else if (arg === '--dir') opts.dirs.push(args[++i]);
    else if (arg === '--file') opts.files.push(args[++i]);
    else if (arg === '--repo-id') opts.repoId = args[++i];
    else if (arg === '--notes') opts.notes = args[++i];
    else if (arg === '--notes-file') opts.notesFile = args[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
    else usage(`Unknown argument: ${arg}`);
  }
  if (!opts.version) usage('--version is required');
  if (!opts.version.startsWith('v')) usage(`--version must be a tag like v1.2.3, got "${opts.version}"`);
  if (!opts.commit && !opts.dryRun) usage('--commit is required');
  return opts;
}

/** Every file under the given dirs, plus any named individually. */
async function collectArtifacts({ dirs, files }) {
  const found = new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      stderr.write(`warning: cannot read --dir ${dir}: ${err.message}\n`);
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) found.set(basename(entry.name), join(dir, entry.name));
    }
  }
  for (const file of files) found.set(basename(file), file);
  return [...found.values()].sort();
}

/** Streamed so a 140 MB installer is never held in memory just to be hashed. */
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** The file extension Blossom URLs carry, matching how ngit-ci names blobs. */
function extensionOf(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot) : '';
}

function describe(filename) {
  return ARTIFACT_KINDS.find((kind) => kind.match.test(filename));
}

/** BUD-01: a stored blob answers at `<server>/<sha256>`, extension optional. */
async function hasBlob(server, hash) {
  try {
    const res = await fetch(`${server}/${hash}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Whether a server is answering at the Blossom level right now.
 *
 * A HEAD for a hash no server has: 404 is the healthy answer, and any 2xx/3xx/4xx
 * proves the blob endpoint is alive. A 5xx is a reverse proxy up in front of a
 * backend that is not — the common shape of an outage, and the one a probe of
 * `/` misses. Same rule as scripts/live-hosts.sh.
 */
async function isLive(server) {
  try {
    const res = await fetch(`${server}/${PROBE_HASH}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** The configured servers that answer the probe, in the configured order. */
async function liveServers(servers) {
  const answers = await Promise.all(servers.map((server) => isLive(server)));
  const live = servers.filter((_, i) => answers[i]);
  servers.forEach((server, i) => {
    if (!answers[i]) stderr.write(`  drop ${server} (not answering)\n`);
  });
  return live;
}

/** BUD-02 upload, authorized by a kind-24242 event the signer produces. */
async function uploadOnce(server, path, hash, mime, sign) {
  const now = Math.floor(Date.now() / 1000);
  const auth = await sign({
    kind: BLOSSOM_AUTH_KIND,
    created_at: now,
    content: `Upload ${basename(path)}`,
    tags: [
      ['t', 'upload'],
      ['x', hash],
      ['expiration', String(now + 600)],
    ],
  });

  const res = await fetch(`${server}/upload`, {
    method: 'PUT',
    body: readFileSync(path),
    headers: {
      'Content-Type': mime,
      Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`,
    },
    // Generous: these are ~100 MB bodies and the far side hashes them.
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!res.ok) {
    throw new Error(`${server} rejected ${basename(path)}: ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
}

/**
 * Upload with retries.
 *
 * These are ~100 MB bodies over a connection held open for minutes, and a
 * single dropped one used to end the release: the whole event is refused if any
 * artifact cannot be stored, so one transient `fetch failed` two thirds of the
 * way through a set cost a version its downloads. Between attempts the blob is
 * re-checked, because the coordinator uploads its own copy of the same bytes
 * around the same time and a hit there is as good as our own success.
 */
async function uploadBlob(server, path, hash, mime, sign) {
  let lastError;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      await uploadOnce(server, path, hash, mime, sign);
      return;
    } catch (err) {
      lastError = err;
      if (attempt === UPLOAD_ATTEMPTS) break;
      if (await hasBlob(server, hash)) return;
      const backoff = 5_000 * attempt;
      stderr.write(`  retry ${basename(path)} in ${backoff / 1000}s (${attempt}/${UPLOAD_ATTEMPTS}): ${err.message}\n`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastError;
}

/**
 * Resolve one file to an `artifact` tag, uploading only if no server has it.
 *
 * Returns undefined for a file we have no description for, rather than
 * guessing: an unrecognized name in the artifact directory is far more likely
 * to be a stray (a mapping file, a checksum list) than a download to offer.
 */
async function resolveArtifact(path, { servers, sign, dryRun }) {
  const filename = basename(path);
  const kind = describe(filename);
  if (!kind) {
    stderr.write(`  skip ${filename} (no artifact type matches)\n`);
    return undefined;
  }

  const size = statSync(path).size;
  const hash = await sha256File(path);
  const ext = extensionOf(filename);

  let host;
  for (const server of servers) {
    if (await hasBlob(server, hash)) {
      host = server;
      stderr.write(`  have ${filename} (${hash.slice(0, 12)}… on ${server})\n`);
      break;
    }
  }

  if (!host && !dryRun) {
    let lastError;
    for (const server of servers) {
      try {
        await uploadBlob(server, path, hash, kind.m, sign);
        host = server;
        stderr.write(`  sent ${filename} (${hash.slice(0, 12)}… to ${server})\n`);
        break;
      } catch (err) {
        lastError = err;
        stderr.write(`  warn ${filename}: ${err.message}\n`);
      }
    }
    if (!host) throw new Error(`could not store ${filename}: ${lastError?.message ?? 'no servers configured'}`);
  }

  // A dry run reports where the blob WOULD live so the tag can be inspected.
  host ??= servers[0];

  return [
    'artifact',
    `url ${host}/${hash}${ext}`,
    `x ${hash}`,
    `m ${kind.m}`,
    `size ${size}`,
    `f ${kind.f}`,
    `filename ${filename}`,
    `alt ${kind.alt}`,
  ];
}

/**
 * BUD-04: ask `server` to fetch the blob from `sourceUrl`, where it is already
 * served, rather than sending it the bytes again from here. The authorization is
 * the same kind-24242 `upload` event, naming the blob by hash; one signed per
 * artifact covers every server it is mirrored to.
 */
async function mirrorOnce(server, sourceUrl, auth, signal) {
  const res = await fetch(`${server}/mirror`, {
    method: 'PUT',
    body: JSON.stringify({ url: sourceUrl }),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`,
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text().catch(() => '')}`.trim());
  }
}

/**
 * Best-effort: put every artifact on every live server it is not on yet.
 *
 * Runs only after the release event has been published, all requests in
 * flight together under one budget, and never throws — the release is out
 * whatever happens here. Each miss is reported; the next release's pass (or a
 * client walking the mirrors by hash) is what makes it up.
 */
async function mirrorArtifacts(artifacts, servers, sign) {
  const signal = AbortSignal.timeout(MIRROR_BUDGET_MS);
  const jobs = [];
  for (const tag of artifacts) {
    const url = tag.find((v) => v.startsWith('url '))?.slice(4);
    const hash = tag.find((v) => v.startsWith('x '))?.slice(2);
    if (!url || !hash) continue;
    const host = url.slice(0, url.lastIndexOf('/'));
    const targets = servers.filter((server) => server !== host);
    if (targets.length === 0) continue;

    jobs.push((async () => {
      const missing = [];
      for (const server of targets) {
        if (!(await hasBlob(server, hash))) missing.push(server);
      }
      if (missing.length === 0) return;

      const now = Math.floor(Date.now() / 1000);
      const auth = await sign({
        kind: BLOSSOM_AUTH_KIND,
        created_at: now,
        content: `Mirror ${basename(url)}`,
        tags: [
          ['t', 'upload'],
          ['x', hash],
          ['expiration', String(now + 600)],
        ],
      });
      await Promise.all(missing.map(async (server) => {
        try {
          await mirrorOnce(server, url, auth, signal);
          stderr.write(`  mirrored ${hash.slice(0, 12)}… to ${server}\n`);
        } catch (err) {
          stderr.write(`  warn mirror ${hash.slice(0, 12)}… to ${server}: ${err.message}\n`);
        }
      }));
    })());
  }
  if (jobs.length === 0) return;
  stderr.write(`mirroring ${jobs.length} artifact(s) across ${servers.length} server(s)\n`);
  await Promise.allSettled(jobs);
}

function releaseNotes({ notes, notesFile, version }) {
  if (notes) return notes;
  if (notesFile) return readFileSync(notesFile, 'utf8').trim();
  try {
    return execFileSync('node', ['scripts/extract-release-notes.mjs', version], { encoding: 'utf8' }).trim();
  } catch {
    stderr.write(`warning: no CHANGELOG entry for ${version}; publishing without notes\n`);
    return '';
  }
}

/** Accepts an nsec or raw hex, because CI secrets get stored as either. */
function parseSecretKey(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('nsec1')) {
    const { type, data } = decode(trimmed);
    if (type !== 'nsec') throw new Error(`expected an nsec, got ${type}`);
    return data;
  }
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) throw new Error('client key must be an nsec or 64 hex characters');
  return hexToBytes(trimmed);
}

/**
 * A signing function backed by the NIP-46 bunker, plus its teardown.
 *
 * Both halves of the session are required. The `bunker://` URL names the remote
 * signer and its relay but its one-time `secret=` is long since consumed; what
 * actually authorizes us is the client key the bunker already approved. (This
 * is the same pair nsyte packs into a single `nbunksec` string.)
 */
async function connectSigner() {
  const url = env.NOSTR_BUNKER_URL?.trim();
  const clientKey = env.NOSTR_CLIENT_KEY?.trim();
  if (!url) throw new Error('NOSTR_BUNKER_URL is not set');
  if (!clientKey) throw new Error('NOSTR_CLIENT_KEY is not set');

  const pointer = await parseBunkerInput(url);
  if (!pointer) throw new Error('could not parse NOSTR_BUNKER_URL');

  const signer = BunkerSigner.fromBunker(parseSecretKey(clientKey), pointer);
  await signer.connect();
  const pubkey = await signer.getPublicKey();
  stderr.write(`signing as ${pubkey}\n`);

  return {
    pubkey,
    sign: (template) => signer.signEvent(template),
    close: () => signer.close().catch(() => {}),
  };
}

/**
 * Bound one relay's acknowledgement.
 *
 * `pool.publish` returns a promise per relay that settles on that relay's OK,
 * and nothing else ever settles it — a relay which accepts the socket, takes
 * the EVENT and then stays silent leaves it pending forever, so awaiting them
 * all has no upper bound. That is how a release whose event had already been
 * accepted by three relays sat for forty minutes until the CI coordinator's
 * run-level timeout, which then discarded every job's result. Missing one
 * relay's OK costs a copy of the event; waiting for it costs the whole run.
 */
function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no response within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Signs locally, for --dry-run, so an unsigned template is never printed. */
function ephemeralSigner() {
  const sk = hexToBytes('11'.repeat(32));
  return {
    pubkey: getPublicKey(sk),
    sign: async (template) => finalizeEvent(template, sk),
    close: async () => {},
  };
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  const configured = (env.BLOSSOM_SERVERS || configuredServers()).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const relays = (env.RELAY_URLS ? env.RELAY_URLS.split(',') : DEFAULT_RELAYS).map((s) => s.trim()).filter(Boolean);

  const paths = await collectArtifacts(opts);
  if (paths.length === 0) usage('no artifacts found; pass --dir or --file');

  // Dead servers are dropped up front: an artifact is tried on every server
  // in turn, and a server that accepts the connection and never answers costs
  // three fifteen-minute attempts per artifact before the next one is tried.
  // A dry run has nothing to upload, so it keeps the list rather than failing.
  stderr.write(`probing ${configured.length} Blossom server(s)\n`);
  let servers = await liveServers(configured);
  if (servers.length === 0) {
    if (!opts.dryRun) throw new Error('no configured Blossom server is answering');
    servers = configured;
  }

  const signer = opts.dryRun ? ephemeralSigner() : await connectSigner();

  try {
    stderr.write(`resolving ${paths.length} file(s)\n`);
    const artifacts = [];
    for (const path of paths) {
      const tag = await resolveArtifact(path, { servers, sign: signer.sign, dryRun: opts.dryRun });
      if (tag) artifacts.push(tag);
    }
    if (artifacts.length === 0) throw new Error('no recognized artifacts; refusing to publish an empty release');

    // Platforms present, deduplicated in first-seen order so the tag list is
    // stable across runs rather than reordered by Set iteration of a rebuild.
    const platforms = [];
    for (const tag of artifacts) {
      const f = tag.find((v) => v.startsWith('f '))?.slice(2);
      if (f && !platforms.includes(f)) platforms.push(f);
    }

    const version = opts.version;
    const template = {
      kind: RELEASE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: releaseNotes(opts),
      tags: [
        ['d', `${opts.repoId}@${version}`],
        ['D', opts.repoId],
        ['r', `refs/tags/${version}`],
        ...(opts.commit ? [['commit', opts.commit]] : []),
        ['version', version],
        ['title', `Armada ${version}`],
        // Anything with a prerelease suffix (v1.2.3-rc.1, -beta.2) is not the
        // stable channel. This is what a client reads instead of GitHub's
        // `prerelease` boolean.
        ['c', /-/.test(version) ? 'rc' : 'main'],
        ...artifacts,
        ...platforms.map((f) => ['f', f]),
      ],
    };

    const event = await signer.sign(template);

    if (opts.dryRun) {
      stdout.write(`${JSON.stringify(event, null, 2)}\n`);
      return;
    }

    const pool = new SimplePool();
    const results = await Promise.allSettled(
      pool.publish(relays, event).map((p, i) => withDeadline(p, PUBLISH_TIMEOUT_MS, relays[i])),
    );
    pool.close(relays);

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    results.forEach((r, i) => {
      if (r.status === 'rejected') stderr.write(`  warn ${relays[i]}: ${r.reason}\n`);
    });
    stderr.write(`published ${event.id} to ${ok}/${relays.length} relay(s)\n`);
    // One relay is enough for the release to exist; zero means it does not.
    if (ok === 0) throw new Error('no relay accepted the release event');

    // The release is out. Only now are the other servers asked for copies, so
    // a slow mirror lengthens the job and a failing one costs a copy — neither
    // touches whether the version shipped.
    await mirrorArtifacts(artifacts, servers, signer.sign);
  } finally {
    await signer.close();
  }
}

/**
 * Leave, whether or not the relay pool let go of its sockets.
 *
 * `pool.close()` does not reliably drain everything it opened, so the event
 * loop can stay alive with the work long since finished — and a release that
 * has been published but never returns is, to CI, indistinguishable from one
 * that failed. Set the exit code, then arm an UNREF'd timer: a process with
 * nothing left holding it exits immediately, on its own, with pending output
 * flushed the normal way, and only one that is genuinely being held waits out
 * the grace period and is then cut off.
 */
function finish(code) {
  process.exitCode = code;
  setTimeout(() => exit(code), 2_000).unref();
}

main().then(
  () => finish(0),
  (err) => {
    stderr.write(`error: ${err.message}\n`);
    finish(1);
  },
);
