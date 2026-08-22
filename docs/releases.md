# Releases: kind 30622

A release is a set of signed, content-addressed build artifacts for one version
of a NIP-34 repository. Armada publishes one per version tag; `/downloads`
reads nothing else.

This document is both the implementation reference and the upstream proposal.

## Why not kind 30063

NIP-51 lists kind 30063 "Release artifact sets", and Armada already publishes
one per version — `buzz.armada.app@X.Y.Z`, emitted by `zsp` from the `android`
job. **That keeps working and is not what this is.** 30063 is Zapstore's
app-distribution event: it is scoped to a *software application* (kind 32267),
and its artifacts are `e` tags pointing at separate kind-3063 file-metadata
events.

A NIP-34 release differs on both axes. It is scoped to a *repository* — a
`d`-identified 30617 with a maintainer set — not to an app-store listing, and
Armada carries artifacts inline. Publishing that shape under 30063 would mean
emitting an event that Zapstore indexes, tries to read as an artifact set, and
finds empty. Overloading a kind so that existing software misparses it is worse
than taking a new number.

30619 through 30621 are already in use in the wild (a git-CI status extension, a
kanban tool, and a graph tool respectively), unregistered but live. 30622 is the
first free slot after NIP-34's 30617/30618 block.

## The event

```json
{
  "kind": 30622,
  "pubkey": "<a maintainer of the repository>",
  "created_at": 1787332212,
  "content": "<release notes, markdown>",
  "tags": [
    ["d", "armada@v0.55.3"],
    ["D", "armada"],
    ["r", "refs/tags/v0.55.3"],
    ["commit", "b2b4e840bee180905ea2b64f2be46f91e47ba6e9"],
    ["version", "v0.55.3"],
    ["title", "Armada v0.55.3"],
    ["c", "main"],

    ["artifact",
      "url https://blossom.example/aef4cd12….AppImage",
      "x aef4cd12f86e8afed97ca215ca2641b4fd12f6c1c88ea3d55769a387fffec7ef",
      "m application/vnd.appimage",
      "size 142871382",
      "f linux-x86_64",
      "filename Armada-v0.55.3.AppImage",
      "alt Linux AppImage (x86_64)"],

    ["f", "linux-x86_64"]
  ]
}
```

### Binding to the repository

There is **no `a` tag**, deliberately. NIP-34 already establishes how a
subordinate event names its repository: kind 30618 (repo state) carries
`["d", "<repo-id>"]` and the spec says it "matches the identifier in the
corresponding repository announcement". Same author plus same `d` *is* the
link — `30618:<pk>:armada` sits beside `30617:<pk>:armada`.

A release cannot use `d` literally, because it must be one addressable event per
*version*: `d` of `armada` would make each release replace the last and destroy
the history the downloads page exists to show. So `d` is
`<repo-id>@<version>`, **split on the last `@`**, and the left side is the repo
id. `30617:<same author>:<left-of-@>` is the announcement, derived rather than
asserted.

`D` carries the bare repo id so the derivation does not require parsing `d`, and
because relays index single-letter tags: `#D` is what makes "every release of
this repository" a filter rather than a scan. The capitalization follows NIP-22,
where an uppercase tag is the same kind of value as its lowercase counterpart
but refers to the root scope — `E` is an event id like `e`, `A` an address like
`a`, so `D` is a `d` value. NIP-22's own answer would be `A` with a full
coordinate, but the kind is fixed at 30617 by this spec and the author is our
own pubkey, so `A` would restate what is already known.

The cost of deriving rather than asserting is real and worth stating. A relay
whose write policy is "the event must reference a repository I accept" cannot
see a reference that is derived: `relay.ngit.dev`, this repository's own relay,
refuses every release with `restricted: Event event must reference an accepted
repository or accepted event`. Releases are therefore published to, and read
from, the general relays instead — `DEFAULT_RELAYS` in
`scripts/publish-release.mjs` and `RELEASE_RELAYS` in `src/lib/releases.ts`,
which have to name the same set. Adding `a` back to satisfy such a policy would
restate what `d` and `D` already say and reopen the question of which is
authoritative; a relay wanting to gate on the repository can build
`30617:<author>:<D>` itself, with no parsing at all.

Note this makes a release *per maintainer*. Four maintainers can each publish
`30622:<their-pk>:armada@v0.55.3` and all four coexist. Resolve it the way
NIP-34 resolves Status events — "the most recent … from either the issue/patch
author or a maintainer is considered valid" — by querying the announcement's
author plus its `maintainers` tag.

There is deliberately no `euc` tag. NIP-34 puts one on patches and issues so a
tool holding a local clone can find them without knowing which npub announced
the repo; a release is found from the maintainer set instead. Grouping by `euc`
would also group *binaries* across forks, making the author-less query
`{"kinds":[30622],"#r":["<euc>"]}` the convenient one — fine for a patch against
a codebase, bad for artifacts people execute.

### Tags

| tag | cardinality | meaning |
|---|---|---|
| `d` | 1 | `<repo-id>@<version>`, split on the last `@` |
| `D` | 1 | the repo id; `30617:<author>:<D>` is the announcement |
| `version` | 1 | the version, as spelled in the git tag |
| `r` | 1 | `refs/tags/<tag>` — the ref the release was cut from |
| `commit` | 1 | the commit that ref resolved to at build time |
| `title` | 0-1 | display name |
| `c` | 0-1 | release channel: `main` for stable, `rc` for a prerelease |
| `f` | 0+ | platforms present, so a client can filter without parsing artifacts |
| `artifact` | 0+ | one build output, below |

`commit` is carried rather than looked up: kind 30618 is the nominal source of
truth for `refs/tags/*`, but in practice it goes stale — Armada's own 30618 has
141 tag entries and is missing recent ones — so a release that cannot state its
own provenance is not self-sufficient.

`c` is the channel, matching how 30063 publishers spell it (`main`, `rc`). Note
this is the opposite of ngit-ci's kind 9841/9842, where `c` is a commit id and
`r` is a ref name. Adjacent specs, colliding letters; this one follows the
release convention.

### `artifact`

Variadic, space-delimited `key value` pairs — the NIP-92 encoding, with NIP-94
field names, so any existing `imeta` parser reads it unchanged.

| key | required | meaning |
|---|---|---|
| `url` | yes | where the bytes are; Blossom, so the path carries the hash |
| `x` | yes | sha256 of the file, hex |
| `m` | yes | MIME type |
| `size` | yes | bytes |
| `f` | yes | platform token |
| `filename` | yes | the name to save as |
| `alt` | no | human label, e.g. `Linux AppImage (x86_64)` |

**It is not an `imeta` tag, on purpose.** NIP-92 defines `imeta` as metadata for
media URLs *appearing in `.content`*: each tag "SHOULD match a URL in the event
content", clients "MAY replace imeta URLs with rich previews", and — decisively
— "the client MAY ignore `imeta` tags that do not match the URL in the event
content". Release notes contain no Blossom URLs, so every artifact would be
spec-legal to discard, and a generic client would be invited to rich-preview a
136 MB AppImage. `artifact` is also what ngit-ci already calls the same concept
on kind 9841 (`["artifact", url, filename, name]`); this is that tag with a
key-value payload instead of a positional one.

`x` is redundant with a Blossom URL's path today. It is carried anyway because
it is what survives mirroring to a server that does not hash-name its paths, and
because it lets a client verify bytes rather than trust an origin.

`x` is also the only digest, and deliberately so. The desktop app self-updates
from this event, and electron-updater's own default is sha512 — but sha256 is
the same SHA-2 family, its 128-bit collision resistance is far past what a
content address for an installer needs, and on any CPU with SHA-NI or the ARMv8
crypto extensions it is roughly twice as *fast*. The library's sha512 default is
a software-speed call from 2016 that modern hardware has inverted, and the
`sha2` field it reads a sha256 from is marked deprecated only because it once
cross-checked a Bintray response header. None of that is a reason to publish a
second hash of every artifact. Don't add one.

### Platform tokens (`f`)

The observed vocabulary is thin and inconsistent — ngit-ci emits
`linux-x86_64` (kernel + arch), Zapstore emits `android-arm64-v8a` (platform +
ABI), and nothing exists for Windows or macOS. Armada uses:

```
linux-x86_64  windows-x86_64  darwin-aarch64  darwin-x86_64  android-arm64-v8a
```

Treat `f` as advisory. Clients should render from `alt`, `m` and `filename`, so
a later vocabulary change costs a grouping hint rather than a download button.

## Reading

```jsonc
// every release of a repository, newest first
{"kinds":[30622],"authors":["<author>","<…maintainers>"],"#D":["armada"]}
```

The author set comes from the 30617: its `pubkey` plus its `maintainers` tag.
Ignoring it and querying `#D` alone would accept a release of "armada" from
anybody.

Two readers, one event. `/downloads` renders the whole set
(`src/lib/releases.ts`, `useReleases.ts`); the Electron app resolves it to the
single installer the running machine can replace itself with
(`src/lib/desktopUpdate.ts`, bundled into `electron/updateFeed.cjs` and wrapped
as an electron-updater provider by `electron/nostrUpdateProvider.js`). The
parsing is shared rather than reimplemented, which is the point — a second
parser would be a second contract.

The updater applies three checks the download page does not need, because it is
the reader that *executes* what it fetches and its transport is an untrusted
relay socket: the signature must verify, the author must be one of the
build-pinned `RELEASE_AUTHORS`, and `D` must be this repository. `RELEASE_AUTHORS`
being a build-time constant rather than the live `maintainers` tag matters most
here — anyone who ever landed in that tag could otherwise publish a binary the
desktop app would install.

## Publishing

`scripts/publish-release.mjs`, from the `release` job of
`.ngit/act/workflows/release.yml`, which `needs:` every build job so exactly one
writer produces the event. That single-writer property is load-bearing: 30622 is
addressable, replacement is whole-event rather than a tag union, and Nostr has
no compare-and-swap, so two jobs publishing the same `d` would silently lose one
side's artifacts.
