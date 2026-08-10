import Foundation

/// Where the identity key lives, from `Dm17.open`'s point of view.
///
/// A NIP-17 envelope needs two decryptions with the RECIPIENT's key — one for
/// the wrap, one for the seal — and the wrap's author is a fresh ephemeral key
/// per message, so there is no conversation key to precompute and no way to
/// avoid the key itself being reachable somehow.
///
/// Two implementations, and the difference is the whole reason this protocol
/// exists: an nsec login has the key on the device, a NIP-46 login has it
/// behind a bunker. Hiding that behind one call keeps every NIP-17 refusal —
/// the anti-spoof, the id check, the three expiry levels — written exactly once
/// rather than once per login type, which is how a notification path ends up
/// laxer than the app.
protocol Nip44Decryptor {
    /// Decrypt content `pubkey` encrypted to us, or nil if it cannot be opened.
    func decrypt(pubkey: String, ciphertext: String) -> String?
}

/// The key is here. One ECDH and one NIP-44 open, no network.
struct LocalDecryptor: Nip44Decryptor {
    let secretKey: [UInt8]

    func decrypt(pubkey: String, ciphertext: String) -> String? {
        guard let conversationKey = Secp256k1.conversationKey(
            secretKey: secretKey, peerPubkeyHex: pubkey
        ) else { return nil }
        return Nip44.decrypt(conversationKey: conversationKey, payloadBase64: ciphertext)
    }
}

/// The key is in the user's bunker. Each call is a `nip44_decrypt` RPC.
///
/// Two per DM (wrap, then seal), sequential because the second needs the
/// first's plaintext to know whose key to ask about. Both ride one socket that
/// the client opens once and keeps for the life of the push.
struct RemoteDecryptor: Nip44Decryptor {
    let client: Nip46Client

    func decrypt(pubkey: String, ciphertext: String) -> String? {
        client.nip44Decrypt(pubkey: pubkey, ciphertext: ciphertext)
    }
}
