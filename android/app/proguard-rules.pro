# R8 rules for the release build (minifyEnabled true).
#
# Most of what the app needs is already covered without being repeated here:
#   - AGP's proguard-android.txt keeps @android.webkit.JavascriptInterface
#     methods, which is what Capacitor's `androidBridge` (MessageHandler
#     .postMessage) is reached by — rename it and the WebView talks to nothing.
#   - @capacitor/android ships consumer rules (its own proguard-rules.pro,
#     wired in by consumerProguardFiles) keeping `* extends Plugin`, the
#     @CapacitorPlugin/@PluginMethod members, and Cordova plugin classes,
#     which are all instantiated and dispatched to reflectively.
#   - sqlite-bundled and secp256k1-kmp-jni-android ship consumer rules for
#     their JNI entry points; gson, okhttp and kotlinx-coroutines ship theirs.
# Keep this file to what those don't cover.

# Gson persists these to disk BY FIELD NAME (bitchat's favorites, seen-message
# store, noise channel keys, and the message model). A renamed field is a
# renamed JSON key, so an obfuscated build would read an existing file back as
# empty rather than fail loudly. Field names only — the code is still shrunk.
-keep class com.bitchat.android.model.** { *; }
-keepclassmembers class com.bitchat.android.** { <fields>; }
