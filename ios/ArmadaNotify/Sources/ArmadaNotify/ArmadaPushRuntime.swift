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
    public static func prepare(userInfo: [AnyHashable: Any]) -> PreparedPush? {
        #if canImport(Darwin)
            guard let config = PushConfigStore.read() else { return nil }
            guard let store = try? NotifyStore() else { return nil }
            return PushProcessor(store: store, config: config).prepare(userInfo: userInfo)
        #else
            return nil
        #endif
    }
}
