import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// Fetch one event by id from the relays a push names.
///
/// nostr-push2 inlines the event only when the whole APNs payload fits in
/// 4 KB, and a gift wrap is nested base64, so a long message arrives as
/// `event_id` plus the relay it came from. Its plane, and so whether and how
/// to show it, is only knowable from the event, so it is fetched before
/// anything is decided, as the web worker does.
///
/// Relays are tried one at a time inside one shared budget. What comes back
/// is untrusted: the caller checks its id and signature like an inlined one.
enum RelayFetch {

    static func event(id: String, relays: [String], timeout: TimeInterval) -> [String: Any]? {
        let deadline = Date().addingTimeInterval(timeout)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        // A background delegate queue: this blocks on semaphores, and a
        // main-queue delegate would deadlock against them.
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }

        for relay in relays {
            guard deadline.timeIntervalSinceNow > 0 else { return nil }
            guard let url = URL(string: relay),
                  url.scheme == "wss" || url.scheme == "ws"
            else { continue }
            if let event = fetch(id: id, url: url, session: session, deadline: deadline) {
                return event
            }
        }
        return nil
    }

    private static func fetch(
        id: String, url: URL, session: URLSession, deadline: Date
    ) -> [String: Any]? {
        let socket = session.webSocketTask(with: url)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }

        let request = #"["REQ","armada-push-fetch",{"ids":["\#(id)"],"limit":1}]"#
        guard send(socket, text: request, deadline: deadline) else { return nil }

        while deadline.timeIntervalSinceNow > 0 {
            guard let message = receive(socket, deadline: deadline),
                  let data = message.data(using: .utf8),
                  let frame = try? JSONSerialization.jsonObject(with: data) as? [Any],
                  let type = frame.first as? String
            else { return nil }
            switch type {
            case "EVENT":
                if frame.count >= 3,
                   let event = frame[2] as? [String: Any],
                   event["id"] as? String == id {
                    return event
                }
            case "EOSE", "CLOSED":
                return nil
            default:
                continue
            }
        }
        return nil
    }

    private static func send(
        _ socket: URLSessionWebSocketTask, text: String, deadline: Date
    ) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        socket.send(.string(text)) { error in
            ok = error == nil
            semaphore.signal()
        }
        return semaphore.wait(timeout: .now() + max(0, deadline.timeIntervalSinceNow)) == .success
            && ok
    }

    private static func receive(_ socket: URLSessionWebSocketTask, deadline: Date) -> String? {
        let semaphore = DispatchSemaphore(value: 0)
        var text: String?
        socket.receive { result in
            if case let .success(.string(value)) = result { text = value }
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + max(0, deadline.timeIntervalSinceNow)) == .success
        else { return nil }
        return text
    }
}
