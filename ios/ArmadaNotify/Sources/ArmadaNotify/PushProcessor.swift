import Foundation

/// What the extension should show, once the event is open.
public struct PreparedPush {
    /// Show NOTHING for this push, and mean it — as distinct from returning
    /// nil, which means "I couldn't decide, keep the gateway's fallback".
    ///
    /// The difference matters because the fallback is a VISIBLE notification. A
    /// message the viewer sent from another device, or a reaction to somebody
    /// else's message, would otherwise announce itself as "New message in a
    /// community": only the decrypted rumor can tell, so by the time it is
    /// known, silence has to be something the caller can ask for.
    ///
    /// iOS has no way to suppress a delivered alert entirely — an extension
    /// that calls its handler with unchanged content still shows one — so the
    /// caller turns this into the quietest thing it can (see
    /// `NotificationService`).
    public let drop: Bool
    public let title: String
    public let body: String
    /// Collapse identifier — one notification per conversation.
    public let threadId: String
    /// The in-app path a tap should open.
    public let path: String?
    /// Show this as quietly as the platform allows: an unknown sender under the
    /// `off` request policy.
    public let quiet: Bool
    /// Who sent it, when that is safe to reveal.
    ///
    /// Present only where the sender is already being named in the body — so
    /// never for a request ping, whose whole purpose is to reveal nothing a
    /// stranger controls, including their avatar. `NotificationService` turns
    /// this into a communication notification, which is what makes iOS show the
    /// person rather than the app icon.
    public let sender: Sender?

    public struct Sender {
        /// Hex pubkey, used only as the intent's stable identifier.
        public let id: String
        public let name: String
        /// `https` avatar URL, or nil.
        public let avatarUrl: String?
        /// The room, for a group conversation. Absent for a DM.
        public let groupName: String?
    }

    static let dropped = PreparedPush(
        drop: true, title: "", body: "", threadId: "", path: nil, quiet: true, sender: nil
    )
}

/// Open the event the gateway inlined, store it, and say what to show.
///
/// The third port of this pipeline: `sw.js` + `pushRuntime.ts` on the web,
/// `Dm17.kt` + `ServiceStore.kt` on Android, this on iOS.
///
/// Every step is best-effort and non-fatal. Anything that fails returns nil and
/// the caller keeps the gateway's static wake-up, which is why a login whose
/// key this doesn't hold, a message too big to inline, and a config that hasn't
/// been written yet all degrade to the same safe place.
///
/// STORING HAPPENS BEFORE PRESENTING, deliberately: the notification is a side
/// effect of a message arriving, and the message arriving is the part that has
/// to survive. A store that failed still shows the notification; a presentation
/// that failed has still persisted the message.
struct PushProcessor {

    /// Optional, and that is the point: a store that will not open costs the
    /// message's PERSISTENCE, not its notification. Gating presentation on
    /// persistence turns one broken thing into two — the user loses the text as
    /// well as the history — and the store is the half that can be refilled
    /// from a relay later.
    let store: NotifyStore?
    let config: PushConfig
    let now: Int

    /// Where a refusal goes.
    ///
    /// Returning nil is this type's ONLY way to decline, and it means six
    /// different things — an event the gateway could not inline, a login with
    /// no key, a bunker that did not answer, a wrap for somebody else, an
    /// expired message, a scope that is not ours. They are indistinguishable
    /// from outside and they are all invisible: the user sees the gateway's
    /// static text either way. Naming which one ran is the difference between
    /// diagnosing this in a minute and guessing at it for an hour.
    ///
    /// A STATUS only — never content, pubkeys or event ids. Defaults to a
    /// no-op, so the Linux suite and any other caller pay nothing for it.
    let trace: (String) -> Void

    init(
        store: NotifyStore?,
        config: PushConfig,
        now: Int = Int(Date().timeIntervalSince1970),
        trace: @escaping (String) -> Void = { _ in }
    ) {
        self.store = store
        self.config = config
        self.now = now
        self.trace = trace
    }

    /// `userInfo` is the APNs payload. The gateway hoists every key of the
    /// subscription's `notification.data` to the TOP LEVEL for APNs rather than
    /// nesting it, so `scope`, `relays` and the inlined `event` are read from
    /// there.
    func prepare(userInfo: [AnyHashable: Any]) -> PreparedPush? {
        guard let scope = userInfo["scope"] as? String else {
            trace("no-scope")
            return nil
        }
        // The absence of an event is NOT a decrypt failure and must not be
        // reported as one: the gateway inlines it only if the whole payload
        // fits APNs' 4 KB, and drops it silently otherwise (see
        // `pushSubscriptions.ts`). A gift wrap is nested base64 and can be a
        // couple of kilobytes on its own, so this is an ordinary outcome for a
        // long message rather than a fault — and it is indistinguishable from
        // a broken decrypt unless it is named.
        guard let rawEvent = userInfo["event"] as? [String: Any] else {
            trace("no-inlined-event(\(scope))")
            return nil
        }
        guard let event = NostrEvent.parse(rawEvent) else {
            trace("unparseable-event(\(scope))")
            return nil
        }

        switch scope {
        case "dm":
            return prepareDm(wrap: event)
        case "c2":
            return prepareConcord(wrap: event)
        case "group", "group-mention":
            let relays = (userInfo["relays"] as? [String]) ?? []
            return prepareGroup(event: event, relays: relays)
        default:
            trace("unknown-scope(\(scope))")
            return nil
        }
    }

    // MARK: - DM

    static func dmConversationKey(peers: [String]) -> String {
        peers.joined(separator: ",")
    }

    static func isKnownDm(peers: [String], config: PushConfig) -> Bool {
        let key = dmConversationKey(peers: peers)
        return config.knownConversations.contains(key)
            || peers.allSatisfy { config.knownPeers.contains($0) }
    }

    static func isMutedDm(peers: [String], config: PushConfig) -> Bool {
        peers.contains(where: { config.mutedPeers.contains($0) })
    }

    static func dmPath(peers: [String]) -> String {
        "/dm/\(dmConversationKey(peers: peers))"
    }

    static func dmThreadId(peers: [String]) -> String {
        "dm-\(dmConversationKey(peers: peers))"
    }

    private func prepareDm(wrap: NostrEvent) -> PreparedPush? {
        guard let decryptor = dmDecryptor() else {
            // Neither an on-device key nor a usable bunker: this login cannot
            // open a wrap at all, which is a configuration fact rather than a
            // failure of this message.
            trace("dm-no-decryptor")
            return nil
        }
        guard let opened = Dm17.open(
            wrap: wrap, decryptor: decryptor, self: config.selfPubkey, now: now
        ) else {
            // Addressed to someone else, malformed, expired — or, for a bunker
            // login, a decrypt the bunker did not answer in time.
            trace(config.secretKey == nil ? "dm-open-failed(bunker)" : "dm-open-failed(local)")
            return nil
        }

        // Persist first: a DM exists nowhere else once it is read off the relay.
        try? store?.writeDm(opened, self: config.selfPubkey, now: now)

        // Our own sent copy is addressed to us too, and is not news.
        if opened.author == config.selfPubkey { return .dropped }

        // Match the DM list: a group containing any muted participant is
        // hidden as a whole, even if this message's author is unmuted.
        if Self.isMutedDm(peers: opened.peers, config: config) {
            return .dropped
        }

        // Reactions, deletes and timer changes are not messages.
        guard opened.kind == Dm17.kindChat || opened.kind == Dm17.kindFile else {
            return requestPing(quiet: true)
        }

        let known = Self.isKnownDm(peers: opened.peers, config: config)
        if !known && config.policy != .full {
            // A stranger picks the text, the name AND the avatar alike — gate
            // all of it before any reaches the screen.
            return requestPing(quiet: config.policy == .off)
        }

        let profile = store?.profile(pubkey: opened.author)
        let message = NotificationPreview.Message(
            plane: .dm,
            kind: opened.kind,
            content: opened.content,
            authorName: profile?.name ?? "Anonymous",
            roomTitle: nil,
            imetaMime: NotificationPreview.firstImetaMime(opened.tags),
            mentionNames: store?.mentionNames(in: opened.content) ?? [:]
        )
        var shaped = message
        shaped.threadReply = NotificationPreview.isThreadReply(
            kind: opened.kind, tags: opened.tags
        )
        let presented = NotificationPreview.present(shaped)
        return PreparedPush(
            drop: false,
            title: presented.title,
            body: presented.body,
            threadId: Self.dmThreadId(peers: opened.peers),
            path: Self.dmPath(peers: opened.peers),
            quiet: false,
            sender: PreparedPush.Sender(
                id: opened.author,
                name: profile?.name ?? "Anonymous",
                avatarUrl: profile?.picture,
                groupName: nil
            )
        )
    }

    /// How this login can open a gift wrap, or nil if it cannot.
    ///
    /// An nsec login decrypts locally. A bunker login asks the bunker, which
    /// costs two round-trips inside the notification's budget and is why the
    /// timeout is short: an unreachable or slow bunker must degrade to the
    /// gateway's static text quickly, not sit on the extension until iOS kills
    /// it. A NIP-07 login has neither and gets nil — there is no browser here.
    private func dmDecryptor() -> Nip44Decryptor? {
        if let sk = config.secretKey { return LocalDecryptor(secretKey: sk) }
        guard let nip46 = config.nip46 else { return nil }
        guard let client = Nip46Client(
            clientSecretKey: nip46.clientSecretKey,
            bunkerPubkey: nip46.bunkerPubkey,
            relays: nip46.relays,
            timeout: Self.bunkerTimeout
        ) else { return nil }
        return RemoteDecryptor(client: client)
    }

    /// Total budget for the bunker exchange, both RPCs together.
    ///
    /// iOS allows the extension around 30 seconds, but spending them is not
    /// free: the notification is not shown until the handler is called, so a
    /// long wait is a late banner. Ten seconds is enough for two relay
    /// round-trips and short enough that a dead bunker is barely noticeable.
    private static let bunkerTimeout: TimeInterval = 10

    /// The content-blind ping for an unknown sender: nothing they control.
    private func requestPing(quiet: Bool) -> PreparedPush {
        PreparedPush(
            drop: false,
            title: "Message requests",
            body: quiet ? "You have new message requests" : "You have a new message request",
            threadId: "armada-dm-requests",
            path: "/dm",
            quiet: quiet,
            // No sender: a stranger controls their name AND their avatar, and
            // the point of this ping is that none of it reaches the screen.
            sender: nil
        )
    }

    // MARK: - Concord

    private func prepareConcord(wrap: NostrEvent) -> PreparedPush? {
        // No stream claims this wrap's author: a channel this install is not
        // watching, or an epoch it has no key for yet (the config holds only
        // the CURRENT epoch, and a rekey moves it).
        guard let stream = Concord.stream(for: wrap, in: config.concord) else {
            trace("c2-no-stream(\(config.concord.count) watched)")
            return nil
        }
        guard let opened = Concord.open(wrap: wrap, stream: stream) else {
            trace("c2-open-failed")
            return nil
        }

        // Store it either way: a message we won't announce is still a message,
        // and the timeline it belongs to has no other copy.
        try? store?.writeConcord(opened, communityId: stream.communityId, now: now)

        // Our own message, sent from another device. The local send marks its
        // own event id, but nothing marks one made elsewhere — only the
        // decrypted author says so, and that is here.
        if opened.author == config.selfPubkey { return .dropped }

        // A banned member (CORD-04): stored above like every other message,
        // folded off the timeline on read, and — here — never announced. The
        // author is on the encrypted rumor, so this is the first place it can
        // be checked.
        if stream.banned.contains(opened.author) { return .dropped }

        let mention = opened.tags.contains {
            $0.count > 1 && $0[0] == "p" && $0[1] == config.selfPubkey
        }
        let reaction = opened.kind == Concord.kindReaction
        // A reaction notifies only when it points at one of YOUR messages; the
        // `p` tag is on the encrypted rumor, so this is the first place it can
        // be read at all.
        if reaction && !mention { return .dropped }

        // "Mentions only": the gateway can't filter an encrypted wrap, so it
        // wakes us for every message on this channel; here — the first place the
        // decrypted `p` tags are legible — we drop anything that doesn't tag the
        // viewer, matching the Android service and the channel's chosen level.
        if stream.mentionOnly && !mention { return .dropped }

        let profile = store?.profile(pubkey: opened.author)
        var message = NotificationPreview.Message(
            plane: .c2,
            kind: opened.kind,
            content: opened.content,
            authorName: profile?.name ?? "Anonymous",
            roomTitle: store?.concordRoomTitle(
                communityId: stream.communityId, channelId: stream.channelId
            ),
            mention: mention,
            reaction: reaction,
            imetaMime: NotificationPreview.firstImetaMime(opened.tags),
            mentionNames: store?.mentionNames(in: opened.content) ?? [:]
        )
        message.threadReply = NotificationPreview.isThreadReply(
            kind: opened.kind, tags: opened.tags
        )

        let presented = NotificationPreview.present(message)
        // A reaction points at the message it reacted to — the thing the reader
        // is being told about, and the only one of the two a timeline can show.
        let target = opened.uniqueETag ?? opened.rumorId
        return PreparedPush(
            drop: false,
            title: presented.title,
            body: presented.body,
            threadId: "c2:\(stream.channelId)",
            path: "/c/\(stream.communityId)/\(stream.channelId)/m/\(target)",
            quiet: false,
            sender: PreparedPush.Sender(
                id: opened.author,
                name: profile?.name ?? "Anonymous",
                avatarUrl: profile?.picture,
                groupName: message.roomTitle
            )
        )
    }

    // MARK: - NIP-29

    /// A NIP-29 group message, which arrives in the clear.
    ///
    /// Deliberately NOT stored. A group id names nothing without its relay, and
    /// the push payload carries no source-relay attribution — only the
    /// subscription's whole relay list — so filing it would mean guessing a
    /// tenant. Nothing is lost: the message is plaintext on a relay the app
    /// re-reads on open, which is exactly the case the "no relay, no store"
    /// rule calls refetchable.
    private func prepareGroup(event: NostrEvent, relays: [String]) -> PreparedPush? {
        guard let groupId = event.uniqueTag("h") else {
            trace("grp-no-h")
            return nil
        }
        if event.pubkey == config.selfPubkey { return .dropped }

        // Ask each candidate relay's tenant and accept a name only if exactly
        // ONE knows this group: a hit on two would be two different groups that
        // merely share an id, and naming the notification after either is a
        // coin toss.
        var named = [(relay: String, title: String)]()
        for relay in relays {
            if let title = store?.nip29RoomTitle(relayUrl: relay, groupId: groupId) {
                named.append((relay, title))
            }
        }
        let only = named.count == 1 ? named[0] : nil

        let mention = event.tags.contains {
            $0.count > 1 && $0[0] == "p" && $0[1] == config.selfPubkey
        }
        let profile = store?.profile(pubkey: event.pubkey)
        var message = NotificationPreview.Message(
            plane: .nip29,
            kind: event.kind,
            content: event.content,
            authorName: profile?.name ?? "Anonymous",
            roomTitle: only?.title,
            mention: mention,
            imetaMime: NotificationPreview.firstImetaMime(event.tags),
            mentionNames: store?.mentionNames(in: event.content) ?? [:]
        )
        message.threadReply = NotificationPreview.isThreadReply(
            kind: event.kind, tags: event.tags
        )

        let presented = NotificationPreview.present(message)
        let relay = only?.relay ?? relays.first
        let path = relay.flatMap { url -> String? in
            guard let eventId = event.id else { return nil }
            return groupPath(relayUrl: url, groupId: groupId, eventId: eventId)
        }
        return PreparedPush(
            drop: false,
            title: presented.title,
            body: presented.body,
            threadId: "h:\(groupId)",
            path: path,
            quiet: false,
            sender: PreparedPush.Sender(
                id: event.pubkey,
                name: profile?.name ?? "Anonymous",
                avatarUrl: profile?.picture,
                groupName: only?.title
            )
        )
    }

    /// Deep link to a message in a NIP-29 group. Mirrors `routes.ts`: the
    /// relay's `wss://` scheme is dropped and `ws://` shortened to `ws:`.
    private func groupPath(relayUrl: String, groupId: String, eventId: String) -> String {
        var trimmed = relayUrl
        if trimmed.lowercased().hasPrefix("wss://") {
            trimmed = String(trimmed.dropFirst(6))
        } else if trimmed.lowercased().hasPrefix("ws://") {
            trimmed = "ws:" + trimmed.dropFirst(5)
        }
        return "/s/\(escape(trimmed))/\(escape(groupId))/m/\(escape(eventId))"
    }

    private func escape(_ value: String) -> String {
        value.addingPercentEncoding(
            withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))
        ) ?? value
    }
}

private extension OpenedChat {
    /// The one `e` tag, or nil when absent or repeated.
    var uniqueETag: String? {
        var found: String?
        for tag in tags where tag.first == "e" {
            if found != nil { return nil }
            found = tag.count > 1 ? tag[1] : nil
        }
        return found
    }
}
