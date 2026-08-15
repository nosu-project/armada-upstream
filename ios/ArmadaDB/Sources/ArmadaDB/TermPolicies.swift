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
    public static let generation: Int64 = 1

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

    /// The pubkey in a `dm17:<self>` tenant id, or nil for any other id.
    public static func tenantSelf(_ tenantId: String) -> String? {
        guard tenantId.hasPrefix(tenantPrefix) else { return nil }
        return String(tenantId.dropFirst(tenantPrefix.count))
    }

    /// The participants of a rumor's conversation, from `selfPubkey`'s
    /// perspective: everyone involved except the viewer, sorted. `[self]` for
    /// Note to Self. Nil when unattributable — an own copy with no `p` tag names
    /// no room, and callers drop it rather than guess.
    public static func peers(of rumor: Rumor, self selfPubkey: String) -> [String]? {
        var recipients: Set<String> = []
        for tag in rumor.tags where tag.count >= 2 {
            if tag[0] == "p", let value = tag[1], !value.isEmpty { recipients.insert(value) }
        }

        if rumor.pubkey != selfPubkey {
            // Received: the sender is a participant whether or not they p-tagged
            // themselves, and we are not one of our own peers.
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

    /// The derived index term for a participant set.
    ///
    /// Joined with NOTHING rather than with a separator: a term crosses a NIP-50
    /// search string, whose parse ends a token at whitespace. Pubkeys are
    /// fixed-width 64-char hex, so concatenating them is unambiguous.
    public static func term(_ peers: [String]) -> String {
        "conv:" + sorted(peers).joined()
    }

    /// The policy for a `dm17:<self>` tenant: each rumor filed under the one
    /// conversation it belongs to.
    ///
    /// `self` comes from the TENANT ID, which is the whole shape of the
    /// contract — the engine never interprets a tenant id, and this is the layer
    /// that spells `dm17:` in the first place.
    public static func terms(of rumor: Rumor, tenantId: String) -> [String] {
        guard let selfPubkey = tenantSelf(tenantId),
              let peers = peers(of: rumor, self: selfPubkey)
        else { return [] }
        return [term(peers)]
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
