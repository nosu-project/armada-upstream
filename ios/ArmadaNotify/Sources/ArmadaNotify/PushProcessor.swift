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

    static let dropped = PreparedPush(
        drop: true, title: "", body: "", threadId: "", path: nil, quiet: true
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

    let store: NotifyStore
    let config: PushConfig
    let now: Int

    init(store: NotifyStore, config: PushConfig, now: Int = Int(Date().timeIntervalSince1970)) {
        self.store = store
        self.config = config
        self.now = now
    }

    /// `userInfo` is the APNs payload. The gateway hoists every key of the
    /// subscription's `notification.data` to the TOP LEVEL for APNs rather than
    /// nesting it, so `scope`, `relays` and the inlined `event` are read from
    /// there.
    func prepare(userInfo: [AnyHashable: Any]) -> PreparedPush? {
        guard let scope = userInfo["scope"] as? String else { return nil }
        guard let rawEvent = userInfo["event"] as? [String: Any],
              let event = NostrEvent.parse(rawEvent)
        else { return nil }

        switch scope {
        case "dm":
            return prepareDm(wrap: event)
        case "c2":
            return prepareConcord(wrap: event)
        case "group", "group-mention":
            let relays = (userInfo["relays"] as? [String]) ?? []
            return prepareGroup(event: event, relays: relays)
        default:
            return nil
        }
    }

    // MARK: - DM

    private func prepareDm(wrap: NostrEvent) -> PreparedPush? {
        guard let decryptor = dmDecryptor() else { return nil }
        guard let opened = Dm17.open(
            wrap: wrap, decryptor: decryptor, self: config.selfPubkey, now: now
        ) else { return nil }

        // Persist first: a DM exists nowhere else once it is read off the relay.
        try? store.writeDm(opened, self: config.selfPubkey, now: now)

        // Our own sent copy is addressed to us too, and is not news.
        if opened.author == config.selfPubkey { return .dropped }

        // Reactions, deletes and timer changes are not messages.
        guard opened.kind == Dm17.kindChat || opened.kind == Dm17.kindFile else {
            return requestPing(quiet: true)
        }

        let known = config.knownPeers.contains(opened.author)
        if !known && config.policy != .full {
            // A stranger picks the text, the name AND the avatar alike — gate
            // all of it before any reaches the screen.
            return requestPing(quiet: config.policy == .off)
        }

        let message = NotificationPreview.Message(
            plane: .dm,
            kind: opened.kind,
            content: opened.content,
            authorName: store.displayName(pubkey: opened.author),
            roomTitle: nil,
            imetaMime: NotificationPreview.firstImetaMime(opened.tags),
            mentionNames: store.mentionNames(in: opened.content)
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
            threadId: "dm-\(opened.author)",
            path: "/dm/\(opened.author)",
            quiet: false
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
            quiet: quiet
        )
    }

    // MARK: - Concord

    private func prepareConcord(wrap: NostrEvent) -> PreparedPush? {
        guard let stream = Concord.stream(for: wrap, in: config.concord) else { return nil }
        guard let opened = Concord.open(wrap: wrap, stream: stream) else { return nil }

        // Store it either way: a message we won't announce is still a message,
        // and the timeline it belongs to has no other copy.
        try? store.writeConcord(opened, communityId: stream.communityId, now: now)

        // Our own message, sent from another device. The local send marks its
        // own event id, but nothing marks one made elsewhere — only the
        // decrypted author says so, and that is here.
        if opened.author == config.selfPubkey { return .dropped }

        let mention = opened.tags.contains {
            $0.count > 1 && $0[0] == "p" && $0[1] == config.selfPubkey
        }
        let reaction = opened.kind == Concord.kindReaction
        // A reaction notifies only when it points at one of YOUR messages; the
        // `p` tag is on the encrypted rumor, so this is the first place it can
        // be read at all.
        if reaction && !mention { return .dropped }

        var message = NotificationPreview.Message(
            plane: .c2,
            kind: opened.kind,
            content: opened.content,
            authorName: store.displayName(pubkey: opened.author),
            roomTitle: store.concordRoomTitle(
                communityId: stream.communityId, channelId: stream.channelId
            ),
            mention: mention,
            reaction: reaction,
            imetaMime: NotificationPreview.firstImetaMime(opened.tags),
            mentionNames: store.mentionNames(in: opened.content)
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
            quiet: false
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
        guard let groupId = event.uniqueTag("h") else { return nil }
        if event.pubkey == config.selfPubkey { return .dropped }

        // Ask each candidate relay's tenant and accept a name only if exactly
        // ONE knows this group: a hit on two would be two different groups that
        // merely share an id, and naming the notification after either is a
        // coin toss.
        var named = [(relay: String, title: String)]()
        for relay in relays {
            if let title = store.nip29RoomTitle(relayUrl: relay, groupId: groupId) {
                named.append((relay, title))
            }
        }
        let only = named.count == 1 ? named[0] : nil

        let mention = event.tags.contains {
            $0.count > 1 && $0[0] == "p" && $0[1] == config.selfPubkey
        }
        var message = NotificationPreview.Message(
            plane: .nip29,
            kind: event.kind,
            content: event.content,
            authorName: store.displayName(pubkey: event.pubkey),
            roomTitle: only?.title,
            mention: mention,
            imetaMime: NotificationPreview.firstImetaMime(event.tags),
            mentionNames: store.mentionNames(in: event.content)
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
            quiet: false
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
