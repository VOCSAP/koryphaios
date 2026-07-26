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

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.http.SslError
import android.os.Bundle
import android.view.WindowManager
import android.webkit.SslErrorHandler
import android.webkit.WebView
import android.webkit.WebViewClient
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
                // The resume credential goes in BEFORE the page's own script
                // reads it. `connectRemoteApi` boots from a stored credential
                // alone, so this is all a resume needs.
                if (seedScript.isNotEmpty()) view.evaluateJavascript(seedScript, null)
            }
        }
        setContentView(web)
        web.loadUrl(url)
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
