# Concord Extensions

Conventions the **Armada** client implements on top of the
[Concord protocol](https://github.com/concord-protocol/concord) (CORD-01
through CORD-07) that are **not** part of the official Concord specification —
the CORD analog of a project's `NIP.md`. They build on the base protocol's
sealed planes and interoperate with any Concord client that chooses to adopt
them; a client unaware of an extension simply ignores its events.

Nothing here is a ratified CORD. If an extension proves broadly useful it may
be proposed upstream later; until then it is an Armada implementation detail
documented for interoperability.

---

## Private Zaps

Lightning zaps on messages in a Channel, with **no public Nostr artifact**. A
member pays a message's author over Lightning and posts the proof into the
Channel's own Chat Plane; every member verifies the payment locally, and nobody
else — not the relays, not a zap indexer, not the recipient's wallet provider —
learns that a community, a message, or a zapper exists. It works with today's
Lightning address providers exactly as they are: the payment they see is
indistinguishable from any ordinary, Nostr-free Lightning payment.

### 1. Why not NIP-57 receipts

[NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md) attests a zap
with a public kind `9735` receipt, signed and published *by the recipient's
LNURL provider*. That shape is wrong for a sealed plane three times over: the
receipt is a public event naming the recipient, the amount, the time, and the
zapped event id; the provider chooses where it lands and must be trusted to
publish it; and no provider can seal a receipt into a plane it cannot see.
Asking providers to behave differently would make private zaps work only against
cooperating wallets — quietly reintroducing a trusted server.

Armada moves the attestation to the only party who is already inside the room:
the **payer**. A Lightning payment carries its own cryptographic proof — the
**preimage**, revealed to the payer on settlement, whose SHA-256 is the
invoice's `payment_hash`. The payer posts invoice + preimage as a sealed Chat
Plane event, and every member checks the math themselves. No third party
publishes anything.

### 2. Flow

1. **Resolve.** The payer reads the recipient's Lightning address
   (`lud16`/`lud06`) from their public kind `0` metadata — the one public
   touchpoint, inherent to Lightning addresses themselves.
2. **Fetch an invoice** via plain
   [LUD-06](https://github.com/lnurl/luds/blob/luds/06.md)/[LUD-16](https://github.com/lnurl/luds/blob/luds/16.md)
   LNURL-pay. The client MUST NOT include a NIP-57 `nostr` parameter in the
   callback: its presence is what causes a provider to mint a public kind `9735`
   receipt. Without it, the provider sees an ordinary Lightning payment and
   produces no Nostr event anywhere. The client MUST NOT include the LNURL
   `comment` parameter either — the zap comment belongs to the sealed
   announcement alone (§5), not to the recipient's wallet provider.
3. **Pay** with a method that returns the preimage — NIP-47 `pay_invoice` and
   WebLN `sendPayment` both do. A payment path that never reveals the preimage
   to the client (scanning the invoice with an external wallet) cannot produce a
   verifiable zap.
4. **Announce.** The payer publishes a Zap event (§3) to the Channel's Chat
   Plane, sealed to their real identity like any message.

### 3. The Zap event

Armada carries the Zap as a kind `9735` rumor on the Chat Plane — the NIP-57
receipt shape reused *inside* the sealed plane, with one addition: the
`preimage` tag that replaces the provider's signature as the proof. Note the
role reversal from NIP-57: there the receipt's author is the *provider*; here
the rumor's author (the seal's signer) is the *payer*. Because it never leaves
the sealed plane, reusing kind `9735` does not collide with public NIP-57
receipts.

```jsonc
{
  "kind": 9735,
  "pubkey": "<payer>",
  "content": "great post ⚡",                      // optional comment, "" when none
  "tags": [
    ["channel", "<channel_id>"],                   // binding tags, required on every
    ["epoch", "0"],                                //   chat rumor (CORD-03 §3)
    ["ms", "417"],
    ["e", "<zapped message rumor id>"],
    ["p", "<recipient real pubkey>"],
    ["k", "9"],                                    // kind of the zapped rumor
    ["amount", "21000"],                           // millisats, decimal string
    ["bolt11", "<the paid invoice>"],
    ["preimage", "<64-char lowercase hex>"]
  ],
  "created_at": 1686840350
}
```

`amount` follows the NIP-57 convention (millisats). The invoice MUST carry an
explicit amount; amountless invoices are not zappable (there would be nothing
for verifiers to check the tag against).

### 4. Verification

A receiver MUST verify, and MUST NOT count a Zap toward a message's totals
unless all of it holds:

- **Payment**: `sha256(preimage) == payment_hash` decoded from `bolt11`.
- **Amount**: the `amount` tag equals the invoice's encoded amount, in millisats.
- **Binding**: `channel` and `epoch` strict-equal the Channel and epoch whose
  key decrypted the wrap (CORD-03 §3), like every chat rumor.
- **Uniqueness**: the invoice's `payment_hash` has not already been counted in
  this Channel. A published Zap reveals its preimage to every member, so
  without this rule anyone could replay someone else's proof — as their own
  zap, or on another message — and one payment would count many times. When
  several verified Zaps carry the same `payment_hash`, exactly one enters
  totals, chosen deterministically (lowest `ms`, then lowest rumor id) so all
  members agree.

The `e`-referenced message MAY be one the receiver has not yet seen — a Zap is
held and folded when its target arrives, exactly as a reaction to an unseen
message is. A client MAY render an event that fails the payment or amount check
as an unverified claim, but it never enters totals.

**What the proof does and does not bind.** Invoice + preimage prove that *this
invoice was settled for this amount* — value verifiably moved, exactly once
per Channel (the uniqueness rule). They do not cryptographically prove the
invoice credited the `p`-tagged recipient, or that the seal's signer was the
one who paid: a custodial provider's invoice does not name its account holder,
any LNURL endpoint will happily issue an invoice, and a preimage learned
out-of-band could be announced in a Channel that never saw the original. Those
links are the payer's word, carried by their real signature on the seal — the
same authorship trust every message in the plane already rests on — backed by
economics: fabricating a Zap means actually paying the claimed sats to
someone, so within a Channel a forger can misattribute value but never mint
it. Totals stay honest in aggregate the way proof-of-burn is honest.

### 5. Privacy

The entire zap — who zapped, what was zapped, in which community, the comment —
exists only inside the sealed plane. What leaks, and to whom:

- **The provider** (recipient's Lightning wallet) learns that *someone* paid an
  invoice of some amount at some time — exactly what it learns from any
  Lightning payment, Nostr or not. It sees no Nostr key, no event id, no
  community. The LNURL fetch does expose the payer's IP to the provider, as
  every LNURL payment does; a client MAY route it through a proxy.
- **Relays and the public network** see nothing: no kind `9734` is ever created,
  no kind `9735` is ever published, and the sealed Zap rumor is indistinguishable
  from any other stream traffic (CORD-01).
- **Timing** is the residual channel: a provider that also observes the
  Community's relays could correlate an invoice's settlement time with a wrap's
  `created_at`. This is the same order of leak as message timing itself and
  carries the same answer — it identifies *that* traffic exists, not what or
  whose.

### 6. Wallet support

Because the proof comes from the payer's wallet, the wallet MUST surface the
preimage — via the `pay_invoice` reply, or a follow-up `lookup_invoice`. Most
NWC wallets do (Alby Hub, Coinos, lnbits); some (e.g. cashu.me) never expose it,
and there a private zap cannot be recorded even though the payment settles. A
client SHOULD tell the user the payment went through but no tally could be
posted, rather than reporting a failure.

### Appendix: the rejected alternative

A provider-attested variant was considered: sign a NIP-57 kind `9734` request
with an **ephemeral** key (so the provider cannot identify the payer) and list
the Community's own relays, letting the provider publish its ordinary public
`9735` there for members to verify against the provider's `nostrPubkey`. It works
with existing providers and yields a stronger recipient binding — but the
receipt is still a public event carrying the recipient, the amount, the time,
and an (opaque) event id, published to relays that advertise themselves as the
community's home. A sealed plane should not emit a beacon per zap. The preimage
proof keeps verification local and the network silent; the weaker recipient
binding is priced in §4. Should a future need arise, an attested mode can be
added additively (a marker tag on the same kind) without disturbing this
convention.

### Implementation

In the Armada client:

- `client/src/lib/zaps.ts` — `verifyZapRumor` (the §4 proof check), tag builder,
  and bolt11 decoding.
- `client/src/hooks/useZap.ts` + `client/src/lib/lnurl.ts` — the §2 flow
  (LNURL-pay without the `nostr` or `comment` parameters, pay, obtain
  preimage).
- `client/src/concord-v2/lib/chat.ts` — folds verified Zaps into per-message
  tallies, one per `payment_hash` (§4 uniqueness); unverified ones never enter
  totals.
- `client/src/concord-v2/hooks/useTransport2.ts` — seals and publishes the Zap
  rumor (`sendZap`).

---

## On-Chain Zaps

A courtesy extension: Bitcoin on-chain zaps sealed into the Chat Plane so the
Nostr attribution stays private. The transaction is on a public ledger by
nature; this extension just keeps the *who-zapped-what-in-which-channel* off
public relays.

Every Nostr pubkey is a valid Bitcoin Taproot address (both are secp256k1
x-only Schnorr keys), so this works for any user without Lightning setup.

### Event

Kind `8333` rumor on the Chat Plane, sealed like any message:

```jsonc
{
  "kind": 8333,
  "content": "optional comment",
  "tags": [
    ["channel", "<channel_id>"],          // CORD-03 binding
    ["epoch", "0"],
    ["ms", "417"],
    ["i", "bitcoin:tx:<txid>"],
    ["e", "<zapped message rumor id>"],
    ["p", "<recipient pubkey>"],
    ["k", "9"],
    ["amount", "5000"]                    // sats (not millisats)
  ]
}
```

### Verification

- `i` tag is `bitcoin:tx:<64-char hex txid>`.
- `amount` is a positive integer.
- Channel/epoch binding per CORD-03.
- One txid counts once per Channel (deterministic winner on collision).

No in-rumor cryptographic proof — the transaction itself is the proof, and
any member can look it up on-chain. Integrity rests on the payer's seal
signature, same as every chat message.

### Privacy

- Bitcoin network sees the tx (inherent to L1).
- Nostr network sees nothing — no public kind 8333.
- Silent-payment sends (`sp1…`) publish no event at all (naming the txid would
  re-link the recipient).

### Signer support

nsec signs locally; NIP-07 extension via `signPsbt`; NIP-46 bunker via
`sign_psbt` RPC. Unsupported signers fall back to a BIP-21 QR (the sats still
arrive, but no tally is posted).

---

## Polls

[NIP-88](https://github.com/nostr-protocol/nips/blob/master/88.md) polls,
carried inside the sealed Chat Plane so who-asked, who-voted, and the running
tally never leave the Community. A poll is an ordinary Channel message that
happens to declare options; a vote is an `e`-referencing side event folded into
the poll's tally, exactly like a reaction or a Zap. A client unaware of polls
renders the poll as a plain message (its question is the `content`) and ignores
the votes.

### Events

A poll is a kind `1068` rumor on the Chat Plane, sealed like any message. Its
question is the `content`; each option is an `["option", id, label]` tag:

```jsonc
{
  "kind": 1068,
  "content": "Lunch?",
  "tags": [
    ["channel", "<channel_id>"],      // CORD-03 binding, like every chat rumor
    ["epoch", "0"],
    ["ms", "417"],
    ["option", "a1", "Tacos"],
    ["option", "b2", "Sushi"],
    ["polltype", "singlechoice"],     // or "multiplechoice"
    ["endsAt", "1735689600"],         // OPTIONAL: unix seconds; omit for no end
    ["alt", "Poll: Lunch?"]
  ]
}
```

A vote is a kind `1018` rumor `e`-tagging the poll, naming the chosen option
ids in `["response", id]` tags — a side event like a reaction, never shown as
its own row:

```jsonc
{
  "kind": 1018,
  "content": "",
  "tags": [
    ["channel", "<channel_id>"],
    ["epoch", "0"],
    ["ms", "912"],
    ["e", "<poll rumor id>"],
    ["response", "a1"]                // one per chosen option
  ]
}
```

Note what NIP-88 relay polls carry that a sealed poll drops: the `["relay", …]`
tag that tells voters where to publish. There is no relay to route votes to
inside a Community — votes ride the same sealed stream as the poll — so the tag
is meaningless here and omitted.

### Tally

Every member folds the same result from the votes it holds:

- **Latest per voter wins.** A member's newest kind `1018` (by the CORD-03 `ms`
  ordering time) supersedes their earlier ones, so re-voting just changes a
  vote rather than adding one.
- **Options are validated.** A `response` naming an id the poll never declared
  is dropped.
- **`endsAt` closes voting.** A vote cast after `endsAt` is ignored, so the
  tally a client shows after the deadline is stable.
- **Per-voter percentages.** Each option's share is `voters-for-it / distinct
  voters`; a multiple-choice poll's shares can therefore sum past 100%.

Like a reaction or Zap to an unseen message, a vote whose poll hasn't decoded
yet is simply held keyed by its `e` target and folded once the poll arrives.

### Privacy

The poll, its options, and every vote exist only inside the sealed plane. Relays
store the ciphertext and learn nothing; no public kind `1068`/`1018` is ever
emitted. Authorship rests on each rumor's seal signature, the same trust every
chat message already carries — a vote is authenticated as its signer's, and the
`ms`/binding tags are checked exactly as on any chat rumor (CORD-03 §3).

### Implementation

In the Armada client:

- `client/src/lib/polls.ts` — the transport-agnostic core shared with the NIP-29
  relay path: `parsePoll`, `tallyPollVotes` (the fold rules above), `buildPollTags`,
  and the `KIND_POLL`/`KIND_POLL_VOTE` constants.
- `client/src/components/chat/PollView.tsx` — the presentational card (results
  bars / votable options), fed a tally + a vote callback by either transport.
- `client/src/concord-v2/lib/chat.ts` — folds votes into `pollVotes` per poll.
- `client/src/concord-v2/hooks/useTransport2.ts` — `sendPoll` (seals the kind
  1068), `sendPollVote` (seals the kind 1018), and `pollFor` (the per-poll tally).

---

## Calendar Events

[NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md) calendar
events, carried inside the sealed Chat Plane so a Community's schedule — its
events, and who's attending — never leaves it. An event is a sealed rumor
surfaced in the channel's events bar (not the message timeline); an RSVP is an
`e`-referencing side event folded into the event's attendee tally, like a poll
vote. A client unaware of the extension ignores both.

### Events

A date-based (kind `31922`, all-day) or time-based (kind `31923`) event, sealed
like any message:

```jsonc
{
  "kind": 31923,
  "content": "Monthly sync — agenda in the thread.",
  "tags": [
    ["channel", "<channel_id>"],      // CORD-03 binding, like every chat rumor
    ["epoch", "0"],
    ["ms", "417"],
    ["d", "<random id>"],             // NIP-52 identifier (author-scoped)
    ["title", "Community call"],
    ["start", "1735689600"],          // 31923: unix seconds; 31922: YYYY-MM-DD
    ["end", "1735693200"],            // optional, exclusive
    ["start_tzid", "America/New_York"],
    ["location", "Voice channel"]     // + optional summary/image/t/r/p
  ]
}
```

An RSVP is a kind `31925` rumor `e`-tagging the event, with a `status` of
`accepted`/`declined`/`tentative`:

```jsonc
{
  "kind": 31925,
  "content": "",
  "tags": [
    ["channel", "<channel_id>"],
    ["epoch", "0"],
    ["ms", "912"],
    ["e", "<event rumor id>"],
    ["status", "accepted"]
  ]
}
```

### Addressing — rumor ids, not `a`-coordinates

NIP-52 events are addressable (`kind:pubkey:d`) and RSVPs point at that
coordinate. A sealed rumor is **unsigned and identified by its rumor id**, with
no relay-side replaceable dedup, so the coordinate model does not carry over:

- An RSVP references its event by the event's **rumor id** via an `e` tag (the
  same mechanism a poll vote uses), not an `a` coordinate.
- "Newest per author+`d`" replacement moves from the relay to the fold: a client
  keeps the newest event per `(author, d)` and the newest RSVP per pubkey (by
  `ms`), so every member computes the same events and attendee lists.
- Deletion is a kind-5 naming the event's rumor id (author, or a moderator with
  MANAGE_MESSAGES) — the same authorization as a message delete.

### Privacy

Events and RSVPs are sealed under the Channel key at the Channel's stream
address; relays store only ciphertext and no public kind `31922`/`31923`/`31925`
is ever emitted. Authorship — who scheduled, who's coming — rests on each
rumor's seal signature, and the `channel`/`epoch` binding is checked as on any
chat rumor (CORD-03 §3).

### Implementation

In the Armada client:

- `client/src/lib/calendar.ts` — the transport-agnostic core shared with the
  NIP-29 relay path: `parseCalendarEvents`, `buildCalendarTags`, `tallyRsvps`,
  and the `CalendarTransport` contract the shared events UI renders through.
- `client/src/concord-v2/lib/chat.ts` — folds events (kept out of the timeline)
  and buckets RSVPs per event rumor id.
- `client/src/concord-v2/hooks/useTransport2.ts` — seals events (`save`), RSVPs
  (`setRsvp`), and deletes, and exposes the per-event tally (`rsvpsFor`).

---

## In-Call Reactions and Raise-Hand

Zoom/Signal-style raise-hand and emoji reactions during a Concord voice/video
call (CORD-07), carried as **additive tags on the call's own presence rumor**.
They therefore inherit its blindness — relays and the blind AV broker never see
them (CORD-07 §4) — and spend no new kind: a client that doesn't understand the
tags ignores them and round-trips them untouched (CORD-02 §6), so the call is
unaffected.

Both ride the ephemeral kind `23313` voice-presence rumor (CORD-07 §4): a
`joined`/`left` sealed under the Channel key at the Channel's own stream
address, published on join and every 30 s, expiring after 90 s of silence.

### Raise-hand

Sticky per-member state, expressed as an additive `["hand", "1"]` tag on the
member's `joined` presence rumor. Because it rides presence, it is carried on
every heartbeat and healed by the same staleness window: a late joiner learns
who has a hand up within one heartbeat, and a missed "lower" ages out. The tag's
absence (or a `left`) means the hand is down. Lowering republishes `joined`
without the tag immediately — off the 30 s cycle — so others see it promptly.

```jsonc
{
  "kind": 23313,
  "content": "joined",
  "tags": [
    ["channel", "<channel_id>"],
    ["epoch", "0"],
    ["ms", "417"],
    ["identity", "<broker-assigned SFU identity>"],   // CORD-07 §4
    ["broker", "https://broker.example"],             // CORD-07 §4
    ["hand", "1"]                                      // ← raised hand
  ]
}
```

The set of raised hands folds directly off the live presence view.

### Reactions

Transient, fire-and-forget emoji, expressed as an additive
`["react", "<emoji>", "<nonce>"]` tag on an **off-cycle** `joined` presence
rumor (which doubles as a heartbeat, so it also carries the member's current
`hand` state). The `nonce` is a sender-chosen random string; a receiver fires
each emoji exactly once per unseen nonce and never folds it into state, letting
it float and fade (~4 s) on its own. A member's own reactions echo back through
the same subscription and animate identically — no separate optimistic path.

```jsonc
{
  "kind": 23313,
  "content": "joined",
  "tags": [
    ["channel", "<channel_id>"],
    ["epoch", "0"],
    ["ms", "417"],
    ["identity", "<broker-assigned SFU identity>"],
    ["broker", "https://broker.example"],
    ["react", "🎉", "<nonce>"]                          // ← one emoji reaction
  ]
}
```

### Validation

- **Hand** is read only on a `joined`; any value other than `"1"` — or the tag's
  absence, or a `left` — is hand-down.
- **Reaction** requires a non-empty `emoji` of at most 64 UTF-8 bytes (ample for
  any single emoji, incl. ZWJ sequences, or a short shortcode) and a non-empty
  `nonce` of at most 128 chars. Untrusted member input is bounded and *rejected*
  rather than truncated, so two clients never disagree on what floated. Each
  nonce fires once; replays and already-expired stamps are dropped.
- **Binding**: `channel`/`epoch` strict-equal the Channel and epoch whose key
  decrypted the wrap (CORD-03 §3), like every chat rumor.

The author of both is the presence rumor's seal signer — the member's real key —
so a hand-raise or a reaction is authenticated exactly as their presence is.

### Privacy

Both are sealed under the Channel key inside the ephemeral gift wrap at the
Channel's own stream address, identical to all voice presence (CORD-07 §4).
Relays never store them (ephemeral) and cannot read them; neither can the blind
AV broker. Nothing about a hand-raise or a reaction reaches the public network.

### Scope

Concord-only: it relies on the encrypted presence channel to stay blind. NIP-29
relay-hosted calls have no such channel and carry no hand/reaction signal.

### Implementation

In the Armada client:

- `client/src/concord-v2/lib/voice.ts` — the `hand` field on
  `VoicePresenceEntry`, `presenceTags`/`parsePresence` (raise-hand), and
  `reactionTag`/`parseReaction` (the `VoiceReactionEntry` shape + validation).
- `client/src/concord-v2/hooks/useVoice2.ts` — `useVoiceHeartbeat2` carries the
  hand state and emits reactions (`sendReaction`); `useVoiceReactions2`
  subscribes and fires each once per nonce (decaying ~4 s).
- `client/src/contexts/CallSignalsContext.ts` — exposes the raise-hand toggle,
  the reaction sender, and the live reactions to the in-call UI.
- `client/src/components/chat/CallControls.tsx` +
  `client/src/components/chat/CallStage.tsx` — the raise-hand + emoji buttons and
  the per-tile hand badge / floating-emoji rendering.


## Role Display

One optional field Armada adds to the CORD-04 Role wire object, read
tolerantly and written only when set — a client that drops it loses a
cosmetic, never authority:

- `display: true` — hoist: the member list groups holders under the role's own
  name (position order; a member files under their highest hoisted role). The
  owner may self-grant a role to file under its section — the fold admits any
  owner-authored Grant, including one targeting the owner, and it is purely
  cosmetic (the owner's authority is position 0 with or without roles); a
  roleless owner sits in the synthetic Admins group.

`color` is baseline CORD-04, not an extension; Armada renders it as the role's
badge/section tint (low 24 bits, `#rrggbb`).

Implementation: `client/src/concord-v2/lib/roles.ts` (`Role.display`, written
only when true), `client/src/components/chat/MemberList.tsx` (the hoisted
sections).

---

## Channel Ordering

CORD-03 gives a Channel no ordering field, so sidebar order is the client's to
decide, and plain alphabetical ignores what a community wants (#announcements
above #random). A Channel MAY carry:

```jsonc
{ "name": "announcements", "private": false,
  "custom": { "armada.order": { "position": 0 } } }
```

Position sits on the entity rather than in one ordered list, mirroring CORD-04
Roles: two moderators reordering at once then collide on individual channels
instead of clobbering the whole arrangement, and each move is an ordinary
version-chained Channel edition requiring `MANAGE_CHANNELS`.

Order is **position, then name**. An unpositioned channel sorts after every
positioned one, so a community that never orders anything keeps alphabetical
behavior and a newly created channel lands at the end. A neighbour swap
republishes exactly the two channels that moved; the FIRST reorder in a
never-ordered community necessarily stamps them all, since an arrangement
isn't expressible until every channel carries a position.

Position is advisory display data: a client that ignores it loses the
arrangement, never a channel.

Implementation: `client/src/concord-v2/lib/channelOrder.ts`,
`useCommunityManagement2.moveChannel` (the settings buttons) and
`.reorderChannel` (an absolute slot, what a drag lands on), `channelsView`
(the single sort site).

---

## Channel Categories

Sidebar grouping for Channels. CORD-03 has no notion of it, so a Channel MAY
carry a display-only member in its metadata:

```jsonc
{
  "name": "standup",
  "private": false,
  "custom": {
    "armada.category": { "name": "Team" }
  }
}
```

`name` is bounded by the same 64 bytes as every other name (CORD-02 §6); a
blank, over-long or malformed value reads as *uncategorized* rather than
invalidating the Channel. Editors MUST round-trip the member they don't
understand (CORD-02 §6), so a client unaware of this convention loses the
arrangement but never a Channel.

### A category is not an entity

There is no category object, and no id. A category exists exactly as long as
some Channel names it, which is the whole design:

- **Nothing to keep in sync.** No list to create, delete or garbage-collect,
  and no way to hold a category pointing at a Channel that no longer exists (or
  the reverse). Filing a Channel is one ordinary version-chained Channel edition
  requiring MANAGE_CHANNELS — the same authority as renaming it.
- **No shared list to clobber.** Two moderators filing different Channels at
  once collide on individual Channels rather than on one arrangement, mirroring
  how CORD-04 keeps Role order per-entity.
- **An empty category is unrepresentable.** It cannot outlive its last Channel.

The cost is that renaming a category means re-filing each Channel in it, and
that two Channels can disagree about the spelling. Clients SHOULD group
case-insensitively and label the group from the first Channel in display order,
so `Voice` and `voice` render as one heading rather than two.

### Order

Categories are ordered by their first Channel, and Channels keep their order
within a category — so a community that orders its Channels (see Channel
Ordering) orders its categories by the same act, with no second arrangement to
maintain and no way for the two to contradict each other. Uncategorized Channels
render first, ungrouped: a community that files nothing sees the flat list it
had before.

A category's position is therefore not a thing that can be set: it is read off
its first member. Dragging a heading is not offered for that reason — to move a
category, move the Channel that leads it.

### Visibility

A member sees a category exactly when they can see at least one Channel in it.
This needs no rule of its own: a member is shown only the Channels whose keys
they hold (CORD-03) — `channelsView` omits a Private Channel whose key the
member does not hold rather than teasing it — so a category all of whose
Channels are gated away has nothing left to derive it from and does not render.
The heading therefore never advertises Channels the viewer cannot read.

The honest bound: Channel METADATA lives on the Control Plane and is readable
by every member, gated content or not. Hiding the heading is a display courtesy
of the same kind as omitting the Channel itself; a client reading the fold
directly still sees that the category exists. **Categories organize a sidebar;
they are not an access control.**

### Implementation

In the Armada client:

- `client/src/concord-v2/lib/channelCategory.ts` — the metadata accessors
  (`channelCategory` / `withChannelCategory`), the casefolded `categoryKey`,
  and `groupChannelsByCategory` (the uncategorized run + ordered categories).
- `client/src/concord-v2/lib/community.ts` — `channelsView` surfaces `category`
  on each Channel it decides the member can see.
- `client/src/concord-v2/hooks/useCommunityActions2.ts` — `setChannelCategory`
  publishes the Channel edition, round-tripping the Channel's other extensions
  (`armada.git` today) and its `private` flag. It refuses a Channel absent from
  the Control fold rather than filing it against a default `{name:"",
  private:false}` metadata, which would blank the name and publish a Private
  Channel as public.
- `client/src/concord-v2/pages/ConcordV2Page.tsx` +
  `client/src/concord-v2/components/ChannelCategoryHeading2.tsx` — the
  collapsible headings. A collapsed category still shows the active Channel and
  anything unread, so folding one away never hides a mention. Which headings are
  folded is per-device state in `AppConfig.collapsedChannelCategories`, keyed by
  community id then casefolded category name.

Filing is done from the sidebar itself — right-click a Channel (press-and-hold
on touch) for "Move to category", and the same gesture on a heading for
"Rename category" / "Ungroup channels"; the community-settings Channel list
carries the same actions. Renaming and ungrouping are one edition PER Channel,
published in sequence, because a category is only ever the set of Channels
naming it: there is no category object to edit. They are independent entities
with independent version chains, so a failure part-way through leaves a
half-renamed category rather than a corrupt one, and renaming onto a name
already in use merges the two. Only MANAGE_CHANNELS holders see any of it.
