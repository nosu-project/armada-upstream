import Foundation

/// The one call the Notification Service Extension makes.
///
/// Everything below it — the store, the config, the openers — is internal on
/// purpose: the extension has ~24 MB of memory and about 30 seconds, and the
/// less of this it can reach into, the less there is to get wrong in a process
/// whose failures are invisible (a crashed NSE just shows the original
/// notification, with no log anyone sees).
public enum ArmadaPushRuntime {

    /// Open the event the gateway inlined, store it, and say what to show — or
    /// nil to keep the gateway's static wake-up.
    ///
    /// Never throws. Every failure path in this pipeline means the same thing
    /// to the caller ("show what you were given"), and an extension that threw
    /// would be an extension that showed nothing at all.
    ///
    /// Only the CONFIG is required, because without it there is no key and
    /// nothing can be opened. The store is not: a database that will not open
    /// costs the message its persistence and its sender's name, but not its
    /// text — and refusing to present something already decrypted would turn
    /// one broken thing into two.
    public static func prepare(userInfo: [AnyHashable: Any]) -> PreparedPush? {
        #if canImport(Darwin)
            guard let config = PushConfigStore.read() else {
                Breadcrumb.record("no-config")
                return nil
            }
            let store = try? NotifyStore()
            if store == nil { Breadcrumb.record("no-store") }

            guard let prepared = PushProcessor(store: store, config: config)
                .prepare(userInfo: userInfo)
            else {
                Breadcrumb.record(store == nil ? "unopened+no-store" : "unopened")
                return nil
            }
            Breadcrumb.record(prepared.drop ? "dropped" : "shown")
            return prepared
        #else
            return nil
        #endif
    }
}

#if canImport(Darwin)

    /// A one-line record of what the last push did, in the EXTENSION's own
    /// sandbox.
    ///
    /// This process cannot be logged into from anywhere a developer can read
    /// without a Mac attached and a console open, and its failure mode is
    /// silence — the gateway's static text looks identical whether the
    /// extension declined, crashed, or was never invoked. One status word on
    /// disk is the difference between diagnosing that in a minute and guessing
    /// at it for an hour.
    ///
    /// Deliberately a STATUS ONLY: no message text, no pubkeys, no event ids,
    /// nothing about who sent what. It says which branch ran and when, and the
    /// file it writes is inside the extension's own container rather than the
    /// App Group, so it is not something the app or a backup carries around.
    enum Breadcrumb {

        static func record(_ status: String) {
            guard let url = url() else { return }
            let line = "\(ISO8601DateFormatter().string(from: Date())) \(status)\n"
            try? line.write(to: url, atomically: true, encoding: .utf8)
        }

        static func read() -> String? {
            guard let url = url() else { return nil }
            return try? String(contentsOf: url, encoding: .utf8)
        }

        private static func url() -> URL? {
            FileManager.default
                .urls(for: .cachesDirectory, in: .userDomainMask).first?
                .appendingPathComponent("last-push.txt")
        }
    }

#endif
