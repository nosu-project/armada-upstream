import XCTest

@testable import ArmadaNotify

/// The bunker path: the crypto it adds, and the seam it plugs into.
///
/// The socket itself is not exercised here — a live bunker is not a unit test.
/// What IS pinned is everything that would be silently wrong without a bunker
/// to complain: the encrypt direction of NIP-44, Schnorr signing against the
/// verifier that already has vectors, and that `Dm17.open` applies exactly the
/// same refusals whichever side of the protocol holds the key.
final class Nip46Tests: XCTestCase {

    private var aliceSk: [UInt8] { Hex.decode(vectorString("aliceSk"))! }
    private var alicePk: String { vectorString("alicePk") }
    private var bobSk: [UInt8] { Hex.decode(vectorString("bobSk"))! }
    private var bobPk: String { vectorString("bobPk") }
    private var dmWrap: NostrEvent { NostrEvent.parse(vectorObject("dmWrap"))! }
    private let now = 1_700_001_000

    // MARK: - NIP-44 encrypt

    func testEncryptRoundTripsThroughDecrypt() {
        let key = Hex.decode(vectorString("convKey"))!
        let payload = Nip44.encrypt(conversationKey: key, plaintext: "hello é 🚀")
        XCTAssertNotNil(payload)
        XCTAssertEqual(Nip44.decrypt(conversationKey: key, payloadBase64: payload!), "hello é 🚀")
    }

    func testEncryptIsReadableByTheOtherPartysKey() {
        // The conversation key is symmetric, so what alice seals to bob, bob
        // opens with his own — which is the property the bunker RPC rides on.
        let mine = Secp256k1.conversationKey(secretKey: aliceSk, peerPubkeyHex: bobPk)!
        let theirs = Secp256k1.conversationKey(secretKey: bobSk, peerPubkeyHex: alicePk)!
        let payload = Nip44.encrypt(conversationKey: mine, plaintext: #"{"id":"x"}"#)!
        XCTAssertEqual(
            Nip44.decrypt(conversationKey: theirs, payloadBase64: payload), #"{"id":"x"}"#
        )
    }

    func testEncryptUsesAFreshNoncePerMessage() {
        // The message keys are derived from the nonce, so a repeat would reuse
        // a ChaCha20 keystream against a second plaintext.
        let key = Hex.decode(vectorString("convKey"))!
        let first = Nip44.encrypt(conversationKey: key, plaintext: "same")!
        let second = Nip44.encrypt(conversationKey: key, plaintext: "same")!
        XCTAssertNotEqual(first, second)
    }

    func testEncryptPadsToTheSpecsBuckets() {
        // A 1-byte and a 32-byte plaintext must produce the same length, or the
        // ciphertext leaks the message size.
        let key = Hex.decode(vectorString("convKey"))!
        let short = Nip44.encrypt(conversationKey: key, plaintext: "a")!
        let full = Nip44.encrypt(conversationKey: key, plaintext: String(repeating: "a", count: 32))!
        XCTAssertEqual(short.count, full.count)
        // And a 33-byte one must NOT — it lands in the next bucket.
        let over = Nip44.encrypt(conversationKey: key, plaintext: String(repeating: "a", count: 33))!
        XCTAssertGreaterThan(over.count, full.count)
    }

    func testEncryptRefusesAnEmptyPlaintext() {
        let key = Hex.decode(vectorString("convKey"))!
        XCTAssertNil(Nip44.encrypt(conversationKey: key, plaintext: ""))
    }

    // MARK: - Schnorr signing

    func testSignedEventsVerifyAgainstOurOwnVerifier() {
        // The verifier is already pinned by the Concord seal vectors, so a
        // signature it accepts is one a relay will accept too.
        let message = Crypto.sha256("armada")
        let pubkey = Secp256k1.xonlyPublicKey(secretKey: aliceSk)
        XCTAssertEqual(pubkey, alicePk, "x-only derivation must match nostr-tools")

        let signature = Secp256k1.schnorrSign(message: message, secretKey: aliceSk)
        XCTAssertNotNil(signature)
        XCTAssertTrue(
            Secp256k1.schnorrVerify(message: message, pubkeyHex: alicePk, signatureHex: signature!)
        )
        XCTAssertFalse(
            Secp256k1.schnorrVerify(message: message, pubkeyHex: bobPk, signatureHex: signature!)
        )
    }

    func testSigningRefusesMalformedInput() {
        XCTAssertNil(Secp256k1.schnorrSign(message: [1, 2, 3], secretKey: aliceSk))
        XCTAssertNil(Secp256k1.schnorrSign(message: Crypto.sha256("x"), secretKey: [1, 2, 3]))
        XCTAssertNil(Secp256k1.xonlyPublicKey(secretKey: []))
    }

    // MARK: - The decryptor seam

    /// Stands in for a bunker: answers with the same plaintext a local key
    /// would, and counts the calls.
    private final class FakeRemote: Nip44Decryptor {
        let secretKey: [UInt8]
        private(set) var calls = 0
        var failAfter = Int.max

        init(secretKey: [UInt8]) { self.secretKey = secretKey }

        func decrypt(pubkey: String, ciphertext: String) -> String? {
            calls += 1
            if calls > failAfter { return nil }
            return LocalDecryptor(secretKey: secretKey).decrypt(
                pubkey: pubkey, ciphertext: ciphertext
            )
        }
    }

    func testARemoteDecryptorOpensTheSameEnvelope() {
        let remote = FakeRemote(secretKey: aliceSk)
        let opened = Dm17.open(wrap: dmWrap, decryptor: remote, self: alicePk, now: now)
        XCTAssertEqual(opened?.author, bobPk)
        XCTAssertEqual(opened?.content, "hello from bob é 🚀")
        // Exactly two round-trips: the wrap, then the seal. A third would mean
        // the opener re-asking for something it already had, which on a real
        // bunker is a round-trip inside a notification's budget.
        XCTAssertEqual(remote.calls, 2)
    }

    func testABunkerThatGivesUpHalfwayOpensNothing() {
        // The seal decrypted but the rumor did not: no partial result, no
        // notification built from half an envelope.
        let remote = FakeRemote(secretKey: aliceSk)
        remote.failAfter = 1
        XCTAssertNil(Dm17.open(wrap: dmWrap, decryptor: remote, self: alicePk, now: now))
    }

    func testAnUnreachableBunkerCostsNothingButTheFallback() {
        let remote = FakeRemote(secretKey: aliceSk)
        remote.failAfter = 0
        XCTAssertNil(Dm17.open(wrap: dmWrap, decryptor: remote, self: alicePk, now: now))
        XCTAssertEqual(remote.calls, 1, "gives up on the first refusal")
    }

    func testTheRefusalsApplyToTheRemotePathToo() {
        // The point of the shared opener: a bunker login must not get a laxer
        // reader than an nsec login.
        var expired = dmWrap
        expired.tags.append(["expiration", String(now - 1)])
        XCTAssertNil(
            Dm17.open(
                wrap: expired, decryptor: FakeRemote(secretKey: aliceSk), self: alicePk, now: now
            )
        )

        var wrongKind = dmWrap
        wrongKind.kind = 1060
        XCTAssertNil(
            Dm17.open(
                wrap: wrongKind, decryptor: FakeRemote(secretKey: aliceSk), self: alicePk, now: now
            )
        )
    }

    // MARK: - Config

    func testParsesABunkerConfig() {
        let json = """
        {"policy":"generic","self":"\(alicePk)","knownPeers":[],
         "nip46":{"clientSk":"\(vectorString("bobSk"))","bunkerPubkey":"\(bobPk)",
         "relays":["wss://relay.example"]}}
        """
        let config = PushConfig.parse(json: json)
        XCTAssertNotNil(config?.nip46)
        XCTAssertEqual(config?.nip46?.bunkerPubkey, bobPk)
        XCTAssertEqual(config?.nip46?.relays, ["wss://relay.example"])
        XCTAssertNil(config?.secretKey, "a bunker login has no account key")
    }

    func testIgnoresAnIncompleteBunkerConfig() {
        // Half a bunker cannot be asked anything; treat it as absent rather
        // than build a client that can only fail.
        for body in [
            #"{"clientSk":"zz","bunkerPubkey":"x","relays":["wss://r"]}"#,
            #"{"bunkerPubkey":"x","relays":["wss://r"]}"#,
            "{\"clientSk\":\"\(vectorString("bobSk"))\",\"bunkerPubkey\":\"\(bobPk)\",\"relays\":[]}",
        ] {
            let json = #"{"policy":"generic","self":"\#(alicePk)","knownPeers":[],"nip46":\#(body)}"#
            XCTAssertNil(PushConfig.parse(json: json)?.nip46, body)
        }
    }
}
