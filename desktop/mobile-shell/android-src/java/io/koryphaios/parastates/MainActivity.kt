package io.koryphaios.parastates

// The activity (PLAN MB6 native TODOs).
//
// Copy to android/app/src/main/java/io/koryphaios/parastates/ after `cap add android`.
//
// Two protections, both about what is on screen rather than on the wire:
//
//  - FLAG_SECURE. Companion mode shows a TERMINAL. Paths, branch names and
//    occasionally a secret end up in the recent-apps thumbnail, which Android
//    persists to disk, and in any screenshot. The flag blocks both.
//  - A biometric gate on launch and on resume. Same reasoning as a messaging
//    app: the phone is unlocked and handed around far more often than a laptop,
//    and this one can approve `rm -rf` on a work machine.

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {

    companion object {
        /**
         * Asked for by a notification tap, not yet taken by the web shell.
         * Written by ApprovalTapActivity.
         */
        var pendingApprovalId = ""
    }

    /** Hidden until the gate passes, so a resume never flashes the content. */
    private var locked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ParastatesShellPlugin::class.java)
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        // A cold start reaches onResume without passing through onPause.
        armGate()
    }

    /**
     * Hand the pending approval over, once.
     *
     * Empty while locked: the shell answers by opening the viewer, a separate
     * activity that would sit above the biometric gate.
     */
    fun takeApprovalId(): String {
        if (locked) return ""
        return pendingApprovalId.also { pendingApprovalId = "" }
    }

    private fun announceApproval() {
        if (pendingApprovalId.isEmpty()) return
        bridge?.triggerWindowJSEvent("parastatesApproval")
    }

    override fun onPause() {
        super.onPause()
        // Arm on the way out, not on the way in: deciding at resume time would
        // mean the content is already composited when we ask.
        armGate()
    }

    private fun armGate() {
        if (!canAuthenticate()) return
        locked = true
        bridge?.webView?.visibility = android.view.View.INVISIBLE
    }

    override fun onResume() {
        super.onResume()
        if (!locked) {
            announceApproval()
            return
        }
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
                    announceApproval()
                }

                override fun onAuthenticationError(code: Int, message: CharSequence) {
                    // The system cancelled, not the operator: a system dialog
                    // opened at boot may cover the prompt. The app stays locked
                    // and the next resume asks again.
                    if (code == BiometricPrompt.ERROR_CANCELED) return
                    // A refused unlock closes the app rather than leaving a
                    // blank activity the operator has to guess their way out of.
                    // The tap goes with it, or a later launch would serve it.
                    pendingApprovalId = ""
                    finish()
                }
            }
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("Parastates")
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
