import Foundation

/// The hash/cipher primitives NIP-44 is built from, in pure Swift.
///
/// Hand-written rather than taken from CryptoKit for one reason: NIP-44 needs
/// RAW ChaCha20, and CryptoKit only exposes ChaChaPoly (the AEAD). Reaching for
/// CryptoKit where it fits would leave the cipher hand-written anyway, and the
/// hash chain split across two implementations — one compiled on Apple
/// platforms and one for the Linux test suite, which is the arrangement where a
/// suite passes against code the extension never runs.
///
/// Ported from `ConcordCrypto.java`, the Android background service's copy of
/// the same primitives, and pinned to the same vectors.
enum Crypto {

    // MARK: - SHA-256 (FIPS 180-4)

    private static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    static func sha256(_ message: [UInt8]) -> [UInt8] {
        var h: [UInt32] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ]

        var padded = message
        let bitLength = UInt64(message.count) * 8
        padded.append(0x80)
        while padded.count % 64 != 56 { padded.append(0) }
        for shift in stride(from: 56, through: 0, by: -8) {
            padded.append(UInt8(truncatingIfNeeded: bitLength >> UInt64(shift)))
        }

        var w = [UInt32](repeating: 0, count: 64)
        var chunk = padded.startIndex
        while chunk < padded.endIndex {
            for i in 0..<16 {
                let o = chunk + i * 4
                w[i] = (UInt32(padded[o]) << 24) | (UInt32(padded[o + 1]) << 16)
                    | (UInt32(padded[o + 2]) << 8) | UInt32(padded[o + 3])
            }
            for i in 16..<64 {
                let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
                let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
                w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
            }

            var a = h[0], b = h[1], c = h[2], d = h[3]
            var e = h[4], f = h[5], g = h[6], hh = h[7]

            for i in 0..<64 {
                let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                let ch = (e & f) ^ (~e & g)
                let temp1 = hh &+ s1 &+ ch &+ k[i] &+ w[i]
                let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                let maj = (a & b) ^ (a & c) ^ (b & c)
                let temp2 = s0 &+ maj

                hh = g; g = f; f = e; e = d &+ temp1
                d = c; c = b; b = a; a = temp1 &+ temp2
            }

            h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
            h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
            chunk += 64
        }

        var out = [UInt8]()
        out.reserveCapacity(32)
        for value in h {
            out.append(UInt8(truncatingIfNeeded: value >> 24))
            out.append(UInt8(truncatingIfNeeded: value >> 16))
            out.append(UInt8(truncatingIfNeeded: value >> 8))
            out.append(UInt8(truncatingIfNeeded: value))
        }
        return out
    }

    static func sha256(_ string: String) -> [UInt8] {
        sha256([UInt8](string.utf8))
    }

    private static func rotr(_ value: UInt32, _ by: UInt32) -> UInt32 {
        (value >> by) | (value << (32 - by))
    }

    // MARK: - HMAC-SHA256 (RFC 2104)

    static func hmacSha256(key: [UInt8], message: [UInt8]) -> [UInt8] {
        let blockSize = 64
        var normalized = key
        if normalized.count > blockSize { normalized = sha256(normalized) }
        if normalized.count < blockSize {
            normalized.append(contentsOf: [UInt8](repeating: 0, count: blockSize - normalized.count))
        }

        var inner = [UInt8](repeating: 0, count: blockSize)
        var outer = [UInt8](repeating: 0, count: blockSize)
        for i in 0..<blockSize {
            inner[i] = normalized[i] ^ 0x36
            outer[i] = normalized[i] ^ 0x5c
        }
        return sha256(outer + sha256(inner + message))
    }

    // MARK: - HKDF (RFC 5869)

    /// `HKDF-Extract` — the conversation key's outer step, with the salt as the
    /// HMAC key (NIP-44 uses the literal salt "nip44-v2").
    static func hkdfExtract(salt: [UInt8], ikm: [UInt8]) -> [UInt8] {
        hmacSha256(key: salt, message: ikm)
    }

    /// `HKDF-Expand` with SHA-256, for `length` bytes of output.
    static func hkdfExpand(prk: [UInt8], info: [UInt8], length: Int) -> [UInt8] {
        let hashLen = 32
        guard length > 0, length <= 255 * hashLen else { return [] }
        var okm = [UInt8]()
        var t = [UInt8]()
        var counter: UInt8 = 1
        while okm.count < length {
            t = hmacSha256(key: prk, message: t + info + [counter])
            okm.append(contentsOf: t)
            counter &+= 1
        }
        return Array(okm[0..<length])
    }

    // MARK: - ChaCha20 (RFC 8439)

    /// ChaCha20 keystream XOR, IETF variant: 256-bit key, 96-bit nonce, 32-bit
    /// block counter starting at ZERO — matching `@noble/ciphers`' `chacha20`,
    /// which is what nostr-tools' NIP-44 uses. A counter starting at 1 (the
    /// AEAD convention, where block 0 is spent on the Poly1305 key) would
    /// decrypt to garbage.
    static func chacha20(key: [UInt8], nonce: [UInt8], input: [UInt8]) -> [UInt8] {
        precondition(key.count == 32 && nonce.count == 12)
        var state = [UInt32](repeating: 0, count: 16)
        state[0] = 0x61707865
        state[1] = 0x3320646e
        state[2] = 0x79622d32
        state[3] = 0x6b206574
        for i in 0..<8 { state[4 + i] = leUInt32(key, i * 4) }
        state[12] = 0
        state[13] = leUInt32(nonce, 0)
        state[14] = leUInt32(nonce, 4)
        state[15] = leUInt32(nonce, 8)

        var out = [UInt8](repeating: 0, count: input.count)
        var block = [UInt8](repeating: 0, count: 64)
        var offset = 0
        while offset < input.count {
            chachaBlock(state, &block)
            let n = min(64, input.count - offset)
            for i in 0..<n { out[offset + i] = input[offset + i] ^ block[i] }
            offset += n
            state[12] = state[12] &+ 1
        }
        return out
    }

    private static func chachaBlock(_ state: [UInt32], _ out: inout [UInt8]) {
        var x = state
        for _ in 0..<10 {
            quarterRound(&x, 0, 4, 8, 12)
            quarterRound(&x, 1, 5, 9, 13)
            quarterRound(&x, 2, 6, 10, 14)
            quarterRound(&x, 3, 7, 11, 15)
            quarterRound(&x, 0, 5, 10, 15)
            quarterRound(&x, 1, 6, 11, 12)
            quarterRound(&x, 2, 7, 8, 13)
            quarterRound(&x, 3, 4, 9, 14)
        }
        for i in 0..<16 {
            let v = x[i] &+ state[i]
            out[i * 4] = UInt8(truncatingIfNeeded: v)
            out[i * 4 + 1] = UInt8(truncatingIfNeeded: v >> 8)
            out[i * 4 + 2] = UInt8(truncatingIfNeeded: v >> 16)
            out[i * 4 + 3] = UInt8(truncatingIfNeeded: v >> 24)
        }
    }

    private static func quarterRound(_ x: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int) {
        x[a] = x[a] &+ x[b]; x[d] ^= x[a]; x[d] = rotl(x[d], 16)
        x[c] = x[c] &+ x[d]; x[b] ^= x[c]; x[b] = rotl(x[b], 12)
        x[a] = x[a] &+ x[b]; x[d] ^= x[a]; x[d] = rotl(x[d], 8)
        x[c] = x[c] &+ x[d]; x[b] ^= x[c]; x[b] = rotl(x[b], 7)
    }

    private static func rotl(_ value: UInt32, _ by: UInt32) -> UInt32 {
        (value << by) | (value >> (32 - by))
    }

    private static func leUInt32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        UInt32(bytes[offset])
            | (UInt32(bytes[offset + 1]) << 8)
            | (UInt32(bytes[offset + 2]) << 16)
            | (UInt32(bytes[offset + 3]) << 24)
    }

    // MARK: - Comparison

    /// Length-independent, value-constant-time equality for MACs.
    static func constantTimeEquals(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }
}

// MARK: - Hex

enum Hex {
    private static let digits: [Character] = Array("0123456789abcdef")

    static func encode(_ bytes: [UInt8]) -> String {
        var out = String()
        out.reserveCapacity(bytes.count * 2)
        for byte in bytes {
            out.append(digits[Int(byte >> 4)])
            out.append(digits[Int(byte & 0x0f)])
        }
        return out
    }

    /// Decode a hex string, or nil on any malformed input (odd length, non-hex).
    static func decode(_ hex: String) -> [UInt8]? {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        out.reserveCapacity(chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30            // 0-9
        case 0x61...0x66: return c - 0x61 + 10       // a-f
        case 0x41...0x46: return c - 0x41 + 10       // A-F
        default: return nil
        }
    }
}
