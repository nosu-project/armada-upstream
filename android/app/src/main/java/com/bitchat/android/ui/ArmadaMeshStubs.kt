package com.bitchat.android.ui

import android.content.Context
import android.content.SharedPreferences
import androidx.core.app.NotificationManagerCompat
import com.bitchat.android.model.BitchatMessage
import com.bitchat.android.util.NotificationIntervalManager

/**
 * ARMADA stubs for the bitchat `ui` package symbols referenced by the copied
 * mesh layer. The full bitchat Compose UI is intentionally NOT vendored; these
 * provide the minimal surface the mesh core compiles/links against.
 *
 * - DataManager: nickname store. Armada writes the logged-in profile display
 *   name into the "nickname" key (same prefs file bitchat used) via the
 *   BluetoothMesh Capacitor plugin, and NicknameProvider reads it here so mesh
 *   announces carry the Armada display name.
 * - NotificationManager / NotificationTextUtils: no-op DM notification surface.
 *   Native notifications can later be routed through Armada's existing
 *   ArmadaNotificationPlugin; for the first cut these are quiet no-ops.
 */
class DataManager(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("bitchat_prefs", Context.MODE_PRIVATE)

    /** Returns the stored nickname, or empty string if none set. */
    fun loadNickname(): String = prefs.getString("nickname", null) ?: ""

    fun saveNickname(nickname: String) {
        prefs.edit().putString("nickname", nickname).apply()
    }
}

object NotificationTextUtils {
    fun buildPrivateMessagePreview(message: BitchatMessage): String = message.content
}

@Suppress("UNUSED_PARAMETER")
class NotificationManager(
    context: Context,
    notificationManager: NotificationManagerCompat,
    notificationIntervalManager: NotificationIntervalManager
) {
    fun setAppBackgroundState(inBackground: Boolean) { /* no-op for first cut */ }

    fun showPrivateMessageNotification(
        senderPeerID: String,
        senderNickname: String,
        messageContent: String
    ) { /* no-op for first cut */ }
}
