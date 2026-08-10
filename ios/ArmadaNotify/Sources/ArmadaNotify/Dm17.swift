import Foundation

/// A fully-opened, verified NIP-17 rumor, attributed to its conversation.
struct OpenedDm {
    let rumorId: String
    /// Verified author — the seal's signer, which equals the rumor's pubkey.
    let author: String
    let kind: Int
    let content: String
    let tags: [[String]]
    let createdAt: Int
    /// The conversation partner from the viewer's perspective.
    let peer: String
}

/// NIP-17 gift-wrap opening: `wrap(1059) → seal(13) → rumor`.
///
/// A port of `openDmWrap` in `src/lib/nip17/protocol.ts`, refusal for refusal.
/// That matters more than sharing any particular line of it: a notification
/// path that checked FEWER things than the app would be a second, laxer reader
/// of the same bytes, and the one that runs while nobody is watching.
enum Dm17 {

    static let kindChat = 14
    static let kindFile = 15
    static let kindSeal = 13
    static let kindWrap = 1059

    /// Rumors claiming to be further in the future than this are refused.
    private static let maxFutureSkewSecs = 3600

    /// Open a kind-1059 wrap addressed to `self`, or nil for anything this key
    /// cannot open, that is malformed, or that has already expired.
    ///
    /// The checks, in order:
    ///   1. the wrap decrypts under `conv(sk, wrap.pubkey)` → a kind-13 seal;
    ///   2. the seal decrypts under `conv(sk, seal.pubkey)` → the rumor;
    ///   3. the rumor's claimed pubkey equals the seal's signer (NIP-59
    ///      anti-spoofing). No Schnorr verify is needed for that: NIP-44's AEAD
    ///      means a seal that decrypted was authenticated to US by its author;
    ///   4. the rumor's id, when it claims one, is its NIP-01 hash;
    ///   5. a NIP-40 deadline that has passed on the wrap, the seal OR the
    ///      rumor rejects the whole envelope. All three, because relays are not
    ///      trusted to have dropped it and a sender can strip the outer tag.
    ///
    /// Whether the sender turns out to be the viewer is NOT decided here — that
    /// is presentation policy, and the caller has to tell it apart from a wrap
    /// that simply would not open.
    static func open(
        wrap: NostrEvent,
        secretKey sk: [UInt8],
        self selfPubkey: String,
        now: Int = Int(Date().timeIntervalSince1970)
    ) -> OpenedDm? {
        guard wrap.kind == kindWrap else { return nil }
        guard !Nip40.isExpired(wrap.tags, now: now) else { return nil }

        guard let wrapKey = Secp256k1.conversationKey(secretKey: sk, peerPubkeyHex: wrap.pubkey),
              let sealJson = Nip44.decrypt(conversationKey: wrapKey, payloadBase64: wrap.content),
              let seal = NostrEvent.parse(json: sealJson),
              seal.kind == kindSeal,
              !Nip40.isExpired(seal.tags, now: now)
        else { return nil }

        guard let sealKey = Secp256k1.conversationKey(secretKey: sk, peerPubkeyHex: seal.pubkey),
              let rumorJson = Nip44.decrypt(conversationKey: sealKey, payloadBase64: seal.content),
              let rumor = NostrEvent.parse(json: rumorJson)
        else { return nil }

        guard rumor.pubkey == seal.pubkey else { return nil }
        guard rumor.createdAt <= now + maxFutureSkewSecs else { return nil }
        guard !Nip40.isExpired(rumor.tags, now: now) else { return nil }

        let computedId = rumor.computedId
        if let claimed = rumor.id, claimed != computedId { return nil }

        guard let peer = peerOf(rumor, self: selfPubkey) else { return nil }

        return OpenedDm(
            rumorId: computedId,
            author: rumor.pubkey,
            kind: rumor.kind,
            content: rumor.content,
            tags: rumor.tags,
            createdAt: rumor.createdAt,
            peer: peer
        )
    }

    /// The conversation partner of a rumor from `self`'s perspective: the
    /// sender for received rumors, the first `p` tag for our own copies. Nil
    /// when unattributable (an own copy with no `p` tag).
    static func peerOf(_ rumor: NostrEvent, self selfPubkey: String) -> String? {
        if rumor.pubkey != selfPubkey { return rumor.pubkey }
        for tag in rumor.tags where tag.first == "p" && tag.count > 1 && !tag[1].isEmpty {
            return tag[1]
        }
        return nil
    }
}
