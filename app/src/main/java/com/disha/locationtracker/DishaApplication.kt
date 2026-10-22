package com.disha.locationtracker

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import com.disha.locationtracker.data.local.AppPreferences
import com.disha.locationtracker.data.local.OfflineLocationDbHelper
import com.disha.locationtracker.data.remote.ApiClient
import com.disha.locationtracker.data.repository.TrackerRepository
import com.disha.locationtracker.update.UpdateManager

class DishaApplication : Application() {

    lateinit var prefs: AppPreferences
        private set

    lateinit var dbHelper: OfflineLocationDbHelper
        private set

    lateinit var apiClient: ApiClient
        private set

    lateinit var repository: TrackerRepository
        private set

    lateinit var updateManager: UpdateManager
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this

        prefs = AppPreferences(this)
        dbHelper = OfflineLocationDbHelper(this)
        apiClient = ApiClient(prefs)
        repository = TrackerRepository(prefs, dbHelper, apiClient)
        updateManager = UpdateManager(this, prefs)

        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID_TRACKING,
                getString(R.string.tracking_notification_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Displays real-time transparent status for DISHA duty tracking"
                setShowBadge(false)
            }

            val notificationManager =
                getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }

    companion object {
        const val CHANNEL_ID_TRACKING = "disha_tracking_channel"
        lateinit var instance: DishaApplication
            private set
    }
}
