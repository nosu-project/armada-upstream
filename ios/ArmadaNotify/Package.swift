// swift-tools-version:5.9
//
// ArmadaNotify: the decrypt/store/present pipeline the iOS Notification Service
// Extension runs, and the third port of it.
//
// The other two are `public/sw.js` + `src/sw/pushRuntime.ts` on the web and
// `Dm17.kt` + `ServiceStore.kt` on Android. All three exist for the same
// reason: the push gateway is content-blind, so it can only say that SOMETHING
// matching a filter arrived. Whoever wants to name the sender or show the
// message has to open the event themselves, with the user's key, on the device.
//
// It is a package rather than files in the extension target for the reason
// ArmadaDB is: a package builds and TESTS on Linux, with no Mac and no
// simulator. That matters more here than anywhere else in the project — this is
// the code that decides whether a rumor is authentic, and a suite that can only
// run on hardware nobody's CI has is a suite that stops running.
//
// libsecp256k1 is VENDORED (`Sources/CArmadaSecp256k1`, upstream v0.7.0), the
// same call SQLite gets in ArmadaDB and the same library Android reaches
// through ACINQ's bindings. Only two modules are compiled in: `extrakeys` and
// `schnorrsig`. ECDH deliberately does NOT use the `ecdh` module — that helper
// returns a SHA-256 of the shared point, while NIP-44 hashes the bare
// x-coordinate itself, so the key agreement goes through
// `secp256k1_ec_pubkey_tweak_mul` exactly as `NostrCrypto.java` does.
//
// Everything ABOVE the curve is hand-written pure Swift: SHA-256, HMAC, HKDF
// and ChaCha20 (`Crypto.swift`). CryptoKit has all but ChaCha20 in raw form —
// it only exposes ChaChaPoly — so using it would mean two implementations of
// the hash chain, one for Apple platforms and one for the Linux suite, and the
// suite would then be testing code the extension does not run. One
// implementation, one set of vectors, both platforms.
import PackageDescription

let package = Package(
    name: "ArmadaNotify",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "ArmadaNotify", targets: ["ArmadaNotify"]),
    ],
    dependencies: [
        .package(path: "../ArmadaDB"),
    ],
    targets: [
        .target(
            name: "CArmadaSecp256k1",
            exclude: ["src/asm"],
            cSettings: [
                // The checked-in `precomputed_ecmult.c` table is generated for
                // this window size; they must agree.
                .define("ECMULT_WINDOW_SIZE", to: "15"),
                // x-only public keys (BIP-340) and the Schnorr verify that
                // authenticates a Concord seal. Nothing else is compiled in.
                .define("ENABLE_MODULE_EXTRAKEYS"),
                .define("ENABLE_MODULE_SCHNORRSIG"),
            ]
        ),
        .target(name: "ArmadaNotify", dependencies: ["CArmadaSecp256k1", "ArmadaDB"]),
        .testTarget(name: "ArmadaNotifyTests", dependencies: ["ArmadaNotify"]),
    ],
    cLanguageStandard: .c89
)
