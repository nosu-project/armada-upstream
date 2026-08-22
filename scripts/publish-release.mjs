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
 *   BLOSSOM_SERVERS     Comma-separated. Default https://blossom.ditto.pub
 *   RELAY_URLS          Comma-separated. Default: the repo's relays + readers.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { decode } from 'nostr-tools/nip19';
import { hexToBytes } from '@noble/hashes/utils';

/** See docs/releases.md. 30619-30621 are squatted; this is the first free slot. */
const RELEASE_KIND = 30622;
/** BUD-02 upload authorization. */
const BLOSSOM_AUTH_KIND = 24242;

const DEFAULT_BLOSSOM = 'https://blossom.ditto.pub';
/**
 * The repo's own relays (from its kind-30617 `relays` tag) plus the general
 * ones the web client reads. NIP-34 says repo events belong on the former; the
 * downloads page needs the latter.
 */
const DEFAULT_RELAYS = [
  'wss://relay.ngit.dev',
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

/** BUD-02 upload, authorized by a kind-24242 event the signer produces. */
async function uploadBlob(server, path, hash, mime, sign) {
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
  if (!pointer) throw new Error(`could not parse NOSTR_BUNKER_URL: ${url}`);

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
  const servers = (env.BLOSSOM_SERVERS || DEFAULT_BLOSSOM).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const relays = (env.RELAY_URLS ? env.RELAY_URLS.split(',') : DEFAULT_RELAYS).map((s) => s.trim()).filter(Boolean);

  const paths = await collectArtifacts(opts);
  if (paths.length === 0) usage('no artifacts found; pass --dir or --file');

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
    const results = await Promise.allSettled(pool.publish(relays, event));
    pool.close(relays);

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    results.forEach((r, i) => {
      if (r.status === 'rejected') stderr.write(`  warn ${relays[i]}: ${r.reason}\n`);
    });
    stderr.write(`published ${event.id} to ${ok}/${relays.length} relay(s)\n`);
    // One relay is enough for the release to exist; zero means it does not.
    if (ok === 0) throw new Error('no relay accepted the release event');
  } finally {
    await signer.close();
  }
}

main().catch((err) => {
  stderr.write(`error: ${err.message}\n`);
  exit(1);
});
