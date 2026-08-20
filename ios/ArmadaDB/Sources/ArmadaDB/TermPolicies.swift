/// NIP-17 conversation identity, and the one table of derived-term policies.
///
/// A port of `src/lib/nip17/conversation.ts` and `src/lib/db/termPolicies.ts`,
/// and the counterpart of Android's `Dm17.kt` + `TermPolicies.kt`.
///
/// `SqliteArmadaDb` never interprets a tenant id or a term — that is the whole
/// contract, and it is why nothing NIP-17-shaped is inside it. This file is
/// where the knowledge lives instead, and it is deliberately the ONLY place: a
/// policy spelled two ways files rows under a term nothing looks up, which is a
/// silent read of nothing, repairable only by dropping the index and walking the
/// tenant again.
///
/// It lives in ArmadaDB rather than in ArmadaNotify because the store is what
/// applies it, and the extension writes THROUGH the store. That is the point of
/// binding a policy to the tenant: the extension files a rumor under the right
/// conversation while knowing nothing about terms, and a message that arrives
/// while the app is dead is in the thread when the app opens.

/// The derived-term policies, by tenant.
public enum TermPolicies {

    /// Which revision of the policies below the index is built by — the same
    /// number as `TERM_GENERATION` in `src/lib/db/termPolicies.ts` and
    /// `TermPolicies.GENERATION` in Kotlin.
    ///
    /// BUMP IT whenever `terms(of:tenantId:)` changes what it derives. The index
    /// is built by a one-time pass per tenant which records this number; a
    /// derivation that changes without it is silent and permanent, since rows
    /// already on disk keep the terms they were written with.
    ///
    /// All three ports write it into ONE file, so two that disagree would each
    /// read the other's as stale and rebuild the index on every open, forever.
    /// `ArmadaDbTests` pins the literal.
    ///
    ///   1  `conv:<peers>` — a rumor filed under its NIP-17 conversation.
    ///   2  adds `convmsg:<peers>` (chat and file rumors only) and
    ///      `convmine:<peers>` (the same, authored by the viewer), which is what
    ///      makes the conversation list a collapse over an index rather than a
    ///      sample of the newest rumors.
    ///   3  a `p` value that is not a 64-char lowercase-hex pubkey no longer
    ///      names a participant, so the fixed width the terms are concatenated
    ///      on holds. Rows filed under a term derived from one are re-derived
    ///      by the rebuild.
    public static let generation: Int64 = 3

    /// The derived terms of a rumor stored in `tenantId`, or empty when that
    /// tenant derives none — which is most of them, and means a term read
    /// against one matches nothing.
    public static func terms(of rumor: Rumor, tenantId: String) -> [String] {
        if Dm17Conversation.tenantSelf(tenantId) != nil {
            // A NIP-17 conversation is a participant SET, which a NIP-01 filter
            // can only over-select. See `Dm17Conversation.peers`.
            return Dm17Conversation.terms(of: rumor, tenantId: tenantId)
        }
        return []
    }
}

/// NIP-17 conversation identity: which conversation a stored rumor belongs to.
///
/// A conversation is its PARTICIPANT SET, not a peer — the `p` set defines the
/// room (NIP-17), so a rumor names its own conversation and nothing has to be
/// stored beside it.
///
/// The set is canonicalized to "everyone but the viewer, sorted", which makes
/// the two directions of one conversation agree: a message Alice sends to
/// {me, Bob} arrives as `pubkey: Alice, p: [me, Bob]` and my reply leaves as
/// `pubkey: me, p: [Alice, Bob]`, and both reduce to [Alice, Bob]. For a 1:1 it
/// yields exactly `[peer]`, which is why the keys did not change when groups
/// arrived.
public enum Dm17Conversation {

    /// The `dm17:` tenant prefix.
    public static let tenantPrefix = "dm17:"

    /// The pubkey in a `dm17:<self>` tenant id, or nil for any other id —
    /// including a bare `dm17:`, which names no viewer. Falling through with an
    /// empty `self` would file every participant of every rumor as a peer, where
    /// the TypeScript policy (whose `!self` check is the same test) derives
    /// nothing; the id is malformed either way, and the two must agree on what a
    /// malformed one means.
    public static func tenantSelf(_ tenantId: String) -> String? {
        guard tenantId.hasPrefix(tenantPrefix) else { return nil }
        let rest = String(tenantId.dropFirst(tenantPrefix.count))
        return rest.isEmpty ? nil : rest
    }

    /// Whether a string is a bare 32-byte pubkey in lowercase hex — the port of
    /// `isPubkey` in `src/lib/nip17/conversation.ts`.
    ///
    /// A `p` VALUE is whatever the sender typed, and everything downstream of a
    /// participant set assumes a pubkey: `term(_:namespace:)` joins
    /// participants with NOTHING (fixed width is what makes that unambiguous),
    /// a conversation key joins them with a separator a value could otherwise
    /// contain, and the key becomes a URL path. So a value that is not a pubkey
    /// is not a participant, and is dropped where the set is built rather than
    /// checked again by each thing that consumes it.
    ///
    /// Compared over UTF-8 bytes rather than Characters: a `p` value is
    /// arbitrary text, and Swift's `Character` is a grapheme cluster, so a
    /// combining mark could otherwise make a 64-element string of something
    /// that is not 64 hex digits.
    public static func isPubkey(_ value: String) -> Bool {
        let bytes = value.utf8
        guard bytes.count == 64 else { return false }
        for b in bytes {
            let hex = (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66)
            if !hex { return false }
        }
        return true
    }

    /// The participants of a rumor's conversation, from `selfPubkey`'s
    /// perspective: everyone involved except the viewer, sorted. `[self]` for
    /// Note to Self. Nil when unattributable — an own copy with no `p` tag names
    /// no room, and callers drop it rather than guess.
    ///
    /// A `p` value that is not a pubkey is ignored (see `isPubkey`); a rumor
    /// left with no participants by that is unattributable like any other.
    public static func peers(of rumor: Rumor, self selfPubkey: String) -> [String]? {
        var recipients: Set<String> = []
        for tag in rumor.tags where tag.count >= 2 {
            if tag[0] == "p", let value = tag[1], !value.isEmpty, isPubkey(value) {
                recipients.insert(value)
            }
        }

        if rumor.pubkey != selfPubkey {
            // Received: the sender is a participant whether or not they p-tagged
            // themselves, and we are not one of our own peers. The author is
            // held to the same shape as a `p` value, so EVERY element of the
            // result is a pubkey — the property the term, the key and the route
            // all rest on. In practice it always is: a rumor reaches the store
            // only from a seal whose signature was verified.
            guard isPubkey(rumor.pubkey) else { return nil }
            var others = recipients
            others.insert(rumor.pubkey)
            others.remove(selfPubkey)
            return others.isEmpty ? nil : sorted(others)
        }

        // Our own copy: only the `p` set says where it went.
        if recipients.isEmpty { return nil }
        var others = recipients
        others.remove(selfPubkey)
        return others.isEmpty ? [selfPubkey] : sorted(others)
    }

    /// The namespace every rumor of a conversation is filed under.
    public static let convTerm = "conv"

    /// The namespace holding only the rumors worth listing (chat and file), so
    /// `distinct:convmsg` can name the newest MESSAGE of every conversation
    /// without any engine reading a rumor's kind. See `DM_MSG_TERM`.
    public static let msgTerm = "convmsg"

    /// The same, restricted to messages the VIEWER sent — "conversations I have
    /// written in", which is what tells the notification path that a sender is
    /// not a stranger. See `DM_MINE_TERM`.
    public static let mineTerm = "convmine"

    /// The kinds `msgTerm` and `mineTerm` cover: a chat message or a file.
    public static let messageKinds: Set<Int> = [14, 15]

    /// The derived index term for a participant set, in `namespace`.
    ///
    /// Joined with NOTHING rather than with a separator: a term crosses a NIP-50
    /// search string, whose parse ends a token at whitespace. Pubkeys are
    /// fixed-width 64-char hex, so concatenating them is unambiguous.
    public static func term(_ peers: [String], namespace: String = convTerm) -> String {
        "\(namespace):" + sorted(peers).joined()
    }

    /// The policy for a `dm17:<self>` tenant: each rumor filed under the one
    /// conversation it belongs to, in every namespace it qualifies for.
    ///
    /// `self` comes from the TENANT ID, which is the whole shape of the
    /// contract — the engine never interprets a tenant id, and this is the layer
    /// that spells `dm17:` in the first place.
    ///
    /// Exactly one term per namespace, which `distinct:` requires: a rumor that
    /// was the newest of two groups could only ever be returned once.
    ///
    /// The notification extension writes through this while the app is closed, so
    /// a message that arrives then is already in the conversation list's index
    /// when the app opens — which is the whole reason a policy binds to the
    /// tenant.
    public static func terms(of rumor: Rumor, tenantId: String) -> [String] {
        guard let selfPubkey = tenantSelf(tenantId),
              let peers = peers(of: rumor, self: selfPubkey)
        else { return [] }

        var terms = [term(peers)]
        if messageKinds.contains(rumor.kind) {
            terms.append(term(peers, namespace: msgTerm))
            if rumor.pubkey == selfPubkey { terms.append(term(peers, namespace: mineTerm)) }
        }
        return terms
    }

    /// Sorted by UTF-16 code unit, matching the engine's own string order.
    ///
    /// Swift's `<` compares by canonical equivalence, so a decomposed accent
    /// equals a composed one and astral characters land on the wrong side of
    /// U+E000..U+FFFF. A term is derived on one platform and looked up on
    /// another, so the order it is built in is contract, not detail — even
    /// though pubkeys are hex and never reach the disagreement.
    private static func sorted<S: Sequence>(_ values: S) -> [String] where S.Element == String {
        values.sorted { lhs, rhs in
            lhs.utf16.lexicographicallyPrecedes(rhs.utf16)
        }
    }
}
