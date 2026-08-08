import Foundation

/// The tenant ids both sides of the bridge spell the same way. A port of the
/// constants in `ArmadaDb.kt`, which mirror `armadaDB.ts` and `relayScope.ts`.
public enum ArmadaDbTenants {

    /// The general event cache: events whose meaning doesn't depend on who
    /// served them (profiles, the user's own lists, git activity, sealed
    /// Concord outers). The WebView's `mainEventStore`.
    ///
    /// NIP-29 is deliberately NOT here — see `nip29`.
    public static let main = "main"

    /// Concord wraps a background writer could not open (a rekey epoch it
    /// holds no key for), parked for the WebView, which does hold the keys.
    public static let concordPark = "c2park"

    /// The unscoped handoff queue, kept only so a queue written by an older
    /// build still drains.
    public static let serviceQueue = "svc"

    /// Prefix of the per-relay queues `serviceQueue(relay:)` hands out.
    public static let serviceQueuePrefix = "svc:"

    /// One relay's NIP-29 data. MUST match `nip29Tenant()` in
    /// `src/lib/db/relayScope.ts`, which is the tenant the WebView reads.
    ///
    /// A NIP-29 group is named by an `h`/`d` value that means nothing on its
    /// own: the same id on two relays is two unrelated groups, and relay
    /// software that ships a SHARED signing identity defeats scoping by author
    /// too. So the relay goes in the tenant id and the isolation is structural.
    ///
    /// `relayUrl` is expected ALREADY NORMALIZED, because it is the URL the
    /// WebView configured this side with. Normalization stays a JS-side concern
    /// on purpose: a second implementation here is a second spelling waiting to
    /// happen, and a tenant spelled differently by two writers would strand
    /// every message one of them stored. Only a trailing slash is trimmed, so
    /// the id is stable if a caller hands over a URL that skipped the JS path.
    public static func nip29(relayUrl: String) -> String {
        "nip29:\(trimTrailingSlash(relayUrl))"
    }

    /// The handoff queue for one relay, or the unscoped queue when the relay is
    /// unknown.
    ///
    /// Per relay because a drained page has to say which relay it came from:
    /// the WebView routes NIP-29 events into `nip29`, and a rumor carries no
    /// record of its source relay — nor may one be injected into its tags,
    /// which are the bytes its id commits to and would make the fact forgeable
    /// by any sender that spelled the tag. The tenant id is the one place that
    /// can hold it unforgeably.
    public static func serviceQueue(relayUrl: String?) -> String {
        guard let relayUrl, !relayUrl.isEmpty else { return serviceQueue }
        return "\(serviceQueuePrefix)\(trimTrailingSlash(relayUrl))"
    }

    /// The relay a per-relay queue tenant belongs to, or nil for the unscoped
    /// one.
    public static func queueRelay(tenant: String) -> String? {
        guard tenant.hasPrefix(serviceQueuePrefix) else { return nil }
        return String(tenant.dropFirst(serviceQueuePrefix.count))
    }

    /// The opened-event store for one Concord community.
    public static func community(idHex: String) -> String {
        "c2:\(idHex)"
    }

    private static func trimTrailingSlash(_ url: String) -> String {
        var trimmed = Substring(url)
        while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
        return String(trimmed)
    }
}

/// The app-wide `SqliteArmadaDb`, opened once per process.
///
/// One instance per process is the whole point of the native port: a
/// notification extension would write what it receives straight into the store
/// and the WebView reads it back through the plugin — the same file, the same
/// query planner, no drain format to agree on and no second copy of the data.
///
/// Unlike Android, the extension is a SEPARATE PROCESS, so "one instance" holds
/// only within each. Two processes sharing one file is what WAL and
/// `BEGIN IMMEDIATE` are for, and why the busy timeout is not optional.
public final class ArmadaDbStore {

    private static let lock = NSLock()
    private static var instances = [String: SqliteArmadaDb]()

    /// The database at `path`, opened on first use.
    public static func shared(path: String) throws -> SqliteArmadaDb {
        lock.lock()
        defer { lock.unlock() }

        if let existing = instances[path] { return existing }

        let directory = (path as NSString).deletingLastPathComponent
        if !directory.isEmpty {
            try? FileManager.default.createDirectory(
                atPath: directory, withIntermediateDirectories: true
            )
        }

        let db = try SqliteArmadaDb(db: try SqliteDriver(path: path))
        instances[path] = db
        return db
    }

    /// Forget the cached instances without closing them. For tests.
    static func resetForTesting() {
        lock.lock()
        defer { lock.unlock() }
        instances.removeAll()
    }
}

#if canImport(Darwin)

    /// Where the database file lives on Apple platforms.
    public enum ArmadaDbLocation {

        /// The App Group the app and its extensions share.
        ///
        /// The file lives in the GROUP container rather than the app's own
        /// sandbox because an extension can only see the group's. Nothing needs
        /// that yet — there are no iOS notifications — but the choice is not
        /// reversible after a release: moving the file later would strand
        /// decrypted Concord and NIP-17 history that exists nowhere else, so the
        /// container is picked before anything is stored in it rather than
        /// after.
        public static let appGroup = "group.buzz.armada.app"

        public static let fileName = "armada-db.sqlite"

        /// The database file inside the App Group container.
        ///
        /// Throws rather than falling back to the app's sandbox when the
        /// container is missing (the entitlement absent, or the group not
        /// provisioned). A fallback would be the same hazard as moving the file:
        /// the app would quietly store everything somewhere an extension can
        /// never read, and the split would only surface once notifications
        /// existed and had to be told which copy was real.
        public static func path(appGroup group: String = appGroup) throws -> String {
            guard
                let container = FileManager.default.containerURL(
                    forSecurityApplicationGroupIdentifier: group
                )
            else {
                throw ArmadaDbError.unusable(
                    "App Group \(group) is unavailable — the entitlement is missing or the "
                        + "group is not provisioned, and the store will not fall back to the "
                        + "app sandbox where an extension could never read it"
                )
            }

            return container.appendingPathComponent(fileName).path
        }
    }

#endif
