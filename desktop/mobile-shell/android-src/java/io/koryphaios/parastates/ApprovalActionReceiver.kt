package io.koryphaios.parastates

// Approve / Reject straight from the notification (PLAN N5).
//
// Copy to android/app/src/main/java/io/koryphaios/parastates/ after `cap add android`.
//
// The envelope this publishes is the SAME one `encodeAnswer` produces in
// `notify/ntfy-protocol.ts` — a tap here and a tap in the app must be
// indistinguishable to the broker. It is spelled out by hand only because
// Kotlin cannot call the TypeScript; the format is fixed by that module and
// its tests, and a change there is a change here.
//
// C-1 HOLDS: this decides nothing. It publishes the operator's intent and
// stops. Whether the answer wins is the broker's call, and the phone learns
// the outcome the same way it learns everything else — through a message on
// the notification topic.

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class ApprovalActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val approvalId = intent.getStringExtra("approvalId") ?: return
        val kind = when (intent.action) {
            ApprovalService.ACTION_ALLOW -> "allow"
            ApprovalService.ACTION_DENY -> "deny"
            else -> return
        }

        // Retire the notification immediately: leaving it up while the request
        // flies would invite a second tap on something already answered.
        context.getSystemService(NotificationManager::class.java).cancel(approvalId.hashCode())

        val prefs = capacitorPreferences(context)
        val pairing = prefs.getString("koryphaios.approvals.pairing", null) ?: return
        val json = try {
            JSONObject(pairing)
        } catch (_: Exception) {
            return
        }
        val server = json.optString("server")
        val topic = json.optString("topic_replies")
        val token = json.optString("token")
        val device = json.optString("device")
        if (server.isEmpty() || topic.isEmpty()) return

        // goAsync() would bound us to ~10 s; a fire-and-forget thread is
        // enough because the broker is the durable side of this exchange.
        val pending = goAsync()
        thread(name = "parastates-answer") {
            try {
                publish(server, topic, token, body(approvalId, kind, device))
            } catch (e: Exception) {
                android.util.Log.w("parastates", "answer could not be published", e)
            } finally {
                pending.finish()
            }
        }
    }

    /** Mirrors `encodeAnswer` in notify/ntfy-protocol.ts (v1 envelope). */
    private fun body(approvalId: String, kind: String, device: String): String =
        JSONObject().apply {
            put("v", 1)
            put("t", "answer")
            put("a", approvalId)
            put("k", kind)
            if (device.isNotEmpty()) put("d", device)
        }.toString()

    private fun publish(server: String, topic: String, token: String, body: String) {
        val conn = (URL("$server/$topic").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 15_000
            setRequestProperty("Content-Type", "text/plain")
            if (token.isNotEmpty()) setRequestProperty("Authorization", "Bearer $token")
        }
        try {
            conn.outputStream.use { it.write(body.toByteArray()) }
            if (conn.responseCode !in 200..299) {
                android.util.Log.w("parastates", "ntfy refused the answer: ${conn.responseCode}")
            }
        } finally {
            conn.disconnect()
        }
    }

    /**
     * The store Capacitor Preferences writes into.
     *
     * Reading the app's own state from the native side rather than passing the
     * credentials through the PendingIntent: an intent extra is readable by
     * anything that can inspect the pending intent, and the access token has
     * no business travelling that way.
     */
    private fun capacitorPreferences(context: Context): SharedPreferences =
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
}
