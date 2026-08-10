import CArmadaSecp256k1
import Foundation

/// The elliptic-curve half of Nostr: NIP-44 conversation keys (ECDH) and the
/// BIP-340 Schnorr verify that authenticates a Concord seal.
///
/// Curve arithmetic is never hand-rolled — it delegates to the vendored
/// libsecp256k1, the same audited library Bitcoin Core uses and the same one
/// Android reaches through ACINQ's bindings (`NostrCrypto.java`). Wire
/// compatibility with the WebView (nostr-tools / @noble/curves) is what the
/// test vectors pin.
enum Secp256k1 {

    /// One process-wide context. libsecp256k1 contexts are expensive to build
    /// (they precompute tables) and are documented as safe to share between
    /// threads for verification and ECDH, which is all this does.
    private static let context: OpaquePointer = {
        guard let ctx = secp256k1_context_create(UInt32(SECP256K1_CONTEXT_NONE)) else {
            fatalError("libsecp256k1 context allocation failed")
        }
        return ctx
    }()

    /// The NIP-44 v2 conversation key between `sk` and an x-only peer pubkey:
    /// `HKDF-Extract(salt: "nip44-v2", ikm: ECDH_x(sk, lift_x(peer)))`.
    ///
    /// Symmetric — `conv(a, B) == conv(b, A)` — and nil on any invalid input
    /// (bad hex, an x that is not on the curve) rather than throwing.
    ///
    /// Uses the raw shared-point x-coordinate via scalar point multiplication,
    /// NOT libsecp's `ecdh` helper, which returns a SHA-256 OF the point; NIP-44
    /// hashes the bare x itself. The even-Y lift (the `0x02` prefix) matches
    /// nostr-tools: a point and its negation share an x, so the peer's true Y
    /// parity cannot change the result.
    static func conversationKey(secretKey sk: [UInt8], peerPubkeyHex: String) -> [UInt8]? {
        guard sk.count == 32, let x = Hex.decode(peerPubkeyHex), x.count == 32 else { return nil }

        var compressed = [UInt8](repeating: 0, count: 33)
        compressed[0] = 0x02
        for i in 0..<32 { compressed[1 + i] = x[i] }

        var pubkey = secp256k1_pubkey()
        guard secp256k1_ec_pubkey_parse(context, &pubkey, compressed, 33) == 1 else { return nil }
        guard secp256k1_ec_pubkey_tweak_mul(context, &pubkey, sk) == 1 else { return nil }

        var serialized = [UInt8](repeating: 0, count: 33)
        var length = 33
        guard secp256k1_ec_pubkey_serialize(
            context, &serialized, &length, &pubkey, UInt32(SECP256K1_EC_COMPRESSED)
        ) == 1, length == 33 else { return nil }

        let sharedX = Array(serialized[1..<33])
        return Crypto.hkdfExtract(salt: [UInt8]("nip44-v2".utf8), ikm: sharedX)
    }

    /// The x-only (BIP-340 / Nostr) public key for a secret key, hex.
    ///
    /// Only ever used for the NIP-46 CLIENT key — the key that addresses the
    /// user's bunker. The identity key is never on this device for the logins
    /// this path exists to serve.
    static func xonlyPublicKey(secretKey sk: [UInt8]) -> String? {
        guard sk.count == 32 else { return nil }
        var keypair = secp256k1_keypair()
        guard secp256k1_keypair_create(context, &keypair, sk) == 1 else { return nil }
        var xonly = secp256k1_xonly_pubkey()
        guard secp256k1_keypair_xonly_pub(context, &xonly, nil, &keypair) == 1 else { return nil }
        var serialized = [UInt8](repeating: 0, count: 32)
        guard secp256k1_xonly_pubkey_serialize(context, &serialized, &xonly) == 1 else { return nil }
        return Hex.encode(serialized)
    }

    /// Sign a 32-byte message hash per BIP-340, returning the 64-byte signature
    /// as hex. Used for exactly one thing: the kind-24133 event carrying an RPC
    /// to the bunker.
    static func schnorrSign(message: [UInt8], secretKey sk: [UInt8]) -> String? {
        guard message.count == 32, sk.count == 32 else { return nil }
        var keypair = secp256k1_keypair()
        guard secp256k1_keypair_create(context, &keypair, sk) == 1 else { return nil }

        // BIP-340's auxiliary randomness. Not load-bearing for correctness —
        // the signature verifies either way — but it is the side-channel
        // hardening the spec asks for, so it is real randomness rather than a
        // zero block.
        var generator = SystemRandomNumberGenerator()
        let aux = (0..<32).map { _ in UInt8.random(in: UInt8.min...UInt8.max, using: &generator) }

        var signature = [UInt8](repeating: 0, count: 64)
        guard secp256k1_schnorrsig_sign32(context, &signature, message, &keypair, aux) == 1 else {
            return nil
        }
        return Hex.encode(signature)
    }

    /// Verify a 64-byte BIP-340 signature over `message` for an x-only pubkey.
    /// False (never a throw) on any malformed input.
    static func schnorrVerify(message: [UInt8], pubkeyHex: String, signatureHex: String) -> Bool {
        guard message.count == 32,
              let pk = Hex.decode(pubkeyHex), pk.count == 32,
              let sig = Hex.decode(signatureHex), sig.count == 64
        else { return false }

        var xonly = secp256k1_xonly_pubkey()
        guard secp256k1_xonly_pubkey_parse(context, &xonly, pk) == 1 else { return false }
        return secp256k1_schnorrsig_verify(context, sig, message, 32, &xonly) == 1
    }
}
