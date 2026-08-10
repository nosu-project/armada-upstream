import ArmadaNotify
import UserNotifications

/// Calls a content handler at most once, independently of who still holds it.
///
/// The extension's whole contract is "call the handler exactly once", and the
/// two ways to break it pull in opposite directions: call it twice, or never.
/// Owning that guarantee here rather than in `NotificationService` is
/// deliberate — the avatar fetch's completion captures THIS, not the extension
/// object, so a notification is delivered even if the system has already let
/// the extension instance go. A closure that captured the extension weakly and
/// bailed on a nil `self` would return without calling the handler, and an
/// extension that never calls its handler shows NOTHING: not the decrypted
/// message, and not the gateway's fallback either.
private final class OneShotHandler {

    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?

    init(_ handler: @escaping (UNNotificationContent) -> Void) {
        self.handler = handler
    }

    /// Deliver `content`, unless something already did. Taking the handler out
    /// under the lock is what makes the avatar fetch and the expiry timer —
    /// which complete on different queues — safe to race.
    func callAsFunction(_ content: UNNotificationContent) {
        lock.lock()
        let handler = self.handler
        self.handler = nil
        lock.unlock()
        handler?(content)
    }
}

/// The Notification Service Extension: the only place on iOS where an incoming
/// message can be decrypted before the user sees it.
///
/// The push gateway is content-blind — it matches kinds and tags and sends a
/// fixed string — so without this the lock screen could only ever say that
/// something arrived. iOS runs this process for a few seconds when a payload
/// carries `mutable-content: 1`, with the app not running and usually the
/// device locked, and whatever it hands back is what is shown.
///
/// Deliberately thin. Every decision, every refusal and every byte of
/// decryption lives in the `ArmadaNotify` package, whose suite runs on Linux
/// under `swift test`; what is left here is the part that cannot be tested
/// anywhere — reading a `UNNotificationRequest`, fetching an avatar, donating
/// an intent, and calling a completion handler.
///
/// Two rules govern this file:
///
///  - **Always call the handler, exactly once.** An extension that returns
///    without calling it, or that crashes, shows the gateway's original
///    static text — or, if the handler is never called at all, nothing
///    whatsoever. That is why delivery is owned by `OneShotHandler` above and
///    never conditioned on this object still being alive.
///  - **Never spend the budget.** ~24 MB and a few seconds, after which
///    `serviceExtensionTimeWillExpire` fires and iOS shows whatever is left.
///    The one thing that waits on the network is the avatar, which is bounded
///    and cached (`AvatarLoader`); names and room titles are read from the
///    ArmadaDB file in the App Group, or not at all.
class NotificationService: UNNotificationServiceExtension {

    private var deliver: OneShotHandler?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        let deliver = OneShotHandler(contentHandler)
        self.deliver = deliver

        let content = (request.content.mutableCopy() as? UNMutableNotificationContent)
            ?? UNMutableNotificationContent()
        bestAttempt = content

        // No config (push disabled, logged out, or a login whose key stays off
        // the device), or an event this key cannot open: keep what the gateway
        // sent.
        guard let prepared = ArmadaPushRuntime.prepare(userInfo: request.content.userInfo) else {
            return deliver(content)
        }

        if prepared.drop {
            // The message was stored; it just isn't news — the viewer's own
            // message from another device, or a reaction to someone else's.
            //
            // iOS cannot withdraw a delivered alert: an extension that returns
            // silently still shows one. So the quietest available truth is
            // shown instead of the gateway's "New message", which would be a
            // notification about nothing. `passive` neither sounds nor lights
            // the screen; it lands in Notification Center and no further.
            content.title = "Armada"
            content.body = "Messages synced"
            content.sound = nil
            content.interruptionLevel = .passive
            return deliver(content)
        }

        content.title = prepared.title
        content.body = prepared.body
        content.threadIdentifier = prepared.threadId
        if prepared.quiet {
            content.sound = nil
            content.interruptionLevel = .passive
        }
        if let path = prepared.path {
            // Read back by `ArmadaPushBridge.path(from:)` when the notification
            // is tapped. Merged into the payload's own keys rather than
            // replacing them, so the gateway's `event_id` and
            // `subscription_id` survive for anything that wants them.
            var userInfo = content.userInfo
            userInfo["url"] = path
            content.userInfo = userInfo
        }

        // A push with no nameable sender (the message-request ping) stays an
        // ordinary app notification, which is exactly right: it is the one case
        // where showing a person would be showing a stranger.
        guard let sender = prepared.sender else { return deliver(content) }

        // Captures `deliver` and `content` — NOT the extension. See
        // `OneShotHandler`.
        AvatarLoader.load(url: sender.avatarUrl) { avatar in
            let communication = CommunicationNotification.apply(
                sender: sender,
                threadId: prepared.threadId,
                avatar: avatar,
                to: content
            )
            // A system that declines the intent still gets the decrypted text.
            deliver(communication ?? content)
        }
    }

    /// Out of time. Hand back whatever has been built — which is at worst the
    /// gateway's original content, never nothing.
    override func serviceExtensionTimeWillExpire() {
        if let bestAttempt = bestAttempt { deliver?(bestAttempt) }
    }
}
