import ArmadaNotify
import Foundation

/// Fetches a sender's avatar, within a budget, for the communication
/// notification below.
///
/// This is the ONE place in the extension that touches the network, and it is
/// here reluctantly: iOS wants the image bytes in hand when the content handler
/// is called, so there is no way to hand it a URL and let the system fetch it.
/// Everything about it is therefore bounded — a short timeout, an `https`-only
/// URL, a size cap, and a disk cache (`AvatarCache`) that makes the request a
/// per-sender cost rather than a per-message one.
///
/// It can never fail the notification. A miss, a timeout, a 404 or an oversized
/// image all end the same way: no image, and iOS draws the monogram it derives
/// from the sender's name — still the person, rather than the app icon.
enum AvatarLoader {

    /// Longest to wait. The extension's own budget is tens of seconds and
    /// `serviceExtensionTimeWillExpire` is the backstop, but a notification
    /// that arrives late is a notification that arrives wrong: the point is to
    /// be on the screen when the phone buzzes.
    static let timeout: TimeInterval = 4

    /// The avatar bytes for `url`, from cache or the network. `completion` is
    /// always called, exactly once, on an arbitrary queue.
    static func load(url: String?, completion: @escaping (Data?) -> Void) {
        guard let url, url.lowercased().hasPrefix("https://"), let parsed = URL(string: url) else {
            return completion(nil)
        }
        if let hit = AvatarCache.cached(url: url) {
            return completion(hit)
        }

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        // The extension has no business consulting or populating a shared URL
        // cache; `AvatarCache` is the cache, and it is the one that survives
        // this process.
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData

        let session = URLSession(configuration: config)
        let task = session.dataTask(with: parsed) { data, response, _ in
            session.finishTasksAndInvalidate()
            guard let data,
                let http = response as? HTTPURLResponse,
                (200..<300).contains(http.statusCode),
                data.count <= AvatarCache.maxBytes,
                !data.isEmpty
            else { return completion(nil) }
            AvatarCache.store(url: url, data: data)
            completion(data)
        }
        task.resume()
    }
}
