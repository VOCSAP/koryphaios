package io.koryphaios.shell

// Certificate pinning for companion mode (PLAN MB6 native TODO).
//
// Copy to android/app/src/main/java/io/koryphaios/shell/ after `cap add android`.
//
// The Deck serves its UI over HTTPS with a SELF-SIGNED certificate, so the
// system trust store will always reject it. The naive fix — trust everything —
// would turn the LAN link into an open invitation to sit between the phone and
// the PC, on exactly the network where that is easiest.
//
// Instead: the certificate's SHA-256 travels in the pairing QR (`&f=`, added
// to `CompanionInfo` on the desktop side), and this trust manager accepts that
// digest and nothing else. The Deck's certificate is persisted and stable
// across launches, so the pin survives restarts and only changes if the
// operator wipes their app state — at which point they re-scan anyway.
//
// Trust-on-first-use fallback: a QR from a Deck predating the fingerprint
// carries none. Rather than refuse to pair, the shell records the digest it is
// served on first connection and pins THAT from then on — a downgrade in the
// first second only, and a visible one (the host row says "not pinned").

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

class PinnedTrustManager(
    /** Lowercase hex SHA-256 of the DER certificate, or "" for first use. */
    private var expected: String,
    private val onPinned: (String) -> Unit
) : X509TrustManager {

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        // This app is never a TLS server; a client chain has no meaning here.
        throw CertificateException("client authentication is not supported")
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("empty certificate chain")
        val actual = fingerprint(leaf)
        if (expected.isEmpty()) {
            // Trust on first use: remember it and pin from now on.
            expected = actual
            onPinned(actual)
            return
        }
        // Constant-time compare: the digest is public, but comparing digests
        // in constant time costs nothing and removes a whole class of question.
        if (!MessageDigest.isEqual(actual.toByteArray(), expected.toByteArray())) {
            throw CertificateException(
                "certificate does not match the pinned host — re-pair from the Deck if you replaced it"
            )
        }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

    private fun fingerprint(cert: X509Certificate): String =
        MessageDigest.getInstance("SHA-256")
            .digest(cert.encoded)
            .joinToString("") { "%02x".format(it) }
}

object PinnedTrust {
    /**
     * An SSLContext that trusts one host and one certificate.
     *
     * Install it on the WebView's network stack (or on the OkHttp client, if a
     * future version proxies the companion socket) BEFORE navigating — a
     * WebView that has already failed the handshake will not retry.
     */
    fun contextFor(expectedFingerprint: String, onPinned: (String) -> Unit): SSLContext =
        SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(PinnedTrustManager(expectedFingerprint, onPinned)), java.security.SecureRandom())
        }
}
