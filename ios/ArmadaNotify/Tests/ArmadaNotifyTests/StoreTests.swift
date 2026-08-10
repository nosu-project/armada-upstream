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
            content: content, tags: tags, createdAt: now, peer: peer
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
