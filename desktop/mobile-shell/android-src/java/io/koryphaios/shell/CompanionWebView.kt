package io.koryphaios.shell

// The WebView that shows a paired Deck (PLAN N5, companion mode).
//
// Copy to android/app/src/main/java/io/koryphaios/shell/ after `cap add android`.
//
// A separate activity from the shell's own UI on purpose: the shell picks a
// host, this displays one. Backing out of it returns to the picker, which is
// what makes the multi-host list usable rather than a one-way door.
//
// PINNING. `onReceivedSslError` is the only hook a WebView gives for a
// self-signed certificate, and its default is to cancel. Proceeding
// unconditionally is the anti-pattern; proceeding only when the served
// certificate matches the digest from the QR is the pin.
//
// THE CREDENTIAL ROUND TRIP is what makes "restarting the app does not ask for
// a new QR" true, and it has two halves that are easy to get subtly wrong:
//
//  - SEEDING must happen before the page's own script reads the key, which
//    `onPageStarted` does NOT guarantee. `addDocumentStartJavaScript` exists
//    precisely for this and is used when available.
//  - HARVESTING cannot happen at page load: the host mints the credential
//    during the WebSocket handshake, so it appears a moment later. Hence the
//    short poll, and the value is left in a flat drop box for the shell to
//    fold into its list (all list logic stays in the tested TypeScript).

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.SslErrorHandler
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.security.MessageDigest

class CompanionWebView : Activity() {

    companion object {
        fun open(ctx: Context, url: String, fingerprint: String, seedScript: String) {
            ctx.startActivity(
                Intent(ctx, CompanionWebView::class.java)
                    .putExtra("url", url)
                    .putExtra("fingerprint", fingerprint)
                    .putExtra("seedScript", seedScript)
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A terminal is on the other side of this: no thumbnail, no screenshot.
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)

        val url = intent.getStringExtra("url") ?: return finish()
        val expected = intent.getStringExtra("fingerprint").orEmpty()
        val seedScript = intent.getStringExtra("seedScript").orEmpty()

        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = object : WebViewClient() {

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                val served = error.certificate
                    ?.let { fingerprintOf(it) }
                    .orEmpty()
                // Empty expectation = trust on first use (a QR from a Deck that
                // predates the fingerprint). Anything else must match exactly.
                if (expected.isEmpty() || MessageDigest.isEqual(served.toByteArray(), expected.toByteArray())) {
                    handler.proceed()
                    return
                }
                handler.cancel()
                android.util.Log.w("koryphaios", "companion certificate did not match the pin")
                finish()
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                // Fallback for devices without DOCUMENT_START_SCRIPT. Later
                // than ideal, but `connectRemoteApi` runs after the bundle
                // parses, so it usually still lands in time.
                if (seedScript.isNotEmpty() && !supportsDocumentStart()) {
                    view.evaluateJavascript(seedScript, null)
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                harvestCredential(view, attempt = 0)
            }
        }

        // The reliable seeding path: runs before ANY script on the page.
        if (seedScript.isNotEmpty() && supportsDocumentStart()) {
            WebViewCompat.addDocumentStartJavaScript(web, seedScript, setOf(originOf(url)))
        }

        setContentView(web)
        web.loadUrl(url)
    }

    private fun supportsDocumentStart(): Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

    /**
     * Copy the per-run credential out of the page so it survives the app.
     *
     * It is minted during the WebSocket handshake, not at page load, so this
     * polls briefly and gives up quietly — a missing credential only means the
     * next visit needs a fresh QR, which is the pre-existing behaviour.
     */
    private fun harvestCredential(view: WebView, attempt: Int) {
        if (attempt > 10) return
        view.evaluateJavascript(
            "sessionStorage.getItem('$CRED_KEY')"
        ) { raw ->
            // evaluateJavascript hands back a JSON literal: "null" or a quoted
            // string. Anything else is not a credential.
            val cred = raw?.takeIf { it.length > 2 && it.startsWith("\"") }
                ?.let { JSONObject("{\"v\":$it}").optString("v") }
                .orEmpty()
            if (cred.isEmpty()) {
                Handler(Looper.getMainLooper()).postDelayed({ harvestCredential(view, attempt + 1) }, 1_000)
                return@evaluateJavascript
            }
            storePendingCredential(cred)
        }
    }

    /** Flat drop box; the shell folds it into its host list on resume. */
    private fun storePendingCredential(credential: String) {
        val url = intent.getStringExtra("url").orEmpty()
        val origin = try {
            originOf(url)
        } catch (_: Exception) {
            return
        }
        getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString(
                "koryphaios.companion.lastcred",
                JSONObject().put("url", origin).put("credential", credential).toString()
            )
            .apply()
    }

    /** `https://host:port`, the identity the shell keys its host list on. */
    private fun originOf(url: String): String {
        val parsed = java.net.URI(url)
        val port = if (parsed.port == -1) "" else ":${parsed.port}"
        return "${parsed.scheme}://${parsed.host}$port"
    }

    private companion object {
        /** Mirrors COMPANION_CRED_STORAGE_KEY in desktop/src/shared/companion.ts. */
        const val CRED_KEY = "companion-cred"
    }

    /**
     * SHA-256 of the served certificate.
     *
     * `SslCertificate` only exposes the parsed fields on older APIs; since
     * API 29 the original X509 is available, which is what a digest needs.
     */
    private fun fingerprintOf(cert: android.net.http.SslCertificate): String {
        val x509 = cert.x509Certificate ?: return ""
        return MessageDigest.getInstance("SHA-256")
            .digest(x509.encoded)
            .joinToString("") { "%02x".format(it) }
    }
}
