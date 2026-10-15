import XCTest

@testable import ArmadaNotify

/// nostr-push2's APNs payload: which plane an event is, fetched when it did
/// not fit, and what it shows when it cannot be opened.
final class PayloadTests: XCTestCase {

    private let self_ = String(repeating: "a", count: 64)

    private func config(concord: [ConcordStream] = []) -> PushConfig {
        PushConfig(
            policy: .generic, selfPubkey: self_, knownPeers: [], secretKey: nil,
            nip46: nil, concord: concord
        )
    }

    private func event(kind: Int, tags: [[String]]) -> NostrEvent {
        NostrEvent.parse(signedEvent(
            secretKeyHex: vectorString("bobSk"), kind: kind, tags: tags, content: ""
        ))!
    }

    private func concordStream() -> ConcordStream {
        let concord = vectorObject("concord")
        return ConcordStream(
            pubkey: concord["streamPk"] as! String,
            conversationKey: concord["convKey"] as! String,
            epoch: concord["epoch"] as! String,
            communityId: "cc",
            channelId: concord["channelId"] as! String,
            banned: []
        )
    }

    func testScopeComesFromTheEvent() {
        let cfg = config()
        XCTAssertEqual(PushProcessor.scope(of: event(kind: 1059, tags: [["p", self_]]), config: cfg), .dm)
        XCTAssertNil(
            PushProcessor.scope(of: event(kind: 1059, tags: [["p", "b"]]), config: cfg),
            "a wrap for somebody else is not ours to place"
        )
        XCTAssertEqual(PushProcessor.scope(of: event(kind: 4, tags: []), config: cfg), .dm)
        XCTAssertEqual(PushProcessor.scope(of: event(kind: 9, tags: [["h", "g"]]), config: cfg), .group)
        XCTAssertEqual(
            PushProcessor.scope(of: event(kind: 1111, tags: [["h", "g"], ["p", self_]]), config: cfg),
            .groupMention
        )
        XCTAssertNil(PushProcessor.scope(of: event(kind: 9, tags: [["h", "a"], ["h", "b"]]), config: cfg))
        XCTAssertNil(PushProcessor.scope(of: event(kind: 1, tags: [["h", "g"]]), config: cfg))

        let stream = concordStream()
        let wrap = NostrEvent.parse(vectorObject("concord")["wrap"] as! [String: Any])!
        XCTAssertEqual(PushProcessor.scope(of: wrap, config: config(concord: [stream])), .c2)
    }

    func testRefusesAnythingButANappPayload() {
        let processor = PushProcessor(store: nil, config: config(), now: 1_700_000_000)
        let ev = signedEvent(secretKeyHex: vectorString("bobSk"), kind: 9, tags: [["h", "g"]], content: "x")
        XCTAssertNil(processor.prepare(userInfo: ["scope": "group", "event": ev]))
        var mismatched = napp(ev)
        mismatched["event_id"] = String(repeating: "0", count: 64)
        XCTAssertNil(processor.prepare(userInfo: mismatched), "the event must be the one the payload names")
    }

    func testFetchesAnEventThatWasNotInlined() {
        let ev = signedEvent(secretKeyHex: vectorString("bobSk"), kind: 9, tags: [["h", "g"]], content: "long")
        var asked: (String, [String])?
        let processor = PushProcessor(
            store: nil, config: config(), now: 1_700_000_000,
            fetch: { id, relays in
                asked = (id, relays)
                return ev
            }
        )
        var payload = napp(ev, relays: ["wss://relay.example"])
        payload.removeValue(forKey: "event")

        let prepared = processor.prepare(userInfo: payload)
        XCTAssertEqual(asked?.0, ev["id"] as? String)
        XCTAssertEqual(asked?.1, ["wss://relay.example"])
        XCTAssertEqual(prepared?.body, "Anonymous: long")
    }

    func testAFetchedEventIsCheckedLikeAnInlinedOne() {
        let ev = signedEvent(secretKeyHex: vectorString("bobSk"), kind: 9, tags: [["h", "g"]], content: "x")
        var tampered = ev
        tampered["content"] = "y"
        let processor = PushProcessor(
            store: nil, config: config(), now: 1_700_000_000, fetch: { _, _ in tampered }
        )
        var payload = napp(ev, relays: ["wss://relay.example"])
        payload.removeValue(forKey: "event")
        XCTAssertNil(processor.prepare(userInfo: payload))
    }

    /// A DM this install cannot open — here, no key at all — still says it is
    /// a DM and opens the DM list, rather than the gateway's generic text.
    func testAnUnopenableDmGetsItsPlanesFallback() {
        let processor = PushProcessor(
            store: nil,
            config: PushConfig(
                policy: .generic, selfPubkey: vectorString("alicePk"), knownPeers: [],
                secretKey: nil, nip46: nil, concord: []
            ),
            now: 1_700_000_000
        )
        let prepared = processor.prepare(userInfo: napp(vectorObject("dmWrap")))
        XCTAssertEqual(prepared?.body, "New direct message")
        XCTAssertEqual(prepared?.path, "/dm")
        XCTAssertNil(prepared?.sender)
        XCTAssertEqual(prepared?.drop, false)
    }

    /// An unopenable Concord wrap still names its channel, since the stream
    /// that claimed it is known.
    func testAnUnopenableConcordWrapOpensItsChannel() {
        let real = concordStream()
        let wrongKey = ConcordStream(
            pubkey: real.pubkey,
            conversationKey: String(repeating: "1", count: 64),
            epoch: real.epoch,
            communityId: real.communityId,
            channelId: real.channelId,
            banned: []
        )
        let processor = PushProcessor(
            store: nil, config: config(concord: [wrongKey]), now: 1_700_000_500
        )
        let wrap = vectorObject("concord")["wrap"] as! [String: Any]
        let prepared = processor.prepare(userInfo: napp(wrap))
        XCTAssertEqual(prepared?.body, "New message in a community")
        XCTAssertEqual(prepared?.path, "/c/cc/\(real.channelId)")
    }
}
