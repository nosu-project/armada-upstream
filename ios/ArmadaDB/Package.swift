// swift-tools-version:5.9
//
// ArmadaDB in Swift: the SQLite store the iOS build runs, shared by the WebView
// and — once notifications exist — by the APNs Notification Service Extension.
//
// It is a package rather than a folder of files in the app target for one
// reason: a package builds on Linux, so the conformance suite ported from
// `ArmadaDbTest.kt` runs as an ordinary `swift test` with no Mac and no
// simulator, exactly as the Kotlin suite runs on the JVM. Only the thin
// Capacitor plugin wrapper needs Xcode. An engine whose tests can only be run
// on hardware nobody's CI has is an engine that stops being tested.
//
// SQLite is VENDORED (`Sources/CArmadaSQLite`), not borrowed from the system,
// for the same reason androidx's bundled build is on Android: the schema needs
// FTS5 `contentless_delete` (3.43+) and JSON1, and Apple's libsqlite3 is
// whatever the OS image shipped — 3.43 only arrives around iOS 17, while the
// deployment target is 15.0. Bundling makes the engine's version a constant,
// and it is pinned to 3.50.1, the same release androidx bundles, so the two
// native platforms run the same SQLite rather than two that merely both pass.
import PackageDescription

let package = Package(
    name: "ArmadaDB",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "ArmadaDB", targets: ["ArmadaDB"]),
    ],
    targets: [
        .target(
            name: "CArmadaSQLite",
            cSettings: [
                // The schema's hard requirements. FTS5 is off by default in the
                // amalgamation; JSON1 has been built in since 3.38, and naming
                // it costs nothing and documents the dependency.
                .define("SQLITE_ENABLE_FTS5"),
                .define("SQLITE_ENABLE_JSON1"),
                // Serialized. The driver holds its own lock, but the app and
                // the extension are separate processes sharing a file, and a
                // mutex per API call is not measurable next to the work.
                .define("SQLITE_THREADSAFE", to: "1"),
                // Misquoted identifiers are a silent-wrong-answer bug, not a
                // convenience: with DQS on, a typo'd "column" parses as the
                // string literal 'column'.
                .define("SQLITE_DQS", to: "0"),
                // Nothing here loads an extension; FTS5 is compiled in.
                .define("SQLITE_OMIT_LOAD_EXTENSION"),
                .define("SQLITE_OMIT_DEPRECATED"),
                .define("SQLITE_DEFAULT_MEMSTATUS", to: "0"),
                .define("SQLITE_DEFAULT_WAL_SYNCHRONOUS", to: "1"),
                .define("SQLITE_LIKE_DOESNT_MATCH_BLOBS"),
                .define("SQLITE_USE_URI", to: "1"),
                .define("HAVE_USLEEP", to: "1"),
            ],
            linkerSettings: [
                .linkedLibrary("m", .when(platforms: [.linux])),
                .linkedLibrary("pthread", .when(platforms: [.linux])),
            ]
        ),
        .target(name: "ArmadaDB", dependencies: ["CArmadaSQLite"]),
        .testTarget(name: "ArmadaDBTests", dependencies: ["ArmadaDB"]),
    ]
)
