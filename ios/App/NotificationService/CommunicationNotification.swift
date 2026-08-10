import ArmadaNotify
import Intents
import UserNotifications

/// Re-files a notification as coming from a PERSON rather than from an app.
///
/// This is the only way iOS will show a sender's picture on a notification.
/// Setting `content.attachments` or a `UNNotificationAttachment` does something
/// else entirely — it adds a picture to the body — and no amount of correct
/// title/body text will replace the app icon in the corner. What does is
/// donating an `INSendMessageIntent` and rebuilding the content from it, which
/// promotes the notification to a "communication notification": the sender's
/// avatar (or the monogram of their name), their name as the source, and
/// participation in Focus modes' "Allow from People" rules.
///
/// Requires the Communication Notifications capability on the App ID — see
/// `App.entitlements`. Without it `updating(from:)` throws and the plain
/// notification is shown, which is what the caller falls back to.
///
/// Deliberately does NOT apply to the message-request ping: `PreparedPush`
/// carries a `sender` only where the sender is already being named in the body,
/// so a stranger's name and picture cannot arrive on the lock screen through
/// this door either.
enum CommunicationNotification {

    /// Rebuild `content` as a message from `sender`, or nil if the system
    /// declines (missing capability, malformed image, unavailable intent).
    static func apply(
        sender: PreparedPush.Sender,
        threadId: String,
        avatar: Data?,
        to content: UNMutableNotificationContent
    ) -> UNNotificationContent? {
        let image = avatar.flatMap { INImage(imageData: $0) }

        // `value` is the pubkey, not a phone number or an email: iOS uses the
        // handle only to tell one correspondent from another, and a hex key is
        // a better identity than anything else on hand. `.unknown` keeps it
        // from being matched against the address book, which is the point —
        // nothing here should reach into Contacts.
        let person = INPerson(
            personHandle: INPersonHandle(value: sender.id, type: .unknown),
            nameComponents: nil,
            displayName: sender.name,
            image: image,
            contactIdentifier: nil,
            customIdentifier: sender.id
        )

        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: nil,
            // Present for a channel, absent for a DM. This is what makes iOS
            // render the room as the conversation and the sender as a
            // participant inside it, matching the title/body split the preview
            // layer already chose.
            speakableGroupName: sender.groupName.map { INSpeakableString(spokenPhrase: $0) },
            // The same string the notification collapses on, so the system's
            // idea of "this conversation" and ours agree.
            conversationIdentifier: threadId,
            serviceName: nil,
            sender: person,
            attachments: nil
        )

        // Donating is not optional bookkeeping: an undonated intent updates the
        // content but leaves the system without the conversation, so Focus
        // rules and the Communication Safety surfaces never learn about it.
        // `.incoming` is what marks this as received rather than sent.
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate(completion: nil)

        return try? content.updating(from: intent)
    }
}
