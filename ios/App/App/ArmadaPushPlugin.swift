import ArmadaNotify
import Capacitor
import Foundation
import UIKit
import UserNotifications

/// The iOS app's APNs registration — the transport half of `useIosPush.ts`.
///
/// iOS is the one platform where Armada cannot listen for its own events in the
/// background: there is no equivalent of the Android foreground service, and
/// WKWebView has no Web Push. So the app takes a device token from Apple and
/// hands it to the same content-blind nostr-push gateway the web client uses,
/// as a `type: "apns"` subscription. Every filter, preference and per-channel
/// level above that is shared TypeScript; this file knows nothing about them.
///
/// Deliberately nothing but the token, the permission, and the tap. What it
/// does NOT do is render: the gateway sends fixed text and there is no
/// Notification Service Extension here yet, so the payload's `aps.alert` is
/// what the lock screen shows. Adding one is what would let a notification name
/// the sender or quote the message, and it means porting the decrypt/store
/// pipeline to Swift against the App Group's ArmadaDB — which is why the
/// database is in the App Group already.
@objc(ArmadaPushPlugin)
public class ArmadaPushPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ArmadaPushPlugin"
    public let jsName = "ArmadaPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "permission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearBadge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takePendingOpen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recordStatus", returnType: CAPPluginReturnPromise),
    ]

    /// How long to wait for APNs to hand back a token before giving up.
    ///
    /// A device with no network gets no token and no error — the callback
    /// simply never fires — so without a bound `register()` would hang the
    /// enable action forever. Timing out resolves it as a retryable failure.
    private static let tokenTimeout: TimeInterval = 30

    public override func load() {
        ArmadaPushBridge.shared.plugin = self
    }

    // MARK: - permission

    @objc func permission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status: String
            switch settings.authorizationStatus {
            // Provisional and ephemeral authorizations both deliver, quietly.
            // Reporting them as granted is what stops the app from re-prompting
            // a user who is already receiving notifications.
            case .authorized, .provisional, .ephemeral:
                status = "granted"
            case .denied:
                status = "denied"
            case .notDetermined:
                status = "default"
            @unknown default:
                status = "default"
            }
            call.resolve(["status": status])
        }
    }

    // MARK: - registration

    /// Ask for authorization (once per install — iOS shows its prompt exactly
    /// one time, and answers from the stored decision afterwards), then take a
    /// device token.
    @objc func register(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
                if let error = error {
                    return call.reject("\(error.localizedDescription)")
                }
                guard granted else {
                    // Not a failure: the user's answer, which `useIosPush`
                    // renders as the blocked state rather than as an error.
                    return call.resolve(["granted": false])
                }

                // Always re-register, even when a token is already cached: APNs
                // may hand back a different one (a restore from backup, or the
                // OS rotating it), and a stale token is a device that silently
                // stops receiving rather than one that reports a problem.
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }

                ArmadaPushBridge.shared.awaitToken(timeout: Self.tokenTimeout) { result in
                    switch result {
                    case .success(let token):
                        call.resolve([
                            "granted": true,
                            "token": token,
                            "bundleId": Bundle.main.bundleIdentifier ?? "",
                            "environment": ArmadaPushBridge.apsEnvironment(),
                        ])
                    case .failure(let error):
                        // Authorization stands; only the token is missing. Say
                        // both, so the JS side retries rather than concluding
                        // the user refused.
                        call.resolve([
                            "granted": true,
                            "error": "\(error.localizedDescription)",
                        ])
                    }
                }
            }
    }

    @objc func unregister(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIApplication.shared.unregisterForRemoteNotifications()
            ArmadaPushBridge.shared.forgetToken()
            call.resolve()
        }
    }

    // MARK: - presentation

    @objc func clearBadge(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(0) { _ in call.resolve() }
        } else {
            DispatchQueue.main.async {
                UIApplication.shared.applicationIconBadgeNumber = 0
                call.resolve()
            }
        }
    }

    // MARK: - The extension's config

    /// Hand the Notification Service Extension what it needs to OPEN an event
    /// the gateway inlined: the DM policy, the known-peer set, the viewer's own
    /// pubkey, the identity key for nsec logins, and the per-channel Concord
    /// stream keys. The iOS counterpart of `writeSwPushConfig`.
    ///
    /// Crosses as JSON TEXT rather than a marshalled object for the reason
    /// `ArmadaDbPlugin` does: Capacitor would have to guess number types, and
    /// there is nothing here worth marshalling field by field.
    @objc func writeConfig(_ call: CAPPluginCall) {
        guard let json = call.getString("config") else {
            return call.reject("config is required")
        }
        do {
            try PushConfigStore.write(json)
            call.resolve()
        } catch {
            // Say what the container looks like, not just that the write
            // failed. Without the config every notification falls back to the
            // gateway's static text, which is indistinguishable from the
            // feature not existing — so the reason has to travel back to
            // somewhere a person can read it.
            call.reject("\(error.localizedDescription) [\(PushConfigStore.describe())]")
        }
    }

    /// Delete it, on disable or logout. The identity key must not outlive the
    /// session that could use it — and neither should the avatars of the people
    /// that session was talking to, which are the one other thing the extension
    /// leaves in the shared container.
    @objc func clearConfig(_ call: CAPPluginCall) {
        PushConfigStore.clear()
        AvatarCache.clear()
        call.resolve()
    }

    /// Record how the last registration went, where a developer with the device
    /// on a cable can read it back.
    ///
    /// Registration is the one link in this chain with no observable outcome.
    /// The gateway's answer arrives over Nostr and is swallowed by a retry
    /// loop; the app then looks identical whether it registered, was refused
    /// for exceeding the per-domain quota, or never asked. A device that
    /// silently stops receiving is the failure this whole path is prone to, so
    /// the outcome goes on disk in the app's own container rather than nowhere.
    ///
    /// Caller-supplied text, and the caller keeps secrets out of it: this is a
    /// status line (counts, environment, a token SUFFIX to spot rotation, an
    /// error message), never a token or a key.
    @objc func recordStatus(_ call: CAPPluginCall) {
        guard let line = call.getString("line") else {
            return call.reject("line is required")
        }
        guard let dir = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask).first
        else { return call.resolve() }
        let stamped = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        try? stamped.write(
            to: dir.appendingPathComponent("push-status.txt"),
            atomically: true,
            encoding: .utf8
        )
        call.resolve()
    }

    /// The notification tap that launched this process, consumed once.
    ///
    /// A cold launch delivers the tap long before the WebView has loaded a
    /// listener, so the bridge buffers it and the app collects it at startup.
    @objc func takePendingOpen(_ call: CAPPluginCall) {
        guard let path = ArmadaPushBridge.shared.takePendingOpen() else {
            return call.resolve([:])
        }
        call.resolve(["path": path])
    }
}

/// The process-wide half of the plugin: what has to exist before, and outlive,
/// any WebView.
///
/// APNs callbacks land on the `UIApplicationDelegate`, and a notification tap
/// can start the process — neither can wait for `ViewController` to register a
/// plugin, so both are received here and handed on (or buffered) once one
/// exists. `AppDelegate` forwards to it directly rather than through Capacitor's
/// notification names, so a Capacitor upgrade cannot quietly reroute it.
final class ArmadaPushBridge: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ArmadaPushBridge()

    /// Set by the plugin when the bridge registers it; nil until the WebView
    /// exists, and again if it is torn down.
    weak var plugin: CAPPlugin?

    private let lock = NSLock()
    private var token: String?
    private var waiters: [(Result<String, Error>) -> Void] = []
    private var pendingOpen: String?

    /// Install as the notification delegate. Must happen before the app
    /// finishes launching, or iOS drops the tap that launched it.
    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: - token

    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        lock.lock()
        token = hex
        let pending = waiters
        waiters = []
        lock.unlock()
        for waiter in pending { waiter(.success(hex)) }
    }

    func didFailToRegister(error: Error) {
        lock.lock()
        let pending = waiters
        waiters = []
        lock.unlock()
        for waiter in pending { waiter(.failure(error)) }
    }

    func forgetToken() {
        lock.lock()
        token = nil
        lock.unlock()
    }

    /// Resolve with the device token, waiting for it if it has not arrived.
    func awaitToken(
        timeout: TimeInterval,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        lock.lock()
        if let token = token {
            lock.unlock()
            return completion(.success(token))
        }
        var settled = false
        let once: (Result<String, Error>) -> Void = { result in
            // The timeout and the callback race; whichever loses is discarded.
            self.lock.lock()
            let alreadySettled = settled
            settled = true
            self.lock.unlock()
            if !alreadySettled { completion(result) }
        }
        waiters.append(once)
        lock.unlock()

        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            once(.failure(NSError(
                domain: "ArmadaPush",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for an APNs device token"]
            )))
        }
    }

    /// Which APNs host minted this build's tokens, read from the build's own
    /// `aps-environment` entitlement.
    ///
    /// A token is valid on exactly one host and the other rejects it with
    /// `BadDeviceToken`, so the gateway has to be told which — and neither
    /// `#if DEBUG` nor a build setting can answer it, since a Release build run
    /// from Xcode is still a sandbox token while the same configuration through
    /// TestFlight is a production one. The provisioning profile is the thing
    /// that actually decides, so it is the thing to read. An App Store build
    /// embeds no profile at all, which is itself the production answer.
    static func apsEnvironment() -> String {
        guard
            let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
            let data = try? Data(contentsOf: url),
            // The file is CMS-signed DER wrapping an XML plist; isoLatin1 is a
            // byte-preserving decode, so slicing it cannot corrupt the payload.
            let raw = String(data: data, encoding: .isoLatin1),
            let start = raw.range(of: "<?xml"),
            let end = raw.range(of: "</plist>"),
            let plistData = String(raw[start.lowerBound..<end.upperBound]).data(using: .isoLatin1),
            let plist = try? PropertyListSerialization.propertyList(
                from: plistData, options: [], format: nil
            ) as? [String: Any],
            let entitlements = plist["Entitlements"] as? [String: Any],
            let environment = entitlements["aps-environment"] as? String
        else {
            return "production"
        }
        return environment == "development" ? "sandbox" : "production"
    }

    // MARK: - taps

    func takePendingOpen() -> String? {
        lock.lock()
        defer { lock.unlock() }
        let path = pendingOpen
        pendingOpen = nil
        return path
    }

    /// Where a tapped notification should land in the app.
    ///
    /// The APNs transport hoists the subscription's `notification.data` keys to
    /// the payload's top level, so the routing hints registered in
    /// `pushSubscriptions.ts` arrive as plain top-level entries. Only DMs name
    /// a destination today: a group or community wake-up carries no room id
    /// (the gateway is content-blind and the event is not opened here), so
    /// those taps just bring the app forward.
    private static func path(from userInfo: [AnyHashable: Any]) -> String? {
        if let url = userInfo["url"] as? String, url.hasPrefix("/") {
            return url
        }
        if let scope = userInfo["scope"] as? String, scope == "dm" {
            return "/dm"
        }
        return nil
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard let path = Self.path(from: response.notification.request.content.userInfo) else {
            return
        }
        if let plugin = plugin {
            plugin.notifyListeners("pushOpened", data: ["path": path])
        } else {
            // Cold launch: the WebView is not up yet. Hold it for the app to
            // collect through `takePendingOpen`, which is read once at startup.
            lock.lock()
            pendingOpen = path
            lock.unlock()
        }
    }

    /// What to do with a push that arrives while Armada is open.
    ///
    /// No banner and no sound: the app is on screen, its channel rail already
    /// shows the unread, and the payload carries no room id — so there is no
    /// way to tell a message in another channel from the one being read, and
    /// interrupting for the latter is worse than not interrupting for the
    /// former. It still lands in Notification Center, so nothing is lost.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if #available(iOS 14.0, *) {
            completionHandler([.list, .badge])
        } else {
            completionHandler([.badge])
        }
    }
}
