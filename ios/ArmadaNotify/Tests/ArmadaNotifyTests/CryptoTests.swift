import XCTest

@testable import ArmadaNotify

/// The primitives, against published vectors and against the app's own
/// libraries. These are the tests that matter most in this package: everything
/// above them assumes a byte-exact NIP-44, and a hash chain that is subtly
/// wrong fails as "the message never opens", which looks exactly like "not
/// addressed to us" and would never be reported as a bug.
final class CryptoTests: XCTestCase {

    // MARK: - SHA-256

    func testSha256KnownVectors() {
        XCTAssertEqual(
            Hex.encode(Crypto.sha256([])),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
        XCTAssertEqual(
            Hex.encode(Crypto.sha256("abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
        // 56 bytes: the length that forces a second padding block.
        XCTAssertEqual(
            Hex.encode(Crypto.sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        )
    }

    func testSha256MatchesTheGeneratorsVectors() {
        XCTAssertEqual(Hex.encode(Crypto.sha256([])), vectorString("sha256_empty"))
        XCTAssertEqual(Hex.encode(Crypto.sha256("abc")), vectorString("sha256_abc"))
    }

    func testSha256AcrossBlockBoundaries() {
        // A million 'a' is the classic long input; a shorter multi-block run is
        // enough here and keeps the suite fast.
        let input = String(repeating: "a", count: 1000)
        XCTAssertEqual(
            Hex.encode(Crypto.sha256(input)),
            "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
        )
    }

    // MARK: - HMAC / HKDF

    func testHmacSha256Rfc4231() {
        // RFC 4231 test case 1.
        let key = [UInt8](repeating: 0x0b, count: 20)
        XCTAssertEqual(
            Hex.encode(Crypto.hmacSha256(key: key, message: [UInt8]("Hi There".utf8))),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        )
    }

    func testHmacSha256WithAnOversizedKey() {
        // RFC 4231 test case 6: a key longer than the block size is hashed first.
        let key = [UInt8](repeating: 0xaa, count: 131)
        let message = [UInt8]("Test Using Larger Than Block-Size Key - Hash Key First".utf8)
        XCTAssertEqual(
            Hex.encode(Crypto.hmacSha256(key: key, message: message)),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        )
    }

    func testHkdfExpandRfc5869() {
        // RFC 5869 test case 1's expand half.
        let prk = Hex.decode("077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5")!
        let info = Hex.decode("f0f1f2f3f4f5f6f7f8f9")!
        XCTAssertEqual(
            Hex.encode(Crypto.hkdfExpand(prk: prk, info: info, length: 42)),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        )
    }

    // MARK: - ChaCha20

    func testChaCha20StartsAtBlockZeroAndIncrements() {
        // Encrypting 128 zero bytes exposes the raw keystream of the first two
        // blocks, which pins the two things that actually differ between
        // implementations: WHERE the counter starts, and that it increments.
        //
        // NIP-44 starts at 0 (via @noble's `chacha20`), while RFC 8439's own
        // §2.3.2 vector — and CryptoKit's ChaChaPoly, which spends block 0 on
        // the Poly1305 key — starts at 1. That published block is the SECOND
        // half of this expectation, which is what makes the first half's
        // provenance legible: same key, same nonce, one block earlier.
        let key = (0..<32).map { UInt8($0) }
        let nonce: [UInt8] = [0, 0, 0, 9, 0, 0, 0, 74, 0, 0, 0, 0]
        let keystream = Crypto.chacha20(
            key: key, nonce: nonce, input: [UInt8](repeating: 0, count: 128)
        )

        let blockZero = "8adc91fd9ff4f0f51b0fad50ff15d637e40efda206cc52c783a74200503c1582"
            + "cd9833367d0a54d57d3c9e998f490ee69ca34c1ff9e939a75584c52d690a35d4"
        let blockOne = "10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e"
            + "d2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e"

        XCTAssertEqual(Hex.encode(Array(keystream[0..<64])), blockZero)
        XCTAssertEqual(Hex.encode(Array(keystream[64..<128])), blockOne)
    }

    func testChaCha20IsItsOwnInverse() {
        let key = [UInt8](repeating: 7, count: 32)
        let nonce = [UInt8](repeating: 3, count: 12)
        // Longer than one block, and not a block multiple, so the counter
        // increment and the partial tail are both exercised.
        let plaintext = [UInt8](String(repeating: "armada", count: 40).utf8)
        let ciphertext = Crypto.chacha20(key: key, nonce: nonce, input: plaintext)
        XCTAssertNotEqual(ciphertext, plaintext)
        XCTAssertEqual(Crypto.chacha20(key: key, nonce: nonce, input: ciphertext), plaintext)
    }

    // MARK: - Hex

    func testHexRoundTrip() {
        XCTAssertEqual(Hex.encode([0x00, 0x0f, 0xff, 0xa5]), "000fffa5")
        XCTAssertEqual(Hex.decode("000FFFA5")!, [0x00, 0x0f, 0xff, 0xa5])
        XCTAssertNil(Hex.decode("abc"), "odd length")
        XCTAssertNil(Hex.decode("zz"), "not hex")
    }
}
