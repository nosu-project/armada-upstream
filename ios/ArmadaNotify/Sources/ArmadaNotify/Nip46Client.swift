import Foundation
// `URLSession` and `URLSessionWebSocketTask` are in Foundation proper on Apple
// platforms and in FoundationNetworking on Linux — where this package's suite
// runs, so the split has to be spelled out or the whole module fails to build.
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// A single-purpose NIP-46 client: ask the user's bunker to `nip44_decrypt`.
///
/// This exists because a bunker login's identity key is deliberately NOT on the
/// device, so the extension cannot open a NIP-17 gift wrap by itself. What IS
/// on the device is the CLIENT key — the keypair that addresses the bunker —
/// and that is enough to ask.
///
/// Deliberately the smallest possible NIP-46 surface: one method, no signing of
/// anything but its own requests, no `connect` handshake, no permission
/// negotiation. The app has already paired with the bunker and been granted
/// whatever it holds; this only re-uses that grant. If the bunker prompts for
/// approval rather than auto-approving, nothing here can help — a push arrives
/// with the phone locked and no UI to approve with — and the call simply times
/// out into the generic notification.
///
/// EVERY failure is non-fatal by construction. A bunker that is slow, offline,
/// or unwilling costs one timeout and the user sees the same "New direct
/// message" they would have seen anyway, so this can only improve on the
/// fallback, never replace it with something worse.
final class Nip46Client {

    /// NIP-46 RPC event kind.
    private static let kind = 24133

    private let clientSecretKey: [UInt8]
    private let clientPubkey: String
    private let bunkerPubkey: String
    private let conversationKey: [UInt8]
    private let relays: [String]
    /// Budget for the WHOLE exchange, shared across every RPC on this client.
    private let deadline: Date

    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    /// Responses that arrived before the request that wanted them was asked
    /// for. The subscription is opened once and delivers whatever the bunker
    /// sends, in whatever order.
    private var pending: [String: String] = [:]
    private let lock = NSLock()

    init?(
        clientSecretKey: [UInt8],
        bunkerPubkey: String,
        relays: [String],
        timeout: TimeInterval
    ) {
        guard !relays.isEmpty,
              let clientPubkey = Secp256k1.xonlyPublicKey(secretKey: clientSecretKey),
              let conversationKey = Secp256k1.conversationKey(
                  secretKey: clientSecretKey, peerPubkeyHex: bunkerPubkey
              )
        else { return nil }

        self.clientSecretKey = clientSecretKey
        self.clientPubkey = clientPubkey
        self.bunkerPubkey = bunkerPubkey
        self.conversationKey = conversationKey
        self.relays = relays
        self.deadline = Date().addingTimeInterval(timeout)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        // The default delegate queue is a background one, which matters: the
        // caller BLOCKS on a semaphore waiting for these callbacks, and a
        // main-queue delegate would deadlock against it.
        self.session = URLSession(configuration: configuration)
    }

    deinit {
        socket?.cancel(with: .goingAway, reason: nil)
    }

    /// Ask the bunker to decrypt. Nil on any failure, including a timeout.
    func nip44Decrypt(pubkey: String, ciphertext: String) -> String? {
        call(method: "nip44_decrypt", params: [pubkey, ciphertext])
    }

    // MARK: - RPC

    private func call(method: String, params: [String]) -> String? {
        guard remaining() > 0 else { return nil }
        guard let socket = connect() else { return nil }

        let requestId = UUID().uuidString
        guard let request = signedRequest(id: requestId, method: method, params: params) else {
            return nil
        }

        // A relay only forwards an ephemeral event to CURRENT subscribers, so
        // the REQ has to be open before the request goes out. `connect` has
        // already sent it.
        guard send(socket, text: "[\"EVENT\",\(request)]") else { return nil }

        while remaining() > 0 {
            if let response = takePending(requestId) { return response }
            guard let message = receive(socket) else { return nil }
            ingest(message)
        }
        return nil
    }

    /// Build, id and sign the kind-24133 event carrying one RPC.
    private func signedRequest(id: String, method: String, params: [String]) -> String? {
        let payload: [String: Any] = ["id": id, "method": method, "params": params]
        guard let payloadData = try? JSONSerialization.data(withJSONObject: payload),
              let content = Nip44.encrypt(
                  conversationKey: conversationKey,
                  plaintext: String(decoding: payloadData, as: UTF8.self)
              )
        else { return nil }

        let event = NostrEvent(
            id: nil,
            pubkey: clientPubkey,
            createdAt: Int(Date().timeIntervalSince1970),
            kind: Self.kind,
            tags: [["p", bunkerPubkey]],
            content: content,
            sig: nil
        )
        let eventId = event.computedId
        guard let message = Hex.decode(eventId),
              let signature = Secp256k1.schnorrSign(message: message, secretKey: clientSecretKey)
        else { return nil }

        var object = event.rumorJsonObject(id: eventId)
        object["sig"] = signature
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// Open the socket and the response subscription, once.
    private func connect() -> URLSessionWebSocketTask? {
        if let socket = socket { return socket }
        // First relay that accepts a connection wins. Racing all of them would
        // be faster but this runs inside a notification's budget, and a second
        // socket is a second thing to tear down.
        for relay in relays {
            guard let url = URL(string: relay), remaining() > 0 else { continue }
            let task = session.webSocketTask(with: url)
            task.resume()

            let subscription = """
            ["REQ","armada-push",{"kinds":[\(Self.kind)],"authors":["\(bunkerPubkey)"],\
            "#p":["\(clientPubkey)"],"limit":0}]
            """
            if send(task, text: subscription) {
                socket = task
                return task
            }
            task.cancel(with: .abnormalClosure, reason: nil)
        }
        return nil
    }

    // MARK: - Socket plumbing

    /// Send, blocking until the frame is written or the send fails.
    private func send(_ socket: URLSessionWebSocketTask, text: String) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        socket.send(.string(text)) { error in
            ok = error == nil
            semaphore.signal()
        }
        return semaphore.wait(timeout: .now() + remaining()) == .success && ok
    }

    /// Receive one frame, blocking up to the remaining budget.
    private func receive(_ socket: URLSessionWebSocketTask) -> String? {
        let semaphore = DispatchSemaphore(value: 0)
        var text: String?
        socket.receive { result in
            if case let .success(.string(value)) = result { text = value }
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + remaining()) == .success else { return nil }
        return text
    }

    /// Decrypt a relay message and file any RPC response it carries.
    private func ingest(_ message: String) {
        guard let data = message.data(using: .utf8),
              let frame = try? JSONSerialization.jsonObject(with: data) as? [Any],
              frame.count >= 3,
              frame[0] as? String == "EVENT",
              let event = frame[2] as? [String: Any],
              let content = event["content"] as? String,
              // The bunker is the only author the subscription accepts, but the
              // relay is untrusted and this is cheap to re-check.
              event["pubkey"] as? String == bunkerPubkey,
              let plaintext = Nip44.decrypt(
                  conversationKey: conversationKey, payloadBase64: content
              ),
              let response = try? JSONSerialization.jsonObject(with: Data(plaintext.utf8))
                  as? [String: Any],
              let id = response["id"] as? String
        else { return }

        // An `error` field means the bunker refused — a real answer, and one
        // that should stop the wait rather than burn the whole budget. It is
        // filed as no result, which is what the caller does with a timeout too.
        guard let result = response["result"] as? String, response["error"] == nil else { return }
        lock.lock()
        pending[id] = result
        lock.unlock()
    }

    private func takePending(_ id: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return pending.removeValue(forKey: id)
    }

    private func remaining() -> TimeInterval {
        max(0, deadline.timeIntervalSinceNow)
    }
}
