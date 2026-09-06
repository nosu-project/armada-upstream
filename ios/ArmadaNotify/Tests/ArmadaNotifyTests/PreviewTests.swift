import XCTest

@testable import ArmadaNotify

/// The text a notification actually shows. Ported alongside
/// `src/lib/notificationPreview.ts`, and these assertions are the ones that
/// keep the three notifiers reading the same way.
final class PreviewTests: XCTestCase {

    private func message(
        plane: NotificationPreview.Plane = .c2,
        kind: Int = 9,
        content: String,
        author: String = "alex",
        room: String? = "Armada / #general",
        mention: Bool = false,
        reaction: Bool = false,
        threadReply: Bool = false,
        imetaMime: String? = nil,
        names: [String: String] = [:]
    ) -> NotificationPreview.Message {
        NotificationPreview.Message(
            plane: plane, kind: kind, content: content, authorName: author, roomTitle: room,
            mention: mention, reaction: reaction, threadReply: threadReply,
            imetaMime: imetaMime, mentionNames: names
        )
    }

    // MARK: - Content cleaning

    func testStripsInlineMediaUrls() {
        XCTAssertEqual(
            NotificationPreview.cleanContent("lol https://blossom.example/abcd.jpg"),
            "lol"
        )
        XCTAssertEqual(
            NotificationPreview.cleanContent("a https://x.example/p.png b"),
            "a b"
        )
    }

    func testKeepsNonMediaLinks() {
        let content = "read https://example.com/article"
        XCTAssertEqual(NotificationPreview.cleanContent(content), content)
    }

    func testStripsMediaUrlsCarryingAQueryString() {
        XCTAssertEqual(
            NotificationPreview.cleanContent("see https://x.example/a.png?w=100 now"),
            "see now"
        )
    }

    // MARK: - Media labels

    func testNamesTheMediaWhenStrippingLeftNothing() {
        let msg = message(content: "https://blossom.example/abcd.jpg")
        XCTAssertEqual(NotificationPreview.messageLine(msg), "Sent an image")
    }

    func testImetaMimeWinsOverTheUrlExtension() {
        // An encrypted attachment's blob URL carries no extension at all, and a
        // voice message in a .webm container is only audio by its MIME.
        let msg = message(content: "https://blossom.example/opaque.webm", imetaMime: "audio/webm")
        XCTAssertEqual(NotificationPreview.messageLine(msg), "Sent a voice message")
    }

    func testDistinguishesGifsAndGames() {
        XCTAssertEqual(
            NotificationPreview.mediaLabel(imetaMime: "image/gif", content: ""), "a GIF"
        )
        XCTAssertEqual(
            NotificationPreview.mediaLabel(imetaMime: nil, content: "https://x.example/a.xdc"),
            "a game"
        )
    }

    // MARK: - Message lines

    func testAReactionNamesTheEmoji() {
        XCTAssertEqual(
            NotificationPreview.messageLine(message(kind: 7, content: "+", reaction: true)),
            "Reacted 👍 to your message"
        )
        XCTAssertEqual(
            NotificationPreview.messageLine(message(kind: 7, content: "-", reaction: true)),
            "Reacted 👎 to your message"
        )
        XCTAssertEqual(
            NotificationPreview.messageLine(message(kind: 7, content: ":party:", reaction: true)),
            "Reacted party to your message"
        )
    }

    func testAThreadReplyIsPrefixed() {
        let msg = message(content: "sure", threadReply: true)
        XCTAssertEqual(NotificationPreview.messageLine(msg), "Replied in thread: sure")
    }

    func testAMentionSaysSoWhereTheRoomIsTheTitle() {
        XCTAssertEqual(
            NotificationPreview.messageLine(message(content: "ping", mention: true)),
            "@you ping"
        )
        // A DM's title IS the sender, so there is no room for "@you" to
        // disambiguate against.
        XCTAssertEqual(
            NotificationPreview.messageLine(
                message(plane: .dm, kind: 14, content: "ping", room: nil, mention: true)
            ),
            "ping"
        )
    }

    func testFallsBackByPlane() {
        XCTAssertEqual(
            NotificationPreview.messageLine(message(plane: .dm, kind: 14, content: "", room: nil)),
            "Sent you a direct message"
        )
        XCTAssertEqual(NotificationPreview.messageLine(message(content: "")), "Sent a message")
        XCTAssertEqual(
            NotificationPreview.messageLine(message(plane: .dm, kind: 15, content: "", room: nil)),
            "Sent a file"
        )
    }

    func testElidesLongBodies() {
        let line = NotificationPreview.messageLine(
            message(content: String(repeating: "x", count: 400))
        )
        XCTAssertEqual(line.count, NotificationPreview.contentCap)
        XCTAssertTrue(line.hasSuffix("…"))
    }

    // MARK: - Presentation shape

    func testARoomTitlesTheNotificationAndAttributesTheLine() {
        let presented = NotificationPreview.present(message(content: "shipped it"))
        XCTAssertEqual(presented.title, "Armada / #general")
        XCTAssertEqual(presented.body, "alex: shipped it")
    }

    func testADmIsTitledByItsSenderWithABareBody() {
        let presented = NotificationPreview.present(
            message(plane: .dm, kind: 14, content: "hey", room: nil)
        )
        XCTAssertEqual(presented.title, "alex")
        XCTAssertEqual(presented.body, "hey")
    }

    func testAnUnnamedRoomFallsBackToChat() {
        let presented = NotificationPreview.present(message(content: "hi", room: nil))
        XCTAssertEqual(presented.title, "Chat")
    }

    // MARK: - Thread replies + imeta

    func testThreadReplyDetection() {
        XCTAssertTrue(NotificationPreview.isThreadReply(kind: 1111, tags: []))
        XCTAssertTrue(NotificationPreview.isThreadReply(kind: 9, tags: [["E", "root"]]))
        XCTAssertFalse(NotificationPreview.isThreadReply(kind: 9, tags: [["E", ""]]))
        XCTAssertFalse(NotificationPreview.isThreadReply(kind: 9, tags: [["e", "parent"]]))
    }

    func testFirstImetaMime() {
        let tags = [["imeta", "url https://x.example/a", "m image/png"]]
        XCTAssertEqual(NotificationPreview.firstImetaMime(tags), "image/png")
        XCTAssertNil(NotificationPreview.firstImetaMime([["imeta", "url https://x.example/a"]]))
    }

    // MARK: - Mentions

    /// nostr-tools' encoding of `alicePk`, and its nprofile form.
    private let npub = "npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul"
    private let nprofile = "nprofile1qyfhwumn8ghj7un9d3shjtn90psk6urvv5qzqxuyc4t8kynygzv460k4"
        + "42aq2ewhrcvrgczgr8lec9l4a82a6pu0u6p49g"

    func testDecodesAnNpubToItsHexPubkey() {
        XCTAssertEqual(Bech32.mentionPubkey(npub), vectorString("alicePk"))
        XCTAssertEqual(Bech32.mentionPubkey("nostr:\(npub)"), vectorString("alicePk"))
    }

    /// The encode direction, against the same nostr-tools-generated vector the
    /// decode test reads — so a DM deep link's `/dm/<npub>` is the string the
    /// web client would have written, not merely something that round-trips
    /// through this file.
    func testEncodesAHexPubkeyAsItsNpub() {
        XCTAssertEqual(Bech32.npub(vectorString("alicePk")), npub)
        XCTAssertEqual(Bech32.mentionPubkey(Bech32.npub(vectorString("alicePk"))!),
                       vectorString("alicePk"))
    }

    func testRefusesToEncodeAnythingThatIsNotAPubkey() {
        XCTAssertNil(Bech32.npub(""))
        XCTAssertNil(Bech32.npub("nope"))
        // Right length, not hex.
        XCTAssertNil(Bech32.npub(String(repeating: "z", count: 64)))
        // Hex, wrong length.
        XCTAssertNil(Bech32.npub(String(repeating: "ab", count: 16)))
    }

    func testDecodesAnNprofileByWalkingItsTlv() {
        // The pubkey is TLV type 0; the relay hints beside it are skipped.
        XCTAssertEqual(Bech32.mentionPubkey(nprofile), vectorString("alicePk"))
    }

    func testResolvesAMentionToAName() {
        let cleaned = NotificationPreview.cleanContent(
            "hi nostr:\(npub) there", names: [vectorString("alicePk"): "bob"]
        )
        XCTAssertEqual(cleaned, "hi @bob there")
    }

    func testLeavesAnUnnameableMentionAlone() {
        let cleaned = NotificationPreview.cleanContent("hi nostr:\(npub) there")
        XCTAssertEqual(cleaned, "hi nostr:\(npub) there")
    }

    func testRejectsABadChecksum() {
        // One character changed — showing the wrong person's name would be
        // worse than showing the raw token, so a bad checksum decodes to
        // nothing rather than to a near miss.
        let broken = "npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wuq"
        XCTAssertNil(Bech32.mentionPubkey(broken))
    }
}
