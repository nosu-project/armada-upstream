# Concord

`draft` `optional`

End-to-end encrypted, server-less group chat ("Communities") over Nostr.

This document is the concrete wire specification for the Concord protocol as implemented in
the Vector client. Where [`README.md`](./README.md) explains the *philosophy*, this document
gives the exact event kinds, key derivations, encryption envelopes, tag layouts, and
publish/query procedures needed to implement an interoperable client from scratch.

Naming: **Concord** is the protocol; **Communities** is the user-facing feature. A *Community*
is what Discord calls a "server"; a *Channel* is a room within it.

> **Frozen wire format.** Everything in §2–§9 (HKDF labels, canonicalization byte layouts,
> tag names, sub-kind numbers, the protocol version string) is **frozen**. Any change to a
> labeled byte orphans every prior event and forces a migration. Golden test vectors in the
> Vector source pin these values.

---

## 1. Event kinds

Concord claims the contiguous block **3300–3399** in the Nostr regular (`3000–9999`) range.
Each event type gets its own kind so relays can slice by type with a pure `kinds` filter.
All Concord events of kinds 3300–3311 are **outer wire events** signed by a single-use
**ephemeral key** and addressed by a rotating **`z` pseudonym** (see §3); the real content
lives inside a NIP-44 ciphertext.

| Kind | Name | Plane | Carrier |
|---|---|---|---|
| 3300 | `COMMUNITY_MESSAGE` | append (message) | ephemeral outer + channel-key seal |
| 3301 | `COMMUNITY_REACTION` | append (reaction) | ephemeral outer + channel-key seal |
| 3302 | `COMMUNITY_EDIT` | append (edit) | ephemeral outer + channel-key seal |
| 3303 | `COMMUNITY_REKEY` | rekey | ephemeral outer + server-root seal, ECDH per-recipient blobs |
| 3304 | `COMMUNITY_INVITE_BUNDLE` | invite | NIP-59 gift-wrapped DM rumor |
| 3305 | `COMMUNITY_DELETE` | append (cooperative delete / hide) | ephemeral outer + channel-key seal |
| 3306 | `COMMUNITY_PRESENCE` | append (join/leave) | ephemeral outer + channel-key seal |
| 3307 | *retired* | — | **never reuse** |
| 3308 | `COMMUNITY_CONTROL` | control (authority + metadata) | ephemeral outer + server-root seal |
| 3309 | `COMMUNITY_KICK` | append (cooperative kick) | ephemeral outer + channel-key seal |
| 3310 | `COMMUNITY_WEBXDC` | append (realtime peer signal) | ephemeral outer + channel-key seal |
| 3311 | `COMMUNITY_TYPING` | append (typing) | ephemeral outer + channel-key seal |

Two standard kinds are reused as carriers:

- **Kind 30078** (NIP-78 application-specific, addressable) carries the **public-invite bundle**
  (§7.2), the per-user **Community List** and **Invite List** cross-device sync (§8), and the
  **owner attestation** (§6.4, embedded form).
- **Kind 5** (NIP-09 deletion) is used by a sender to delete their own outer wire event from
  relays via the retained ephemeral key (§4.5).

The inner signed event always mirrors the outer kind for the append plane (the "binding
triad", §4.3). Inner control/edition events are always kind 3308 regardless of sub-kind (§6).

---

## 2. Identities and keys

A Community runs on a small set of keys.

| Key | Bytes | Role |
|---|---|---|
| **Identity key** | secp256k1 keypair | Each member's normal Nostr `npub`. Signs inner events (authorship); roster authority is keyed by it. Never on the wire in cleartext. |
| **Server-root key** (`ServerRootKey`) | 32 | The `@everyone` base secret. Gates the control plane + metadata. Held by every member. Always distinct from every channel key. |
| **Channel key** (`ChannelKey`) | 32 | Per-channel symmetric secret. Gates one channel's messages. A member holds one per channel they can read. |
| **Ephemeral key** | secp256k1 keypair | Fresh, single-use, signs one outer wire event. Discarded (or retained locally for self-delete). |

Identifiers:

- **`CommunityId`** — random 32 bytes (NOT a timestamp snowflake). Lowercase hex on the wire.
- **`ChannelId`** — random 32 bytes. Lowercase hex.
- **`Epoch`** — `u64`, the read-access clock. Bumps only on a rekey. Serialized **big-endian**
  in HKDF info, decimal string in tags.
- **`Pseudonym`** — 32 bytes, the value carried in a relay-filterable `z` tag.

`CommunityId` and `ChannelId` are random-32 and so can never collide with the all-zero
**server-root scope sentinel** (`0x00…00`, 64 hex zeros) used by rekey scoping (§5).

---

## 3. Key derivation (HKDF) — frozen

Every Concord derivation is:

```
HKDF-SHA256(IKM, salt = ∅, info, L = 32)
info = utf8(label) || 0x00 || id32 || epoch_be
```

- `label` — an ASCII purpose string, no terminator.
- `0x00` — a single separator byte.
- `id32` — a raw 32-byte id (channel id, community id, or scope id), **never hex**.
- `epoch_be` — the epoch as `u64` big-endian (8 bytes); **omitted** where noted.

`salt = ∅` means RFC-5869 with no salt (a zero-length salt; equivalent to 32 zero bytes for
HMAC-SHA256). `L = 32` (the expand never fails at this length).

### 3.1 Frozen labels

| Label string | id32 | epoch | Output |
|---|---|---|---|
| `vector-community/v1/channel-pseudonym` | channel id | yes | channel message `z` pseudonym |
| `vector-community/v1/recipient-pseudonym` | scope id | yes | rekey blob locator |
| `vector-community/v1/rekey-pseudonym` | channel id | yes | channel-rekey `z` address |
| `vector-community/v1/base-rekey-pseudonym` | community id | yes (new epoch) | server-root-rekey `z` address |
| `vector-community/v1/public-invite-key` | all-zero | no | public invite NIP-44 decrypt key |
| `vector-community/v1/public-invite-locator` | all-zero | no | public invite `d`-tag locator |
| `vector-community/v1/public-invite-signer` | all-zero | no | public invite signing key (→ secp256k1 scalar) |
| `vector-community/v1/banlist-locator` | community id | no | banlist entity id |
| `vector-community/v1/grant-locator` | community id (IKM) + member-xonly (in info) | no | per-member grant entity id |
| `vector-community/v1/invite-links-locator` | community id (IKM) + creator-xonly (in info) | no | per-creator invite-links entity id |
| `vector-community/v1/dissolved-locator` | community id | no | dissolution tombstone entity id |
| `vector-community/v1/dissolved-pseudonym` | community id | no | dissolution `z` address (rotation-stable) |
| `vector-community/v1/dissolved-envelope-key` | community id | no | dissolution NIP-44 envelope key |

Notes:

- The **channel message pseudonym** uses `IKM = channel key`. Every member derives the same
  value from the shared channel secret; rotating the epoch rotates the pseudonym (unlinkability).
- The **control-plane pseudonym** (§6.5) reuses the `channel-pseudonym` label/derivation but
  with `IKM = server-root key` and `id32 = community id`. Domain separation rests on the
  distinct IKM (server-root is always ≠ every channel key) — NOT a distinct label.
- The **rekey pseudonym** keys off the **server root** (not the channel key), so a member can
  locate a rekey for any epoch holding only the server root — epochs are independently
  recoverable, no forward ratchet.
- The **base-rekey pseudonym** keys off the **prior** server root (the only handle a member
  holds before a base rotation).
- For `grant-locator` and `invite-links-locator`, the `info` byte string takes the form
  `label || 0x00 || subject_xonly` (no epoch) while the **IKM is the community id**. (This is
  the `build_info(label, subject_xonly, None)` shape with `IKM = community_id.0`.)

### 3.2 Locator vs. epoch stability

Entity locators (`banlist`, `grant`, `invite-links`, `dissolved`) derive from the **community
id**, not the server-root key, so they are **stable across a server-root rotation**. This is
load-bearing for re-anchoring (§5.3) and dissolution discovery (§9.3): a fresh joiner who only
holds a later epoch's root can still compute these coordinates.

### 3.3 Deriving a secp256k1 scalar from HKDF

`public_invite_signer` must produce a valid secp256k1 secret key. Use reject-and-retry: compute
`HKDF(...info)`; if it is not a valid scalar, append a single incrementing counter byte to
`info` and retry. The reject branch is ~2⁻¹²⁸ rare but the counter keeps it deterministic and
cross-implementation reproducible.

---

## 4. The message envelope (append plane: kinds 3300–3302, 3305, 3306, 3309–3311)

Every append-plane event is a three-layer construction.

```
inner event   = real-identity-signed Nostr event (kind = the append sub-kind)
ciphertext    = NIP-44 v2 seal(channel_key, inner.as_json())   (base64, STANDARD)
outer event   = ephemeral-signed Nostr event (kind = same sub-kind), content = ciphertext,
                tags: ["z", channel_pseudonym], ["v", "1"]
```

### 4.1 Symmetric primitive

The sole symmetric primitive is **raw-key NIP-44 v2**:

- `seal(key32, plaintext) -> base64(STANDARD)` — `ConversationKey::new(key32)` then
  NIP-44 v2 encrypt, then standard base64.
- `open(key32, content_b64) -> bytes` — standard-base64 decode, then NIP-44 v2 decrypt under
  `ConversationKey::new(key32)`. A wrong key or tampered payload fails the MAC.

The "key" is the raw 32-byte channel key (message plane) or server-root key (control/rekey
plane) used directly as the NIP-44 `ConversationKey` material — **not** an ECDH-derived key.

### 4.2 Inner event

The inner event is a normal Nostr event signed by the author's **real identity key** (local
keys or a NIP-46 bunker). It carries:

- `kind` = the append sub-kind (3300/3301/3302/3305/3306/3309/3310/3311), mirroring the outer.
- `created_at` = the message send time in **seconds** (`ms / 1000`).
- tags:
  - `["channel", <channel_id hex>]` — **required**, must appear exactly once.
  - `["epoch", <epoch decimal>]` — **required**, must appear exactly once.
  - `["ms", <0–999>]` — the sub-second offset; the open side reconstructs full ms as
    `created_at * 1000 + ms`. Reject an `ms` value > 999 (treated as absent).
  - `["e", <target_id>, "", "reply"]` — for a reply (3300), the reacted-to (3301), the edited
    (3302), the deleted (3305) target. NIP-25/Vector reply convention.
  - `["emoji", <shortcode>, <url>]` — NIP-30 custom emoji, one per shortcode used.
  - `["imeta", ...]` — NIP-92 attachments (§4.6), one per file.
  - `["vac", <entity hex>, <version>, <edition-hash hex>]` — authority citation (§6.3) on a
    non-owner moderation action (a 3305 hide or 3309 kick).

The inner content is the message text (3300), the reaction emoji (3301), the new text (3302),
empty (3305/3309), `"join"`/`"leave"`/attributed JSON (3306, §9.1), `"typing"` (3311), or a
WebXDC JSON op (3310, §9.2).

### 4.3 The binding triad

The outer **kind must equal the inner kind**, and the inner `channel`/`epoch` tags must equal
the channel id and the exact epoch whose key decrypted the payload (**strict equality**, not a
membership test). A receiver that finds any mismatch drops the event. This defeats insider
replay/splice across type, channel, or epoch — a member holding the channel key cannot lift
another member's signed content into a different context.

A **duplicate** `channel` or `epoch` tag on the inner is rejected (the inner is constructable by
any channel-key holder, so first-match would be nondeterministic). A duplicate `e` (reply)
tag on a *message* (3300) is tolerated (cosmetic); ambiguous targets on reaction/edit/delete are
rejected by the shared parser.

### 4.4 Outer event

The outer event:

- `kind` = the same append sub-kind (mirrors the inner).
- `pubkey` = a **fresh single-use ephemeral key** (no persistent author↔channel linkage on the
  wire). The author's real signature is *inside* the ciphertext only.
- `content` = the base64 NIP-44 ciphertext.
- tags:
  - `["z", <channel_pseudonym hex>]` — the per-epoch pseudonym from §3.1
    (`channel_pseudonym(channel_key, channel_id, epoch)`). The relay-filterable address.
  - `["v", "1"]` — the protocol version. **Checked before any decryption**; an unknown version
    is rejected gracefully.

The opener verifies `v == "1"`, decrypts under the channel key, parses the inner event,
verifies the inner Schnorr signature, then enforces the binding triad.

### 4.5 Self-deletion

The ephemeral outer key may be **retained locally** by the sender (analogous to NIP-17 wrap
keys for DMs). To delete their own message, the sender publishes a **NIP-09 kind-5 deletion**
referencing the outer event id, signed by **the same ephemeral key**. Because only the original
sender holds that key, no one else can delete the event from relays. (This is distinct from the
cooperative-delete 3305, which is an in-app tombstone honored by peers; see §9.)

Far-future inner timestamps are clamped to ~now on open (an author-controlled `created_at`
inside the ciphertext is not relay-clamped, so a hostile member could otherwise pin a message
to the top forever).

### 4.6 Attachments (NIP-92 `imeta`)

Unlike NIP-17 DMs (one media item per event), a Community message carries a caption in
`content` plus **one `imeta` tag per attachment**, so one event mixes text and N files. Each
file is encrypted with a **fresh random AES-GCM key + nonce** (the NIP-17 attachment
technique), uploaded to Blossom, and referenced by URL. The `imeta` entries are
space-delimited `key value` strings:

```
["imeta",
  "url <blossom url>",
  "m <mime>",
  "encryption-algorithm aes-gcm",
  "decryption-key <hex>",
  "decryption-nonce <hex>",
  "size <bytes>",          (optional)
  "ox <sha256-of-plaintext hex>",  (optional)
  "name <original filename>",      (optional; may contain spaces)
  "thumb <thumbhash>",     (optional, images)
  "dim <w>x<h>",           (optional, images)
  "webxdc-topic <topic>"   (optional, Mini Apps realtime)
]
```

Required for a valid attachment: `url`, `decryption-key`, `decryption-nonce`. A value is
everything after the first space (so filenames with spaces survive).

---

## 5. Rekey (kind 3303) — relocation / removal

A rekey rotates a key for a **new epoch** and delivers the fresh key only to the members who
**stay**, one **per-recipient blob** each. Used for hard removal (ban), re-founding, going
members-only, or a scheduled rotation. A removed member can read the rekey *header* but recovers
no new key.

### 5.1 Rekey scope

```
RekeyScope = Channel(channel_id)  | ServerRoot
id32(scope) = channel_id          | 0x00…00 (all-zero sentinel)
```

### 5.2 Per-recipient blob

The atom delivered to one staying member:

```
pairwise_secret = NIP-44 v2 ConversationKey::derive(my_sk, their_pk)   (symmetric ECDH)
locator         = recipient_pseudonym(pairwise_secret, scope, new_epoch)  (hex)
bound_plaintext = scope.id32()[32] || new_epoch_be[8] || new_key[32]      (72 bytes, fixed-width)
wrapped         = NIP-44 v2 seal(pairwise_secret, bound_plaintext)        (base64)
blob            = { "locator": <hex>, "wrapped": <base64> }
```

A recipient recomputes the identical `pairwise_secret` from `(their_sk, sender_pk)`, finds their
blob by `locator` (no trial decryption), decrypts, and **verifies the bound `scope`+`epoch`
match** what they opened under (strict-equality binding defeats cross-coordinate splice). A
removed member cannot even *find* a slot for a pair they are not in.

### 5.3 The 3303 event

Inner (rotator-signed, real identity key, kind 3303):

- `content` = JSON array of blobs.
- tags:
  - `["scope", <scope.id32() hex>]` — the all-zero hex means `ServerRoot`.
  - `["newepoch", <decimal>]`
  - `["prevepoch", <decimal>]`
  - `["prevcommit", <hex>]` — a commitment to the prior epoch's key (fork detection, §5.4).
- **Invariant:** `new_epoch > prev_epoch` (enforced at mint; reject otherwise).

Outer (ephemeral-signed, kind 3303):

- **Channel rekey:** enveloped under the **server-root key**, addressed by
  `rekey_pseudonym(server_root, channel_id, new_epoch)`. The new channel key lives only in the
  per-recipient blobs, never under the server-root envelope.
- **Server-root (base) rekey:** enveloped under the **prior** server-root key, addressed by
  `base_rekey_pseudonym(prior_root, community_id, new_epoch)`. The new root lives only in the
  blobs.
- tags: `["z", <address hex>]`, `["v", "1"]`.

Cap: at most **120 blobs** per 3303 event (fits under the common 64 KiB relay
`max_event_size`). A rotation with more recipients must split across events; receivers reject a
larger array after decrypting (so a hostile array is also size-bounded).

### 5.4 Epoch-key commitment

```
prev_key_commitment = SHA-256( "vector-community/v1/epoch-key-commitment" || prev_epoch_be[8] || prev_key[32] )
```

Two managers who both rotate epoch N→N+1 produce a *detectable* fork (resolved by
authority-first → time → id), and a recipient holding the prior key can confirm the rotator did
too.

### 5.5 Multi-epoch read

After catching up across one or more rekeys, a member **retains every epoch key** for a channel.
Reads query `["#z", <pseudonym per held epoch>]` (an OR-set) and select the decryption key by the
wire event's `z` pseudonym. Per-epoch keys are non-ratcheted, so any retained epoch decrypts
directly (random-access). Server-root-scoped epoch keys are stored under the all-zero scope id
(`SERVER_ROOT_SCOPE_HEX`).

---

## 6. Control plane (kind 3308) — keyless authority + metadata

There is **no shared signing key**. Read access = key possession; **write authority = a member's
npub rank in the owner-rooted roster**. The control plane is a set of per-entity append
**editions**, each real-npub-signed inside the encryption and version-chained.

### 6.1 Sub-kinds (`vsk` tag)

A control edition's inner event carries `["vsk", <n>]`:

| vsk | Entity | entity_id (coordinate) | Content |
|---|---|---|---|
| 0 | GroupRoot (community metadata) | `community_id` | `CommunityMetadata` JSON (§6.6) |
| 1 | RoleMetadata | `role_id` | `Role` JSON (§6.2) |
| 2 | ChannelMetadata | `channel_id` | `ChannelMetadata` JSON (`{"name": ...}`) |
| 3 | Grant (per member) | `grant_locator(community_id, member_xonly)` | `MemberGrant` JSON (§6.2) |
| 4 | Banlist | `banlist_locator(community_id)` | JSON array of banned pubkeys (hex) |
| 5 | RoleOrder | *(reserved, unbuilt)* | — |
| 6 | *(public-invite bundle — token-signed, not a 3308 edition; §7.2)* | — | — |
| 7 | *(owner attestation — embedded as event JSON, §6.4)* | — | — |
| 8 | InviteLinks (per creator) | `invite_links_locator(community_id, creator_xonly)` | JSON array of active link locators (hex) |
| 9 | *(public-invite revocation tombstone — token-signed, §7.2)* | — | — |
| 10 | GroupDissolved tombstone | `dissolved_locator(community_id)` | `{}` (chain-free, §9.3) |

Sub-kinds 0–10 are all spoken for; **never reuse** a number.

### 6.2 Roles and grants

```jsonc
// Role (vsk=1). role_id is a random 32-byte hex id (stable across renames; the entity coordinate).
{
  "role_id": "<64 hex>",
  "name": "Admin",
  "position": 1,            // lower = higher authority; owner is the implicit position 0
  "permissions": <u64>,     // bitfield, see below
  "scope": {"kind": "server"} | {"kind": "channel", "channel_id": "<hex>"},
  "color": <u32>            // cosmetic, 0 = theme default
}

// MemberGrant (vsk=3). An empty role_ids is a revoke.
{ "member": "<member pubkey hex>", "role_ids": ["<role_id>", ...] }
```

Permission bits (frozen positions — append a reserved bit, never renumber):

| Bit | Permission |
|---|---|
| `1 << 0` | `MANAGE_ROLES` |
| `1 << 1` | `MANAGE_CHANNELS` |
| `1 << 2` | `MANAGE_METADATA` |
| `1 << 3` | `KICK` |
| `1 << 4` | `BAN` |
| `1 << 5` | `MANAGE_MESSAGES` |
| `1 << 6` | `CREATE_INVITE` |
| `1 << 7` | *retired (was MANAGE_INVITES) — never reuse* |
| `1 << 8` | `VIEW_AUDIT_LOG` |
| `1 << 9` | `MENTION_EVERYONE` |
| `1 << 10`+ | reserved (MANAGE_EMOJI, PIN_MESSAGES, MANAGE_EVENTS) |

The MVP auto-creates one server-scope **Admin** role at `position 1` holding every management
bit (`ADMIN_ALL`). A role holding any bit in the `MANAGEMENT_MASK` (every management bit except
the purely-social `MENTION_EVERYONE`) marks its holder an "admin" (the crown).

**Authority rules** (every honest client recomputes these identically):

- A member's **effective permissions** = the union of their granted roles' bits.
- A member's **highest position** = the minimum `position` among their roles (the owner is the
  implicit position 0, supreme and unremovable).
- To act on a target requiring permission `P`: the actor must hold `P` **and strictly outrank**
  the target (the actor's highest position is a *lower* number). Equal cannot act on equal (an
  admin cannot ban/manage a peer admin). The **owner is supreme** (always authorized) and is
  **never a valid target**.

### 6.3 Edition structure and authority citation

An edition's **inner event** is kind 3308, signed by the actor's real identity key:

- tags:
  - `["vsk", <n>]` — the sub-kind.
  - `["eid", <entity_id hex>]` — the entity coordinate.
  - `["ev", <version decimal>]` — the per-entity monotonic version (starts at 1).
  - `["ep", <prev_edition_hash hex>]` — the previous edition's hash; **absent** on the genesis
    (v1) edition.
  - `["v", "1"]` — protocol version.
  - `["vac", <authorizing-entity hex>, <version>, <edition-hash hex>]` — the **authority
    citation**: the grant edition the actor claims authority under. **Absent when the owner
    acts** (supreme, cites nothing); required for a non-owner authority action. A verifier
    confirms it has synced that exact grant to ≥ the cited version before honoring the action,
    then resolves the actor's *current* rank against its refuse-downgrade-protected roster.
- `content` = the entity payload JSON.

All of `vsk`/`eid`/`ev`/`ep`/`vac` must appear **at most once**; a duplicate is rejected (it
would make the edition's canonical bytes ambiguous and diverge the chain).

### 6.4 Owner attestation (vsk=7 / embedded)

At creation the owner signs, with their **identity key**, an attestation binding the community
id. It is a normal Nostr event:

```jsonc
// kind 30078, content "", exactly one tag:
{ "kind": 30078, "content": "", "tags": [["vco", "<community_id hex>"]], ... }   // signed by the owner
```

Verification returns the proven owner = `event.pubkey` **iff** the Schnorr signature is valid
**and** the bound `vco` value equals the community id in hand. The proven owner is always
*derived* this way, never asserted as a bare field. An attestation for community X cannot be
replayed as Y (the unique id is inside the signed payload), and a forger can only ever attest
*themselves* (so they cannot frame an innocent npub). The attestation JSON travels in the
GroupRoot (vsk=0) content and in the invite bundle (§7).

### 6.5 Sealing and addressing a control edition

```
content   = NIP-44 v2 seal(server_root_key, inner.as_json())      (base64)
outer      = ephemeral-signed, kind 3308
             tags: ["z", control_pseudonym(server_root, community_id, epoch)], ["v", "1"]
```

`control_pseudonym = channel_pseudonym(ChannelKey(server_root_bytes), ChannelId(community_id), epoch)`
(the `channel-pseudonym` derivation with `IKM = server_root`, `id32 = community_id`). Only
members (who hold the server root) can compute it; outsiders see no stable group identifier.

The opener checks `v == "1"`, decrypts under the server root, parses the inner, verifies the
inner signature, computes `self_hash`, then folds (§6.7). A wrong server-root key fails the MAC —
which is also how **cross-community** replay is rejected. Cross-epoch replay within the *same*
community is intentionally NOT blocked at the envelope (the control plane must be re-wrappable
under a new epoch for re-anchoring); the version chain's refuse-downgrade is the defense.

### 6.6 GroupRoot / Channel metadata content

```jsonc
// CommunityMetadata (vsk=0)
{
  "name": "...",
  "relays": ["wss://...", ...],            // ≤ 5 distinct (MAX_COMMUNITY_RELAYS)
  "description": "..." | absent,
  "icon":   {CommunityImage} | absent,     // encrypted blob ref, §6.6.1
  "banner": {CommunityImage} | absent,
  "owner_attestation": "<event json>" | absent
}

// ChannelMetadata (vsk=2)
{ "name": "..." }
```

#### 6.6.1 CommunityImage (encrypted logo/banner)

A community logo or banner is encrypted with a fresh random AES-GCM key+nonce, uploaded to
Blossom (the same technique as message attachments), and referenced from inside the
server-root-sealed metadata, so possession of the server root (every member) gates the image.

```jsonc
{ "url": "<blossom url>", "key": "<aes-gcm key hex>", "nonce": "<hex>", "hash": "<sha256 plaintext hex>", "ext": "png" }
```

### 6.7 Version chain (per entity)

Each entity is a chain of editions. The **edition hash** is a domain-separated,
length-prefixed SHA-256:

```
EDITION_LABEL = "vector-community/v1/edition"
signing_bytes = u64_be(len(EDITION_LABEL)) || EDITION_LABEL
             || entity_id[32]
             || u64_be(version)
             || has_prev(1 byte: 1 or 0) || prev_hash[32 or 32 zero bytes]
             || u64_be(len(content)) || content
edition_hash  = SHA-256(signing_bytes)
```

The next edition's `ep` (prev_hash) must equal the head's `edition_hash`. The citation (`vac`) is
**not** part of `signing_bytes` (it is per-action metadata, covered only by the inner signature).

**Fold rules** — given the set of (signature-verified) editions for one entity and a held
floor `(version, hash)`:

- **Refuse-downgrade:** ignore any edition below the floor version.
- **Equal-version fork:** the winner is the **lower inner edition id** (a commitment hash over
  author+content+tags+time — NOT the author-settable `created_at`, so it can't be cheaply gamed).
  Deterministic for every client.
- **Anchor + walk:** the chain must be rooted (a genuine v1 genesis with no prev, or the held
  floor's exact hash, or `floor+1` linking to the floor hash). Walk upward only across a
  contiguous link (`version == prev+1` AND `prev_hash == predecessor.self_hash`).
- **Gap:** if the head is not chain-anchored (withheld prereqs, a forged middle link, a forked
  floor edition), set `gap = true`. A **tracking** client (holds a floor) MUST then fail closed
  (suspend the entity, refetch from the relay union). A **bootstrapping** joiner (`floor == 0`,
  whose genesis was re-anchored away) may accept the highest signed head **only after** verifying
  the author's current authority against the roster + owner attestation.

The fold is a pure function of the *set* (order-independent), so two clients that have seen the
same editions compute the identical head. Aggregating across relays heals single-relay gaps
(the union is contiguous even when no single relay holds the whole chain).

### 6.8 Two-layer authorization

1. **Bind + fold** (`fold_roster`) produces the validly-signed, anchored, current roster — the
   inner signature proves *who* authored each edition, and the `entity_id` must *bind* to its
   content (a role at `entity_id == role_id`, a grant at `grant_locator(community_id, member)`).
2. **Delegation check** (`authorize_delegation`) then filters by the delegation chain — *whether*
   each signer was allowed (rank + a chain to the owner). A self-signed or forged-delegation entry
   never becomes trusted authority.

The **banlist** (vsk=4) is the "anti-memberlist": its folded head is honored only if its signer
held `BAN`. The inbound path drops **every** event kind from a banned author (message, reaction,
edit, presence, …) so a banned member vanishes entirely.

A control fold processes at most **50,000** editions (bounds the verify work a hostile relay can
force).

---

## 7. Invites

Accepting an invite hands the recipient the actual **keys** (the server root, the granted
channels' keys, the relay set, the owner attestation), so the key *is* the membership. A received
invite is **parked** (nothing connects/joins) until the user accepts.

### 7.1 Targeted invite (kind 3304, gift-wrapped DM)

The bundle is the join material:

```jsonc
// CommunityInvite
{
  "community_id": "<hex>",
  "name": "...",
  "server_root_key": "<hex>",
  "server_root_epoch": <u64>,        // omitted when 0
  "relays": ["wss://...", ...],      // capped/deduped to ≤ 5 on read
  "channels": [
    { "id": "<hex>", "key": "<hex>", "epoch": <u64 (omit if 0)>, "name": "..." }, ...
  ],
  "owner_attestation": "<event json>" | absent,
  "icon": {CommunityImage} | absent  // so a parked invite can show the logo
}
```

Delivery: build an **unsigned NIP-59 rumor** of kind **3304** whose content is the bundle JSON,
then **gift-wrap it to the invitee's npub over NIP-17** (Vector's existing private-DM path). The
rumor author is irrelevant to trust — the owner attestation inside anchors authority.

On receipt, `parse_invite_rumor` returns the bundle only if `kind == 3304` and the JSON parses.
`accept_invite` reconstructs a member-view Community: it keeps the `owner_attestation` **only if**
it verifies against this community id (an impostor cannot smuggle a bogus owner claim or hand a
fake key for a real community — a mismatching bundle is refused). Caps: ≤ **256** channels
(reject), relays truncated to ≤ 5 (not rejected).

### 7.2 Public invite (link)

A shareable URL `https://vectorapp.io/invite#<fragment>` whose `#fragment` carries a random
**32-byte fetch-token**, never the keys. The token derives three sub-keys (§3.1):

- `public_invite_key(token)` — the NIP-44 decrypt key for the bundle.
- `public_invite_locator(token)` — the addressable `d`-tag locator.
- `public_invite_signer(token)` — a stable signing keypair.

**Bundle event** (posted on the community's relays):

```jsonc
// kind 30078, signed by Keys(public_invite_signer(token))
content = NIP-44 seal(public_invite_key(token), PublicInviteBundle JSON)
tags = [
  ["d", "<public_invite_locator(token) hex>"],
  ["vsk", "6"],
  ["v", "1"]
]
```

```jsonc
// PublicInviteBundle (plaintext inside the seal)
{
  "preview": { "name": "...", "description": "..."|absent, "icon": {CommunityImage}|absent },
  "join": { CommunityInvite },          // the same join material as §7.1
  "expires_at": <unix secs> | absent,
  "creator_npub": "<bech32>" | absent,  // attribution
  "label": "..." | absent               // metric bucket
}
```

A fetcher queries by the locator `d`-tag, then verifies: `v == "1"` → `event.pubkey ==
signer_pubkey(token)` (rejects an impostor squatting the locator) → Schnorr signature → `vsk ==
"6"` → decrypt under `public_invite_key(token)`. Expiry is reported, not enforced at parse
(a preview can still render an expired link); joins gate on `is_expired(now)`.

**Rotate** = re-post the bundle under the same coordinate. **Revoke** = publish a token-signed
**tombstone** (an empty-content replaceable event, same `(kind, pubkey, d)`, `vsk == "9"`); a
fetcher reading it returns an explicit "revoked" verdict. Relays honor replaceable-event
replacement more reliably than NIP-09 `a`-tag deletion, so the tombstone guarantees the browser
preview dies.

**Public vs. Private** mode is derived from the **InviteLinks** control entity (vsk=8): the
aggregate (union across creators who hold `CREATE_INVITE`) of active link locators. Non-empty =
Public; empty = Private. Switching from Public to Private is, under the hood, a relocation
(server-root rekey) so the memorized token can't keep being used.

**URL fragment encoding** (v2, the common form): base64url-no-pad of
`[version=2][flags][relays?][token:32]`. `flags` bit `0b1` means "the stock trusted relay set"
(zero relay bytes). Otherwise a 1-byte count then, per relay, a dictionary id (1–254), a
`wss://`-implied literal (id 0, length-prefixed host), or a verbatim literal (id 255). A legacy
v1 fragment is base64url-of-JSON `{"v":1,"relays":[...],"t":"<token hex>"}` (first decoded byte
`{` discriminates v1 from v2). The token never reaches a web server (it rides the `#fragment`)
nor the relays (they hold only the locked bundle).

---

## 8. Cross-device sync (kind 30078)

Joins leave no reconstructible network trace (a DM bundle reaching device B doesn't mean device A
accepted; a URL join is invisible), so memberships sync explicitly through self-encrypted,
replaceable per-user lists.

### 8.1 Community List

- **kind 30078**, addressed to yourself, `["d", "vector/communities"]`.
- content = **NIP-44 self-encrypted** JSON of `CommunityList`:

```jsonc
{
  "entries": [
    {
      "community_id": "<hex>",
      "seed": { CommunityInvite },       // stable join bundle (earliest root) — backfill anchor
      "current": { CommunityInvite }|absent,  // freshest snapshot (latest root + keys + name)
      "added_at": <ms>
    }, ...
  ],
  "tombstones": [ { "community_id": "<hex>", "removed_at": <ms> }, ... ]
}
```

ADD on join, REMOVE (tombstone) on self-removal. Merge resolves per-community by latest action
(`added_at` vs `removed_at`); the **seed** keeps the lowest epoch (widest backfill), the
**current** keeps the highest epoch (instant-latest rehydration), with a lexicographic canonical
tiebreak on an epoch tie. Icons are stripped from list blobs (re-folded from metadata). A local
`community_list_published_at` guard ignores any relay copy older than the last local mutation.

### 8.2 Invite List

The same kind-30078 self-sync pattern syncs a creator's active public-invite tokens across their
own devices (so rotate/revoke is consistent everywhere).

---

## 9. Append-plane sub-types in detail

### 9.1 Presence (kind 3306)

Inner content is `"join"`, `"leave"`, or an attributed-join JSON `{"by":"<npub>","l":"<label>"}`.
The inner author is the announcing member (real-npub signed, so no one can forge another's
presence). A best-practice, **not enforced** — a silent join omits it. A `leave` whose inner
author is the local npub is a self-removal teardown (propagates to all your devices); a stale
leave predating the current join renders as history only. In an attributed join, `by` must parse
as a real pubkey (else dropped) and `l` is bounded free text (≤ 48 chars).

### 9.2 WebXDC peer signal (kind 3310)

The Community-transport twin of the NIP-17 peer-advertisement DM, for Mini Apps realtime
(Iroh gossip). Inner JSON content:

```jsonc
{ "op": "ad",   "topic": "<hex>", "addr": "<iroh node addr>" }   // advertise
{ "op": "left", "topic": "<hex>" }                                // stopped playing
```

Persisted on receipt (a 30078 row keyed by topic) so a member who reopens mid-session
rediscovers active players. Own-device echoes are dropped. Author-controlled timestamps are
clamped.

### 9.3 Cooperative delete / moderation-hide (kind 3305)

Inner content empty; the `["e", <target_id>, "", "reply"]` tag names the target (a message or a
reaction id). Honored as:

- **Self-delete:** the target's own author removes it.
- **Reaction-revoke:** for a reaction target, the deleter must be the reactor.
- **Moderation-hide:** the deleter must (a) carry an authority citation (`vac`) for a grant the
  receiver has synced to ≥ the cited version (or be the owner, who cites nothing) **and** (b) hold
  `MANAGE_MESSAGES` and strictly outrank the target's author. The owner is never a valid target.

This is *cooperative* soft removal (a hostile client can keep displaying the blob); hard removal
is a rekey (§5). A dissolved community accepts only self-deletes.

### 9.4 Cooperative kick (kind 3309)

Inner content = the target member's pubkey **hex**; carries the kicker's `vac` citation. Honored
only when the kicker cites a synced grant **and** holds `KICK` **and** strictly outranks the
target in the floor-protected roster. The **target** self-removes on receipt (drops the keys,
wipes local chat data — like a leave); peers drop the target from their observed member list. A
kick older than this account's join is ignored (re-accepting an invite overrides a stale replay).
A target that ignores a kick (malicious) is escalated to a BAN (the cryptographic rekey).

### 9.5 Typing (kind 3311)

Inner content `"typing"`; sealed under the channel epoch key like presence. Ephemeral —
**never persisted or folded, never recorded in the dedup ledger**. Receivers show the typer for
a short window (~30 s) then expire it.

### 9.6 Group dissolution (vsk=10 tombstone)

A permanent, irreversible owner action. The owner signs a vsk=10 edition (kind 3308) at
`dissolved_locator(community_id)` with `version = 1`, **no prev_hash**, content `{}` — it is
**chain-free** (exempt from the version discipline; presence of ≥1 valid owner-signed edition
*is* the state). It is sealed and addressed two ways: at the current `control_pseudonym` (fast
path) **and** at the rotation-stable `dissolved_pseudonym(community_id)` under the
`dissolved_envelope_key(community_id)` (so a post-rotation joiner who only holds a later root can
still discover it). A client treats the community as dissolved **only if** the proven owner is
among the tombstone signers. Once sealed: the control fold stops advancing and the inbound path
drops every subsequent event of any kind.

---

## 10. Publishing and querying — procedures

### 10.1 Relays

A Community carries a relay set capped at **5 distinct** relays (`MAX_COMMUNITY_RELAYS`),
deduped then truncated on every construction/read boundary. All of a Community's events publish
to and fetch from this union. Never trust a single relay — take the union and the version chain
heals single-relay gaps.

- **Single-attempt publish** (`publish`): OK if ≥1 relay ACKs. Used for latency-sensitive chat
  messages.
- **Durable publish** (`publish_durable`): retry each relay independently up to **30** times,
  re-sending only relays that have not yet ACKed. Used for security-critical events — rekeys,
  bans, control editions, deletes, invite-registry updates, and presence-joins that must land
  reliably.

### 10.2 Sending a channel message

1. Build the inner event (real-key signed; kind = sub-kind; `channel`/`epoch`/`ms` tags; reply/
   emoji/imeta as needed). Sign with local keys or via the active `NostrSigner` (NIP-46 bunker).
2. Seal it under the channel key with a fresh ephemeral key → outer (kind = sub-kind; `z` =
   `channel_pseudonym(channel_key, channel_id, epoch)`; `v == "1"`).
3. Publish the outer to the community relays (durable for control/moderation events, single for
   chat). Optionally retain the ephemeral key for later NIP-09 self-deletion.

### 10.3 Fetching channel history

Query the community relays with:

```
kinds  = [3300, 3301, 3302, 3305, 3306, 3309, 3310]   // append plane (messages + reactions + edits +
                                                       //   delete + presence + kick + webxdc)
"#z"   = [ channel_pseudonym(key_e, channel_id, e) for each retained (e, key_e) ]   // OR-set across epochs
until  = <oldest-known created_at secs>   // page older history; omit for the latest page
since  = <newest-held wire time secs>     // latest-page only, to skip re-pulling held events
limit  = <page size>                       // newest-first
```

Process the returned outer events: for each, select the decryption key by its `z` pseudonym
across held epochs (`open_message_multi`), open, verify the binding triad, and silently drop any
that fail (wrong key, splice, forged signature, bad version — a non-member's or spliced event
never surfaces). Then:

- **Dedup on the inner (message) id**, never the outer wrapper id — one inner message can ride
  multiple outer wrappers (re-broadcast, multi-relay copies, replays).
- **Order** deterministically by the inner authenticated `ms` timestamp, ties broken by inner id.
- Process **messages (3300) before reactions/edits (3301/3302)** in a batch so a control event
  finds its target already ingested.

### 10.4 Fetching the control plane / roster

Query the relays for `kinds = [3308]`, `"#z" = [control_pseudonym(server_root, community_id,
epoch)]`. Open each under the server-root key, verify the inner signature, compute `self_hash`,
then `fold_roster` (group per `eid`, version-fold each chain from its persisted floor, bind
`eid`↔content, two-layer authorize). Apply GroupRoot/ChannelMetadata only if the signer held
`MANAGE_METADATA`/`MANAGE_CHANNELS`; the banlist only if its signer held `BAN`; honor a
dissolution only if the proven owner signed it.

Also probe the rotation-stable dissolution coordinate (`dissolved_pseudonym(community_id)`) so a
dead community is discovered regardless of epoch.

### 10.5 Realtime subscription

Subscribe to the community relays with one filter:

```
kinds = [3300, 3301, 3302, 3305, 3306, 3309, 3311, 3310, 3308, 3303]
"#z"  = [ every channel pseudonym (all held epochs) ]
        ∪ [ every control_pseudonym ]   (and rekey/base-rekey/dissolution addresses)
limit = 0   // live tail only
```

Route an arriving event by its `z` pseudonym: a 3308 (control) or 3303 (rekey) triggers a control
refresh; anything else opens against the channel mapped to that pseudonym and is processed,
persisted, and dispatched. Typing (3311) is realtime-only and never persisted.

---

## 11. What is and isn't hidden

Relays and non-members see only NIP-44 ciphertext addressed to rotating `z` pseudonyms, signed by
single-use ephemeral keys. They cannot read message content, author identities, community/channel
names, the member list, roles, or bans. Pseudonyms rotate per epoch, resisting (not guaranteeing
against a global observer) correlation of a room's traffic. **Not** hidden: that *some* encrypted
traffic exists, its rough volume/timing, and your IP to the relays you use (absent Tor/VPN).

---

## Appendix A — frozen golden vectors (regression pins)

These exact outputs anchor the wire format (independent RFC-5869 HKDF / SHA-256
implementations). A drift means the format changed.

```
channel_pseudonym(key=0x00..1f, id=0xff,0xfe,.., epoch 0)
  = d55b9f5fad668887d41d46b7c08ba63725a39d7c86b602c7c36e2f2e0eff8c40
channel_pseudonym(.., epoch 1)
  = 050079d9899c85bebf5c73fd777cdd812132d262e3ceec83c847a056dea41293
channel_pseudonym(.., epoch 0x0102030405060708)   // proves u64 big-endian
  = cec398094d17688cd127bc609d34fa067331427400b023d0c70ff77fafe17e0b

grant_locator(community=0x11*32, member=0x22*32)
  = c18d4d5955ecdd258f44240019a493a01fc01d51b5f0b8f7679ae424f8d5bfcc
invite_links_locator(community=0x11*32, creator=0x22*32)
  = cf42937a815ec561da6b4ca5ddd0c361634b0d9744693b744d4f5b34ec209ec2

rekey_pseudonym(server_root=0x07*32, channel=0xff,0xfe,.., epoch 1)
  = 3a848655f79a586510e1113131f078aa1ce0ff8dcb74374507e6af07ff49fd24
base_rekey_pseudonym(prior_root=0x07*32, community=0x09*32, epoch 1)
  = 23ced8fd6cad30a21ded43c96bd040311cf20bcfff935453dc0985b41ff660be
recipient_pseudonym(secret=0x07*32, Channel(0xff,0xfe,..), epoch 3)
  = 971f69d6a948c79704f8077188cded86bd35c82960e88043ebb2c2c3d60a3b71
recipient_pseudonym(secret=0x07*32, ServerRoot, epoch 3)
  = e50e5d803fd2edc310be8cd7354586d12fcb8e3f30162553be53da1a34a17c46

public_invite_key(token=0x05*32)
  = 7f02a8a832a1744adf286676038446dc94762c2c8332650c9ad62a0c870e0751
public_invite_locator(token=0x05*32)
  = 33c098d6e4cddc2b8ee98ab6b5182186794c35f5b71391130a49ae3d88588c2c
public_invite_signer(token=0x05*32)
  = 9154a3a7e4a03e94eaad2f76efeebd43e25ee9df4fbca12454edcee0ef666e8d

edition_hash(entity=0x11*32, version=1, prev=None, content="hello")
  = 2daf42e65a6bc259a4c99fac6df754a5d3d92310607cf13e2a1e8c94d42f6303
```
