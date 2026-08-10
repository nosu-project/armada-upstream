import ArmadaNotify
import UserNotifications

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
///    static text. That is the correct fallback and it is also invisible: no
///    log anyone reads, no error the app can report. So every failure path
///    here ends in the same `deliver(_:)` the success path does, and
///    `deliver` is idempotent because the avatar fetch below means the timeout
///    and the completion can now genuinely race.
///  - **Never spend the budget.** ~24 MB and a few seconds, after which
///    `serviceExtensionTimeWillExpire` fires and iOS shows whatever is left.
///    The one thing that waits on the network is the avatar, which is bounded
///    and cached (`AvatarLoader`); names and room titles are read from the
///    ArmadaDB file in the App Group, or not at all.
class NotificationService: UNNotificationServiceExtension {

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?
    /// Guards the handler against the avatar fetch and the expiry timer both
    /// arriving. `didReceive` and `serviceExtensionTimeWillExpire` are called on
    /// the same queue, but the fetch's completion is not.
    private let lock = NSLock()
    private var delivered = false

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
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

        AvatarLoader.load(url: sender.avatarUrl) { [weak self] avatar in
            guard let self else { return }
            let communication = CommunicationNotification.apply(
                sender: sender,
                threadId: prepared.threadId,
                avatar: avatar,
                to: content
            )
            // A system that declines the intent still gets the decrypted text.
            self.deliver(communication ?? content)
        }
    }

    /// Out of time. Hand back whatever has been built — which is at worst the
    /// gateway's original content, never nothing.
    override func serviceExtensionTimeWillExpire() {
        if let bestAttempt = bestAttempt { deliver(bestAttempt) }
    }

    /// Call the content handler at most once.
    private func deliver(_ content: UNNotificationContent) {
        lock.lock()
        let alreadyDelivered = delivered
        delivered = true
        let handler = contentHandler
        lock.unlock()
        if alreadyDelivered { return }
        handler?(content)
    }
}
