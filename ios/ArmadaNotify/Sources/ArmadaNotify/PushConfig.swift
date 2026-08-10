import Foundation

/// One Concord channel's current stream, as the extension needs it: the wrap
/// author to recognise, the key that opens it, and the binding the rumor inside
/// must match.
struct ConcordStream {
    /// Stream address (x-only pubkey hex) — equals the wrap's `pubkey`.
    let pubkey: String
    /// NIP-44 conversation key (hex) that decrypts this stream's wraps.
    let conversationKey: String
    /// Epoch (decimal string) the rumor's `epoch` binding tag must equal.
    let epoch: String
    /// Community id (hex) — the deep link and the ArmadaDB tenant.
    let communityId: String
    /// Channel id (hex) — the deep link and the rumor's `channel` binding tag.
    let channelId: String
}

/// How to notify for a DM from someone the viewer doesn't know.
enum DmRequestLevel: String {
    case off
    case generic
    case full
}

/// What the extension needs to OPEN an event the push payload inlined.
///
/// The iOS counterpart of `SwPushConfig` (`src/lib/swPushConfig.ts`), and it
/// carries the same fields for the same reasons. Like that one it holds NO
/// display data: names, avatars and room titles are read out of ArmadaDB at
/// push time, for any author, rather than pre-sealed for a listed few.
///
/// SECURITY. `sk` is the account's identity key and is present ONLY for nsec
/// logins — bunker (NIP-46) and extension (NIP-07) logins keep their key off the
/// device, so their DMs stay the generic wake-up here exactly as they do in the
/// web worker. It has to be present at all because a NIP-17 wrap is authored by
/// a fresh ephemeral key per message: there is no conversation key to
/// precompute, so opening one needs the ECDH itself.
///
/// It lives in the App Group container under
/// `.completeUntilFirstUserAuthentication`, which is the weakest protection
/// class that still works — a notification arrives while the device is LOCKED,
/// and anything stronger would make the extension unable to read its own
/// config. That is the same container, and the same reachable-while-locked
/// exposure, as the decrypted DM and Concord history ArmadaDB already keeps
/// there; the difference the key adds is the ability to read FUTURE messages,
/// which is why it is written only while push is enabled and deleted on
/// disable/logout.
///
/// The Concord keys beside it are a strictly smaller secret: a stream's
/// conversation key READS one channel at one epoch, the wrap-SIGNING key is not
/// here at all, so nothing in this file can write to a community — and the set
/// goes stale by itself at the next rekey.
struct PushConfig {
    let policy: DmRequestLevel
    /// The viewer's own pubkey (hex) — to drop self-sent copies.
    let selfPubkey: String
    /// follows ∪ accepted ∪ pinned (hex) — the "known" senders.
    let knownPeers: Set<String>
    /// Decrypt key bytes. Present for nsec logins only.
    let secretKey: [UInt8]?
    /// The CURRENT epoch's stream for every watched channel. Only the current
    /// one: a retired epoch is read-cutoff history and must not notify.
    let concord: [ConcordStream]

    static func parse(json: String) -> PushConfig? {
        guard let decoded = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let object = decoded as? [String: Any],
              let selfPubkey = object["self"] as? String
        else { return nil }

        let policy = DmRequestLevel(rawValue: object["policy"] as? String ?? "") ?? .generic
        let knownPeers = Set((object["knownPeers"] as? [String]) ?? [])

        var secretKey: [UInt8]?
        if let hex = object["sk"] as? String, let bytes = Hex.decode(hex), bytes.count == 32 {
            secretKey = bytes
        }

        var streams = [ConcordStream]()
        for raw in (object["concord"] as? [Any]) ?? [] {
            guard let entry = raw as? [String: Any],
                  let pubkey = entry["pk"] as? String,
                  let convKey = entry["convKey"] as? String,
                  let epoch = entry["epoch"] as? String,
                  let communityId = entry["communityId"] as? String,
                  let channelId = entry["channelId"] as? String
            else { continue }
            streams.append(ConcordStream(
                pubkey: pubkey,
                conversationKey: convKey,
                epoch: epoch,
                communityId: communityId,
                channelId: channelId
            ))
        }

        return PushConfig(
            policy: policy,
            selfPubkey: selfPubkey,
            knownPeers: knownPeers,
            secretKey: secretKey,
            concord: streams
        )
    }
}

#if canImport(Darwin)

    /// Where the extension finds its config.
    ///
    /// A file of its own in the App Group container rather than a row in
    /// ArmadaDB's KV: the KV is a general-purpose store the app queries, lists
    /// and would happily include in a diagnostic dump, and an identity key
    /// should not be somewhere a future convenience can sweep it up. A separate
    /// file also gets its own protection class and its own delete.
    public enum PushConfigStore {

        public static let fileName = "push-config.json"

        public static func url(appGroup group: String = "group.buzz.armada.app") -> URL? {
            FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: group)?
                .appendingPathComponent(fileName)
        }

        /// Replace the config. `.completeUntilFirstUserAuthentication` is
        /// required, not chosen: a push arrives while the device is locked, and
        /// `.complete` would leave the extension unable to open its own file.
        public static func write(_ json: String) throws {
            guard let url = url() else {
                throw NSError(
                    domain: "ArmadaNotify", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "App Group container unavailable"]
                )
            }
            try Data(json.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }

        /// Delete the config, on push disable or logout.
        public static func clear() {
            guard let url = url() else { return }
            try? FileManager.default.removeItem(at: url)
        }

        static func read() -> PushConfig? {
            guard let url = url(), let data = try? Data(contentsOf: url) else { return nil }
            return PushConfig.parse(json: String(decoding: data, as: UTF8.self))
        }
    }

#endif
