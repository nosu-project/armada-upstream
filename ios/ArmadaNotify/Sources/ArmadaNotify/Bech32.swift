import Foundation

/// Just enough NIP-19 to turn a `npub1…` / `nprofile1…` mention into the hex
/// pubkey a name can be looked up by, and to spell a pubkey back as an npub
/// for the deep link a notification tap opens.
///
/// Only the person-shaped types: the others name events and relays, which no
/// notification body renders and no route here names.
enum Bech32 {

    private static let charset = Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l")

    /// A hex pubkey as its `npub1…` form, or nil when it isn't one.
    ///
    /// Encoding exists here for one reason: a DM deep link names its
    /// participants as npubs (`PushProcessor.dmPath`), matching the web
    /// client's `chatRoute` and the Android service's `dmRoute`. A route
    /// string is an identity elsewhere in the app, so a second spelling of it
    /// is a second name for the same conversation.
    static func npub(_ pubkeyHex: String) -> String? {
        guard let bytes = Hex.decode(pubkeyHex), bytes.count == 32 else { return nil }
        return encode(hrp: "npub", bytes: bytes)
    }

    private static func encode(hrp: String, bytes: [UInt8]) -> String? {
        guard let values = convertBits(bytes, from: 8, to: 5, pad: true) else { return nil }
        let combined = values + createChecksum(hrp: hrp, values: values)
        return hrp + "1" + String(combined.map { charset[Int($0)] })
    }

    private static func createChecksum(hrp: String, values: [UInt8]) -> [UInt8] {
        let checksum = polymod(hrpExpand(hrp) + values + [0, 0, 0, 0, 0, 0]) ^ 1
        return (0..<6).map { UInt8((checksum >> (5 * (5 - UInt32($0)))) & 31) }
    }

    /// The hex pubkey a NIP-27 mention token refers to, or nil when the token
    /// is not a valid, checksummed reference to a person. A bad checksum is
    /// left alone rather than guessed at — showing the wrong name is worse than
    /// showing the raw token.
    static func mentionPubkey(_ token: String) -> String? {
        var value = token
        if value.lowercased().hasPrefix("nostr:") { value = String(value.dropFirst(6)) }
        guard let (hrp, data) = decode(value.lowercased()) else { return nil }
        guard let bytes = convertBits(data, from: 5, to: 8, pad: false) else { return nil }

        switch hrp {
        case "npub":
            guard bytes.count == 32 else { return nil }
            return Hex.encode(bytes)
        case "nprofile":
            // TLV: type 0 is the 32-byte pubkey; every other type is skipped.
            var index = 0
            while index + 2 <= bytes.count {
                let type = bytes[index]
                let length = Int(bytes[index + 1])
                let valueStart = index + 2
                guard valueStart + length <= bytes.count else { return nil }
                if type == 0 {
                    guard length == 32 else { return nil }
                    return Hex.encode(Array(bytes[valueStart..<(valueStart + length)]))
                }
                index = valueStart + length
            }
            return nil
        default:
            return nil
        }
    }

    /// Decode a bech32 string into its human-readable part and 5-bit data,
    /// verifying the checksum. Accepts long strings — NIP-19 payloads routinely
    /// exceed BIP-173's 90-character limit, which is why it is not enforced.
    private static func decode(_ input: String) -> (hrp: String, data: [UInt8])? {
        guard let separator = input.lastIndex(of: "1") else { return nil }
        let hrp = String(input[input.startIndex..<separator])
        let dataPart = input[input.index(after: separator)...]
        guard !hrp.isEmpty, dataPart.count >= 6 else { return nil }

        var values = [UInt8]()
        values.reserveCapacity(dataPart.count)
        for character in dataPart {
            guard let index = charset.firstIndex(of: character) else { return nil }
            values.append(UInt8(index))
        }

        guard verifyChecksum(hrp: hrp, values: values) else { return nil }
        return (hrp, Array(values[0..<(values.count - 6)]))
    }

    private static func verifyChecksum(hrp: String, values: [UInt8]) -> Bool {
        polymod(hrpExpand(hrp) + values) == 1
    }

    private static func hrpExpand(_ hrp: String) -> [UInt8] {
        let bytes = [UInt8](hrp.utf8)
        return bytes.map { $0 >> 5 } + [0] + bytes.map { $0 & 31 }
    }

    private static func polymod(_ values: [UInt8]) -> UInt32 {
        let generator: [UInt32] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
        var checksum: UInt32 = 1
        for value in values {
            let top = checksum >> 25
            checksum = ((checksum & 0x1ffffff) << 5) ^ UInt32(value)
            for i in 0..<5 where (top >> UInt32(i)) & 1 == 1 {
                checksum ^= generator[i]
            }
        }
        return checksum
    }

    /// Regroup bits, the standard bech32 helper.
    private static func convertBits(
        _ data: [UInt8], from: Int, to: Int, pad: Bool
    ) -> [UInt8]? {
        var accumulator = 0
        var bits = 0
        var out = [UInt8]()
        let maxValue = (1 << to) - 1
        for value in data {
            guard (Int(value) >> from) == 0 else { return nil }
            accumulator = (accumulator << from) | Int(value)
            bits += from
            while bits >= to {
                bits -= to
                out.append(UInt8((accumulator >> bits) & maxValue))
            }
        }
        if pad {
            if bits > 0 { out.append(UInt8((accumulator << (to - bits)) & maxValue)) }
        } else if bits >= from || ((accumulator << (to - bits)) & maxValue) != 0 {
            return nil
        }
        return out
    }
}
