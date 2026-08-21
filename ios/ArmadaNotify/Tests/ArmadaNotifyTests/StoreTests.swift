import ArmadaDB
import XCTest

@testable import ArmadaNotify

/// The extension as a SECOND WRITER into the store the WebView reads.
///
/// This is the part of the port that has no compiler to catch it: the tenant
/// ids are strings both sides have to spell identically, and the ingest
/// refusals are rules that exist in three places and are enforced by none of
/// the readers. A rule only one writer applies is a conversation the two
/// disagree about — for routing, literally a message stored where the timeline
/// never looks.
final class StoreTests: XCTestCase {

    private var db: SqliteArmadaDb!
    private var bridge: ArmadaDbBridge!
    private var store: NotifyStore!

    private let self_ = String(repeating: "a", count: 64)
    private let peer = String(repeating: "b", count: 64)
    private let community = String(repeating: "c", count: 64)
    private let channel = String(repeating: "d", count: 64)
    private let now = 1_700_000_000

    override func setUpWithError() throws {
        db = try SqliteArmadaDb(db: try SqliteDriver(path: ":memory:"))
        bridge = ArmadaDbBridge(db: db)
        store = NotifyStore(bridge: bridge)
    }

    private func rumors(tenant: String) throws -> [[String: Any]] {
        let json = try bridge.query(tenant: tenant, filters: "[{}]")
        let decoded = try JSONSerialization.jsonObject(with: Data(json.utf8))
        return (decoded as? [[String: Any]]) ?? []
    }

    private func dm(kind: Int = 14, tags: [[String]] = [], content: String = "hi") -> OpenedDm {
        OpenedDm(
            rumorId: String(repeating: "1", count: 64), author: peer, kind: kind,
            content: content, tags: tags, createdAt: now, peers: [peer]
        )
    }

    private func chat(kind: Int = 9, tags: [[String]] = []) -> OpenedChat {
        OpenedChat(
            rumorId: String(repeating: "2", count: 64), author: peer, kind: kind,
            content: "shipped it", tags: tags, createdAt: now, channelIdHex: channel
        )
    }

    // MARK: - Tenants

    func testTenantIdsMatchTheWebViewsSpelling() {
        // `dm17Store()` and `communityTenant()` in the TypeScript. A different
        // spelling here would store every message where nothing reads it.
        XCTAssertEqual(NotifyStore.dmTenant(self: self_), "dm17:\(self_)")
        XCTAssertEqual(NotifyStore.communityTenant(community), "c2:\(community)")
    }

    // MARK: - DM writes

    func testWritesADmIntoTheViewersTenant() throws {
        try store.writeDm(dm(), self: self_, now: now)
        let stored = try rumors(tenant: NotifyStore.dmTenant(self: self_))
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored[0]["pubkey"] as? String, peer)
        XCTAssertEqual(stored[0]["kind"] as? Int, 14)
        XCTAssertEqual(stored[0]["content"] as? String, "hi")
    }

    func testStoresTheRumorAndNothingBesideIt() throws {
        // Its tags are the bytes its id commits to, so a provenance tag written
        // in here would make the row something the sender never signed — and
        // make whatever reads that tag forgeable by anyone who spells it.
        try store.writeDm(dm(tags: [["p", self_]]), self: self_, now: now)
        let stored = try rumors(tenant: NotifyStore.dmTenant(self: self_))
        XCTAssertEqual(stored[0]["tags"] as? [[String]] ?? [], [["p", self_]])
        XCTAssertNil(stored[0]["wrap"])
        XCTAssertNil(stored[0]["peer"])
    }

    func testRefusesAnExpiredDm() throws {
        // A disappearing message that arrives late is never stored. The opener
        // rejects it too, but the guarantee belongs at the write, which every
        // path goes through.
        try store.writeDm(
            dm(tags: [["expiration", String(now - 1)]]), self: self_, now: now
        )
        XCTAssertEqual(try rumors(tenant: NotifyStore.dmTenant(self: self_)).count, 0)
    }

    func testKeepsADmWhoseDeadlineHasNotPassed() throws {
        try store.writeDm(
            dm(tags: [["expiration", String(now + 60)]]), self: self_, now: now
        )
        XCTAssertEqual(try rumors(tenant: NotifyStore.dmTenant(self: self_)).count, 1)
    }

    // MARK: - Concord writes

    func testWritesAChatRumorIntoTheCommunityTenant() throws {
        try store.writeConcord(chat(), communityId: community, now: now)
        let stored = try rumors(tenant: NotifyStore.communityTenant(community))
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored[0]["kind"] as? Int, 9)
    }

    func testRefusesAnotherPlanesKind() throws {
        // The other half of the plane boundary. A community's planes share one
        // tenant and a plane is read back BY KIND, so a holder of any one
        // channel's stream key could otherwise wrap a kind-3308 rumor with a
        // valid channel binding and have it served as a control edition —
        // which nothing downstream could catch, a stored rumor having no seal
        // left whose form could be checked.
        for kind in Concord.planeKinds {
            try store.writeConcord(chat(kind: kind), communityId: community, now: now)
        }
        XCTAssertEqual(try rumors(tenant: NotifyStore.communityTenant(community)).count, 0)
    }

    func testRefusesAnExpiredChatRumor() throws {
        try store.writeConcord(
            chat(tags: [["expiration", String(now - 1)]]), communityId: community, now: now
        )
        XCTAssertEqual(try rumors(tenant: NotifyStore.communityTenant(community)).count, 0)
    }

    // MARK: - Reads

    func testReadsADisplayNameFromTheLocalProfile() throws {
        try bridge.event(
            tenant: ArmadaDbTenants.main,
            rumors: """
            [{"id":"\(String(repeating: "3", count: 64))","pubkey":"\(peer)","created_at":1,\
            "kind":0,"tags":[],"content":"{\\"name\\":\\"bob\\"}"}]
            """
        )
        XCTAssertEqual(store.displayName(pubkey: peer), "bob")
    }

    func testFallsBackToDisplayNameThenAnonymous() throws {
        try bridge.event(
            tenant: ArmadaDbTenants.main,
            rumors: """
            [{"id":"\(String(repeating: "4", count: 64))","pubkey":"\(peer)","created_at":1,\
            "kind":0,"tags":[],"content":"{\\"display_name\\":\\"Bob B\\"}"}]
            """
        )
        XCTAssertEqual(store.displayName(pubkey: peer), "Bob B")
        // An author with no kind-0 at all reads "Anonymous" — a fact
        // established by looking, not a placeholder for a lookup never made.
        XCTAssertEqual(store.displayName(pubkey: self_), "Anonymous")
    }

    func testReadsANip29GroupNameFromItsOwnRelayTenant() throws {
        // Scoped to the relay: the same group id on two relays is two unrelated
        // groups.
        try bridge.event(
            tenant: ArmadaDbTenants.nip29(relayUrl: "wss://relay.example"),
            rumors: """
            [{"id":"\(String(repeating: "5", count: 64))","pubkey":"\(peer)","created_at":1,\
            "kind":39000,"tags":[["d","团"],["name","General"]],"content":""}]
            """
        )
        XCTAssertEqual(
            store.nip29RoomTitle(relayUrl: "wss://relay.example", groupId: "团"), "General"
        )
        XCTAssertNil(store.nip29RoomTitle(relayUrl: "wss://other.example", groupId: "团"))
    }

    func testReadsAConcordRoomTitleOutOfTheFoldedSnapshot() throws {
        // `channels` is a Map, which foldedCache encodes as a tagged object.
        try bridge.kvSet(
            key: "folded:concord2-fold:\(community)",
            value: """
            {"metadata":{"name":"Armada"},"channels":{"__t":"map","v":\
            [["\(channel)",{"name":"general"}]]}}
            """
        )
        XCTAssertEqual(
            store.concordRoomTitle(communityId: community, channelId: channel),
            "Armada / #general"
        )
    }

    func testConcordRoomTitleDegradesRatherThanGuessing() throws {
        try bridge.kvSet(
            key: "folded:concord2-fold:\(community)",
            value: #"{"metadata":{"name":"Armada"}}"#
        )
        XCTAssertEqual(store.concordRoomTitle(communityId: community, channelId: channel), "Armada")
        // No fold at all (a fresh join) stays unnamed, and the caller titles
        // the notification "Chat" rather than waiting on a relay.
        XCTAssertNil(store.concordRoomTitle(communityId: "unknown", channelId: channel))
    }
}

/// Presentation must not depend on persistence.
///
/// The store and the notification fail independently: a database that will not
/// open costs the message its history and its sender's name, but the text has
/// already been decrypted and refusing to show it would turn one broken thing
/// into two. This is the rule that was wrong first time round — the extension
/// bailed on a nil store and every push silently fell back to the gateway's
/// static text.
final class StorelessTests: XCTestCase {

    private let self_ = String(repeating: "a", count: 64)
    private let peer = String(repeating: "b", count: 64)

    func testPresentsANip29MessageWithNoStoreAtAll() {
        let config = PushConfig(
            policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
            nip46: nil, concord: []
        )
        let processor = PushProcessor(store: nil, config: config, now: 1_700_000_000)

        let event = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: 9,
            tags: [["h", "general"]], content: "shipped it"
        )
        let prepared = processor.prepare(userInfo: [
            "scope": "group", "relays": ["wss://relay.example"], "event": event,
        ])

        XCTAssertNotNil(prepared, "a decrypted message must still be shown")
        XCTAssertEqual(prepared?.body, "Anonymous: shipped it")
        XCTAssertEqual(prepared?.threadId, "h:general")
        XCTAssertFalse(prepared?.drop ?? true)
    }

    /// A NIP-29 message arrives in the clear, so its signature is the only
    /// thing binding it to an author. Without this check the `pubkey` is just a
    /// string the sender picked — and it is used to look up the VIEWER'S stored
    /// kind-0, so naming a real contact borrows that contact's name and avatar
    /// for a communication notification on a message they never sent.
    func testRefusesANip29MessageWhoseSignatureDoesNotMatchItsAuthor() {
        let config = PushConfig(
            policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
            nip46: nil, concord: []
        )
        let processor = PushProcessor(store: nil, config: config, now: 1_700_000_000)

        // Signed by Bob, claiming to be Alice.
        let forged = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: 9,
            tags: [["h", "general"]], content: "shipped it",
            forgedPubkey: vectorString("alicePk")
        )
        XCTAssertNil(processor.prepare(userInfo: ["scope": "group", "event": forged]))

        // And an event whose body was edited after signing, so its id no longer
        // hashes to the content the signature covers.
        var tampered = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: 9,
            tags: [["h", "general"]], content: "shipped it"
        )
        tampered["content"] = "shipped nothing"
        XCTAssertNil(processor.prepare(userInfo: ["scope": "group", "event": tampered]))

        // An unsigned one is refused too — there is nothing else to go on.
        var unsigned = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: 9,
            tags: [["h", "general"]], content: "shipped it"
        )
        unsigned.removeValue(forKey: "sig")
        XCTAssertNil(processor.prepare(userInfo: ["scope": "group", "event": unsigned]))
    }

    func testStillDropsTheViewersOwnMessageWithNoStore() {
        // Degrading must not lose the decisions either — an own message is
        // still not news.
        // The viewer is Alice here, so the message can actually be signed as
        // hers — the drop decision is made after the signature check.
        let config = PushConfig(
            policy: .generic, selfPubkey: vectorString("alicePk"), knownPeers: [],
            secretKey: nil, nip46: nil, concord: []
        )
        let processor = PushProcessor(store: nil, config: config, now: 1_700_000_000)
        let event = signedEvent(
            secretKeyHex: vectorString("aliceSk"), kind: 9,
            tags: [["h", "general"]], content: "mine"
        )
        let prepared = processor.prepare(userInfo: ["scope": "group", "event": event])
        XCTAssertEqual(prepared?.drop, true)
    }

    /// A banned member (CORD-04) is folded off the timeline on read, and must
    /// be folded off the notification too — the same decision, made here from
    /// the decrypted author, which is the first place the ban set can be
    /// applied to a Concord wrap.
    func testDropsABannedMembersConcordMessage() {
        let concord = vectorObject("concord")
        let bobPk = vectorString("bobPk") // the vector wrap's real author
        let stream = ConcordStream(
            pubkey: concord["streamPk"] as! String,
            conversationKey: concord["convKey"] as! String,
            epoch: concord["epoch"] as! String,
            communityId: "cc",
            channelId: concord["channelId"] as! String,
            banned: [bobPk]
        )
        let config = PushConfig(
            policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
            nip46: nil, concord: [stream]
        )
        let processor = PushProcessor(store: nil, config: config, now: 1_700_000_000)
        let prepared = processor.prepare(
            userInfo: ["scope": "c2", "event": concord["wrap"] as! [String: Any]]
        )
        XCTAssertEqual(prepared?.drop, true, "a banned member's message must not notify")
    }

    /// A channel at "mentions only" wakes iOS for every message (the gateway
    /// can't read the encrypted wrap), so the extension — which decrypts — must
    /// drop a message that doesn't `#p`-tag the viewer. Mirrors the Android
    /// service's `mentionOnly`.
    func testDropsANonMentionMessageUnderMentionsOnly() {
        let concord = vectorObject("concord")
        let wrap = concord["wrap"] as! [String: Any]
        func stream(mentionOnly: Bool) -> ConcordStream {
            ConcordStream(
                pubkey: concord["streamPk"] as! String,
                conversationKey: concord["convKey"] as! String,
                epoch: concord["epoch"] as! String,
                communityId: "cc",
                channelId: concord["channelId"] as! String,
                banned: [],
                mentionOnly: mentionOnly
            )
        }
        func processor(mentionOnly: Bool) -> PushProcessor {
            PushProcessor(
                store: nil,
                config: PushConfig(
                    policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
                    nip46: nil, concord: [stream(mentionOnly: mentionOnly)]
                ),
                now: 1_700_000_000
            )
        }
        // Baseline: at "all messages" the same wrap (author bobPk, no `#p` for
        // the all-`a` viewer) notifies.
        XCTAssertNotEqual(
            processor(mentionOnly: false)
                .prepare(userInfo: ["scope": "c2", "event": wrap])?.drop,
            true,
            "a non-mention notifies a channel set to all messages"
        )
        // Mentions-only: the same non-mention wrap is dropped.
        XCTAssertEqual(
            processor(mentionOnly: true)
                .prepare(userInfo: ["scope": "c2", "event": wrap])?.drop,
            true,
            "a non-mention must not notify a mentions-only channel"
        )
    }
}

/// Who a notification says it is FROM.
///
/// `PreparedPush.sender` is what the extension turns into a communication
/// notification, which is the only way iOS shows a person instead of the app
/// icon. It therefore carries a privacy rule, not just a name: it is present
/// exactly where the sender is already being named in the body.
final class SenderIdentityTests: XCTestCase {

    private let self_ = String(repeating: "a", count: 64)
    private let peer = String(repeating: "b", count: 64)

    private func config(
        knownPeers: Set<String> = [],
        policy: DmRequestLevel = .generic,
        knownConversations: Set<String> = [],
        mutedPeers: Set<String> = []
    ) -> PushConfig {
        PushConfig(
            policy: policy, selfPubkey: self_, knownPeers: knownPeers,
            knownConversations: knownConversations, mutedPeers: mutedPeers,
            secretKey: nil, nip46: nil, concord: []
        )
    }

    func testGroupTrustAndTapStayScopedToTheExactConversation() {
        let other = String(repeating: "c", count: 64)
        let peers = [peer, other].sorted()
        let key = peers.joined(separator: ",")
        let groupConfig = config(knownConversations: [key])

        XCTAssertTrue(PushProcessor.isKnownDm(peers: peers, config: groupConfig))
        XCTAssertFalse(
            PushProcessor.isKnownDm(peers: [peer], config: groupConfig),
            "group participation must not trust the author in an unrelated 1:1"
        )
        XCTAssertEqual(PushProcessor.dmThreadId(peers: peers), "dm-\(key)")
        XCTAssertEqual(PushProcessor.dmPath(peers: peers), "/dm/\(key)")
        XCTAssertTrue(
            PushProcessor.isMutedDm(
                peers: peers,
                config: config(knownConversations: [key], mutedPeers: [other])
            ),
            "one muted participant hides the whole group, matching the DM list"
        )
    }

    func testPushConfigCarriesMutedAuthorsSeparatelyFromKnownRooms() {
        let key = [peer, String(repeating: "c", count: 64)].sorted().joined(separator: ",")
        let parsed = PushConfig.parse(json: """
        {"policy":"full","self":"\(self_)","knownPeers":[],
         "knownConversations":["\(key)"],"mutedPeers":["\(peer)"]}
        """)
        XCTAssertEqual(parsed?.knownConversations, Set([key]))
        XCTAssertEqual(parsed?.mutedPeers, Set([peer]))
    }

    func testANip29MessageNamesItsSender() {
        let processor = PushProcessor(store: nil, config: config(), now: 1_700_000_000)
        let bob = vectorString("bobPk")
        let event = signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: 9,
            tags: [["h", "general"]], content: "shipped it"
        )
        let prepared = processor.prepare(userInfo: ["scope": "group", "event": event])

        XCTAssertEqual(prepared?.sender?.id, bob, "the pubkey is the conversation's identity")
        XCTAssertEqual(prepared?.sender?.name, "Anonymous")
        // No store, so no kind-0 and no picture — the notification falls back to
        // the monogram, which is still the person.
        XCTAssertNil(prepared?.sender?.avatarUrl)
    }

    /// The rule this type exists to carry. A stranger picks their own name AND
    /// their own avatar, so a message request must reach the screen with
    /// neither — a content-blind ping cannot become a person.
    func testAMessageRequestHasNoSender() {
        let alicePk = vectorString("alicePk")
        let processor = PushProcessor(
            store: nil,
            config: PushConfig(
                policy: .generic, selfPubkey: alicePk, knownPeers: [],
                secretKey: Hex.decode(vectorString("aliceSk")), nip46: nil, concord: []
            ),
            now: 1_700_000_000
        )
        let prepared = processor.prepare(
            userInfo: ["scope": "dm", "event": vectorObject("dmWrap")]
        )

        XCTAssertEqual(prepared?.title, "Message requests", "the request ping, not the message")
        XCTAssertNil(prepared?.sender, "a stranger must not become a communication notification")
    }

    /// The same wrap from a KNOWN sender is a person, and says so.
    func testAKnownSenderIsNamed() {
        let alicePk = vectorString("alicePk")
        let bobPk = vectorString("bobPk")
        let processor = PushProcessor(
            store: nil,
            config: PushConfig(
                policy: .generic, selfPubkey: alicePk, knownPeers: [bobPk],
                secretKey: Hex.decode(vectorString("aliceSk")), nip46: nil, concord: []
            ),
            now: 1_700_000_000
        )
        let prepared = processor.prepare(
            userInfo: ["scope": "dm", "event": vectorObject("dmWrap")]
        )

        XCTAssertEqual(prepared?.sender?.id, bobPk)
        XCTAssertNil(prepared?.sender?.groupName, "a DM is not a group conversation")
    }
}
