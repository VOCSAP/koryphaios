package io.koryphaios.shell

// The activity (PLAN MB6 native TODOs).
//
// Copy to android/app/src/main/java/io/koryphaios/shell/ after `cap add android`.
//
// Two protections, both about what is on screen rather than on the wire:
//
//  - FLAG_SECURE. Companion mode shows a TERMINAL. Paths, branch names and
//    occasionally a secret end up in the recent-apps thumbnail, which Android
//    persists to disk, and in any screenshot. The flag blocks both.
//  - A biometric gate on resume. Same reasoning as a messaging app: the phone
//    is unlocked and handed around far more often than a laptop, and this one
//    can approve `rm -rf` on a work machine.

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {

    /** Hidden until the gate passes, so a resume never flashes the content. */
    private var locked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(KoryphaiosShellPlugin::class.java)
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    override fun onPause() {
        super.onPause()
        // Arm on the way out, not on the way in: deciding at resume time would
        // mean the content is already composited when we ask.
        if (canAuthenticate()) {
            locked = true
            bridge?.webView?.visibility = android.view.View.INVISIBLE
        }
    }

    override fun onResume() {
        super.onResume()
        if (!locked) return
        promptBiometric()
    }

    private fun canAuthenticate(): Boolean =
        BiometricManager.from(this).canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        ) == BiometricManager.BIOMETRIC_SUCCESS

    private fun promptBiometric() {
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    locked = false
                    bridge?.webView?.visibility = android.view.View.VISIBLE
                }

                override fun onAuthenticationError(code: Int, message: CharSequence) {
                    // A refused unlock closes the app rather than leaving a
                    // blank activity the operator has to guess their way out of.
                    finish()
                }
            }
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("Koryphaios")
                .setSubtitle("Unlock to continue")
                .setAllowedAuthenticators(
                    BiometricManager.Authenticators.BIOMETRIC_WEAK or
                        BiometricManager.Authenticators.DEVICE_CREDENTIAL
                )
                .build()
        )
    }

    /** Android 13+ needs the runtime permission before a notification shows. */
    fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
    }
}
