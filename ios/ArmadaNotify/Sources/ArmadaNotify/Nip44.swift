import Foundation

/// NIP-44 v2 decryption under a raw 32-byte conversation key.
///
/// Wire format, after base64-decoding the payload:
/// `[version=2 (1)] [nonce (32)] [ciphertext (n)] [mac (32)]`. Message keys are
/// `HKDF-Expand(SHA-256, conversationKey, info: nonce, 76)` split into
/// `chacha_key[0..32]`, `chacha_nonce[32..44]`, `hmac_key[44..76]`, and the MAC
/// is `HMAC-SHA256(hmac_key, nonce || ciphertext)`.
///
/// Decrypt only. The extension never encrypts anything: it has no reason to
/// publish, and a decrypt-only surface cannot leak a key through a nonce reuse
/// bug it does not contain. Ported from `ConcordCrypto.java`.
enum Nip44 {

    /// Decrypt a base64 payload, or nil on any malformed input, MAC mismatch or
    /// decode failure. Never throws — every caller here treats an unopenable
    /// payload as "not ours", which is indistinguishable from "corrupt" and
    /// must be handled the same way regardless.
    static func decrypt(conversationKey: [UInt8], payloadBase64: String) -> String? {
        guard conversationKey.count == 32 else { return nil }
        // A leading '#' is NIP-44's explicit "unsupported future version" marker
        // and is not base64 at all.
        guard let first = payloadBase64.first, first != "#" else { return nil }
        guard let data = Data(base64Encoded: payloadBase64) else { return nil }

        let bytes = [UInt8](data)
        // version(1) + nonce(32) + minimum ciphertext(32) + mac(32).
        guard bytes.count >= 99, bytes[0] == 2 else { return nil }

        let nonce = Array(bytes[1..<33])
        let ciphertext = Array(bytes[33..<(bytes.count - 32)])
        let mac = Array(bytes[(bytes.count - 32)...])

        let keys = Crypto.hkdfExpand(prk: conversationKey, info: nonce, length: 76)
        guard keys.count == 76 else { return nil }
        let chachaKey = Array(keys[0..<32])
        let chachaNonce = Array(keys[32..<44])
        let hmacKey = Array(keys[44..<76])

        let expected = Crypto.hmacSha256(key: hmacKey, message: nonce + ciphertext)
        guard Crypto.constantTimeEquals(expected, mac) else { return nil }

        return unpad(Crypto.chacha20(key: chachaKey, nonce: chachaNonce, input: ciphertext))
    }

    /// Strip NIP-44 padding: `[u16-BE len][plaintext][zeros]`, with the extended
    /// u32 form (a zero u16 followed by a u32) for lengths from 65536.
    private static func unpad(_ padded: [UInt8]) -> String? {
        guard padded.count >= 2 else { return nil }
        let firstTwo = Int(padded[0]) << 8 | Int(padded[1])

        let unpaddedLength: Int
        let prefixLength: Int
        if firstTwo == 0 {
            guard padded.count >= 6 else { return nil }
            unpaddedLength = Int(padded[2]) << 24 | Int(padded[3]) << 16
                | Int(padded[4]) << 8 | Int(padded[5])
            prefixLength = 6
        } else {
            unpaddedLength = firstTwo
            prefixLength = 2
        }

        guard unpaddedLength >= 1, prefixLength + unpaddedLength <= padded.count else { return nil }
        return String(
            decoding: padded[prefixLength..<(prefixLength + unpaddedLength)],
            as: UTF8.self
        )
    }
}
