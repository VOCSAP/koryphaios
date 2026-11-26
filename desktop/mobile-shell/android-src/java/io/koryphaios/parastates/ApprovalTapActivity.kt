package io.koryphaios.parastates

// Where a tap on an approval notification lands: it records the approval id and
// brings MainActivity up.
//
// Copy to android/app/src/main/java/io/koryphaios/parastates/ after `cap add android`.
//
// Not exported, so only this app's own PendingIntent can hand an id over.
// MainActivity is exported and reads none from its Intent: any app could send
// one and have the paired Deck opened.
//
// An activity rather than a receiver: since Android 12 a receiver reached from
// a notification tap may not start an activity
// (developer.android.com/about/versions/12/behavior-changes-12).

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class ApprovalTapActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        MainActivity.pendingApprovalId = intent.getStringExtra("approvalId").orEmpty()
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
