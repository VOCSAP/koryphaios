package io.koryphaios.parastates

// Foreground service holding the ntfy subscription open (PLAN N5).
//
// Copy to android/app/src/main/java/io/koryphaios/parastates/ after `cap add android`.
//
// WHY A SERVICE AT ALL. In Doze, Android suspends network access and ignores
// wakelocks, so the WebView's subscription dies within minutes of the screen
// going off. Approvals are precisely the thing you need while the phone is in
// a pocket, so this leg cannot live in the WebView.
//
// WHY `connectedDevice` AND NOT `dataSync`. Since Android 15, `dataSync` is
// capped at 6 hours per 24 — a cap that expires silently and would take the
// channel down overnight, when a long agent run is exactly what you left
// going. `connectedDevice` carries no such cap and is the honest description:
// the service maintains a link to the operator's own broker on their behalf.
// (`specialUse` is the fallback if a review ever objects; it requires a
// justification string in the manifest.)
//
// WHAT IT DOES NOT DO: it never decides anything. It reads bytes, matches the
// `parastates://` deep link, and posts a notification. Every rule about which
// messages count lives in the TypeScript modules under ../src/, which are
// under test; duplicating them here would be duplicating them wrong.

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class ApprovalService : android.app.Service() {

    companion object {
        const val CHANNEL_ID = "parastates-approvals"
        const val EXTRA_SERVER = "server"
        const val EXTRA_TOPIC = "topic"
        const val EXTRA_TOKEN = "token"

        /** Actions the notification offers; handled by ApprovalActionReceiver. */
        const val ACTION_ALLOW = "io.koryphaios.parastates.ALLOW"
        const val ACTION_DENY = "io.koryphaios.parastates.DENY"

        fun start(ctx: Context, server: String, topic: String, token: String) {
            val intent = Intent(ctx, ApprovalService::class.java)
                .putExtra(EXTRA_SERVER, server)
                .putExtra(EXTRA_TOPIC, topic)
                .putExtra(EXTRA_TOKEN, token)
            androidx.core.content.ContextCompat.startForegroundService(ctx, intent)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, ApprovalService::class.java))
        }
    }

    @Volatile private var running = false
    private var worker: Thread? = null
    /** Last message id seen: a reconnect resumes instead of replaying. */
    @Volatile private var since: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val server = intent?.getStringExtra(EXTRA_SERVER) ?: return START_NOT_STICKY
        val topic = intent.getStringExtra(EXTRA_TOPIC) ?: return START_NOT_STICKY
        val token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()

        ensureChannel()
        startForeground(1, ongoingNotification())

        if (!running) {
            running = true
            worker = thread(name = "parastates-ntfy") { listen(server, topic, token) }
        }
        // START_STICKY: an OEM that kills us should bring us back. The extras
        // are re-delivered because the intent is redelivered with them.
        return START_REDELIVER_INTENT
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        worker = null
        super.onDestroy()
    }

    /** The held-open GET. Reconnects with a bounded backoff, forever. */
    private fun listen(server: String, topic: String, token: String) {
        var backoffMs = 2_000L
        while (running) {
            var conn: HttpURLConnection? = null
            try {
                val suffix = since?.let { "?since=$it" }.orEmpty()
                conn = (URL("$server/$topic/json$suffix").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    if (token.isNotEmpty()) setRequestProperty("Authorization", "Bearer $token")
                    // No read timeout: the stream is SUPPOSED to stay silent
                    // between messages; ntfy sends keepalives of its own.
                    readTimeout = 0
                    connectTimeout = 20_000
                }
                if (conn.responseCode !in 200..299) throw IllegalStateException("HTTP ${conn.responseCode}")
                backoffMs = 2_000L
                conn.inputStream.bufferedReader().use { reader -> drain(reader) }
            } catch (e: Exception) {
                // Never silent: a channel that stopped delivering without a
                // trace is the failure mode this whole feature cannot afford.
                android.util.Log.w("parastates", "ntfy subscription dropped", e)
            } finally {
                conn?.disconnect()
            }
            if (!running) return
            try {
                Thread.sleep(backoffMs)
            } catch (_: InterruptedException) {
                return
            }
            backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
        }
    }

    private fun drain(reader: BufferedReader) {
        while (running) {
            val line = reader.readLine() ?: return
            if (line.isBlank()) continue
            val json = try {
                JSONObject(line)
            } catch (_: Exception) {
                continue
            }
            json.optString("id").takeIf { it.isNotEmpty() }?.let { since = it }
            val event = json.optString("event", "message")
            if (event != "message") continue
            onMessage(json)
        }
    }

    /**
     * Post or cancel a notification for one message.
     *
     * The `click` deep link is the only field trusted for routing — the title
     * and body are display strings written by an AGENT and are never parsed.
     */
    private fun onMessage(json: JSONObject) {
        val click = json.optString("click")
        val approvalId = idFrom(click, "approval")
        val settledId = idFrom(click, "settled")
        val manager = getSystemService(NotificationManager::class.java)

        if (settledId != null) {
            // ntfy cannot edit a delivered message, so a request answered
            // elsewhere is retired by cancelling its notification here.
            manager.cancel(settledId.hashCode())
            return
        }
        if (approvalId == null) return

        val title = json.optString("title").ifEmpty { "Parastates" }
        val body = json.optString("message")
        val hasButtons = json.optJSONArray("actions")?.length() ?: 0 > 0

        val open = PendingIntent.getActivity(
            this,
            approvalId.hashCode(),
            Intent(this, MainActivity::class.java)
                .putExtra("approvalId", approvalId)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(title)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(Notification.CATEGORY_CALL)
            .setAutoCancel(true)
            .setContentIntent(open)

        if (hasButtons) {
            builder.addAction(0, "Approve", answerIntent(ACTION_ALLOW, approvalId))
            builder.addAction(0, "Reject", answerIntent(ACTION_DENY, approvalId))
        }
        // Free text can never be a notification action: an ntfy action carries
        // a FIXED body, and Android's RemoteInput would still have to reach our
        // compose logic. So the third button opens the app on this request.
        builder.addAction(0, "Answer…", open)

        manager.notify(approvalId.hashCode(), builder.build())
    }

    private fun answerIntent(action: String, approvalId: String): PendingIntent =
        PendingIntent.getBroadcast(
            this,
            (action + approvalId).hashCode(),
            Intent(this, ApprovalActionReceiver::class.java)
                .setAction(action)
                .putExtra("approvalId", approvalId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    /** `parastates://<view>/<id>` -> id, or null when it is not that view. */
    private fun idFrom(click: String, view: String): String? {
        val prefix = "parastates://$view/"
        if (!click.startsWith(prefix)) return null
        val raw = click.removePrefix(prefix)
        if (raw.isEmpty() || raw.length > 64) return null
        return try {
            java.net.URLDecoder.decode(raw, "UTF-8")
        } catch (_: Exception) {
            null
        }
    }

    private fun ongoingNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Parastates")
            .setContentText("Listening for approvals")
            // Minimum priority: the ongoing notification is the price Android
            // charges for the service, not something to draw attention to.
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build()

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Approvals", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A session is waiting for you"
            }
        )
    }
}
