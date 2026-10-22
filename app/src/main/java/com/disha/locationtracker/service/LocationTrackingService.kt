package com.disha.locationtracker.service

import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.disha.locationtracker.DishaApplication
import com.disha.locationtracker.R
import com.disha.locationtracker.ui.MainActivity
import com.disha.locationtracker.util.DutyTimeHelper
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.*
import kotlinx.coroutines.*
import java.text.SimpleDateFormat
import java.util.*

class LocationTrackingService : Service(), LocationListener {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var wakeLock: PowerManager.WakeLock? = null

    // Google Play Services Fused Location
    private var fusedLocationClient: FusedLocationProviderClient? = null
    private var locationCallback: LocationCallback? = null

    // Fallback Android LocationManager
    private var locationManager: LocationManager? = null

    private var heartbeatJob: Job? = null
    private var offlineSyncJob: Job? = null
    private var lastLocation: Location? = null
    private var lastVerifiedLocation: Location? = null
    private var isTrackingStarted = false
    private var lastTrailRecordedElapsedRealtimeMs = 0L
    private var lastLiveTransmittedElapsedRealtimeMs = 0L
    private var isFirstDutyPoint = true
    private var lastGpsLocationTime: Long = 0L
    private var lastGpsElapsedRealtime: Long = 0L
    private var wasLocationAvailable: Boolean = true

    override fun onCreate() {
        super.onCreate()
        acquireWakeLock()
        startInForeground()
        startLocationUpdates()
        startPeriodicHeartbeats()
        startPeriodicOfflineSync()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP_TRACKING -> {
                stopTracking()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_TRIGGER_SOS -> {
                serviceScope.launch {
                    DishaApplication.instance.repository.triggerSOS()
                    updateNotification(lastLocation)
                }
            }
            ACTION_START_TRACKING -> {
                isFirstDutyPoint = true
                lastTrailRecordedElapsedRealtimeMs = 0L
                lastLiveTransmittedElapsedRealtimeMs = 0L
                // Idempotent: ensure updates are flowing and notification is current
                if (!isTrackingStarted) {
                    startLocationUpdates()
                }
                updateNotification(lastLocation)
            }
        }
        return START_STICKY
    }

    private fun acquireWakeLock() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "DishaTracker::TrackingWakeLock"
        ).apply {
            setReferenceCounted(false)
            acquire(24 * 60 * 60 * 1000L) // Safe 24-hr max duration
        }
    }

    private fun startInForeground() {
        val notification = buildNotification("Initializing persistent GPS tracking...")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    @SuppressLint("MissingPermission")
    private fun startLocationUpdates() {
        val prefs = DishaApplication.instance.prefs
        if (!prefs.isLoggedIn) {
            stopTracking()
            stopSelf()
            return
        }

        if (!hasLocationPermissions()) {
            updateNotification(null, "Location permission missing or disabled.")
            return
        }

        // Check Google Play Services availability
        val googleApi = GoogleApiAvailability.getInstance()
        val playServicesAvailable = googleApi.isGooglePlayServicesAvailable(this) == ConnectionResult.SUCCESS

        if (playServicesAvailable) {
            startFusedLocationUpdates()
        } else {
            startLocationManagerFallback()
        }
        isTrackingStarted = true
    }

    @SuppressLint("MissingPermission")
    private fun startFusedLocationUpdates() {
        try {
            fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)

            val locationRequest = LocationRequest.Builder(
                Priority.PRIORITY_HIGH_ACCURACY,
                LOCATION_INTERVAL_MS
            )
                .setMinUpdateIntervalMillis(LOCATION_FASTEST_INTERVAL_MS)
                .setMinUpdateDistanceMeters(LOCATION_MIN_DISTANCE_M)
                .setMaxUpdateDelayMillis(LOCATION_MAX_WAIT_MS)
                .build()

            locationCallback = object : LocationCallback() {
                override fun onLocationResult(result: LocationResult) {
                    val location = result.lastLocation ?: return
                    val source = if (location.provider == LocationManager.GPS_PROVIDER) "GPS" else "NETWORK"
                    handleNewLocation(location, source)
                }

                override fun onLocationAvailability(avail: LocationAvailability) {
                    if (!avail.isLocationAvailable) {
                        updateNotification(lastLocation, "Acquiring GPS / Network fix...")
                    }
                }
            }

            fusedLocationClient?.requestLocationUpdates(
                locationRequest,
                locationCallback!!,
                Looper.getMainLooper()
            )?.addOnFailureListener {
                // If Play Services request fails, fall back to native LocationManager
                startLocationManagerFallback()
            }

            // Immediately check last known location to prime initial state if recent (< 60s)
            fusedLocationClient?.lastLocation?.addOnSuccessListener { loc ->
                if (loc != null && lastLocation == null) {
                    val ageMs = (SystemClock.elapsedRealtimeNanos() - loc.elapsedRealtimeNanos) / 1_000_000L
                    if (ageMs <= 60_000L) {
                        val source = if (loc.provider == LocationManager.GPS_PROVIDER) "GPS" else "NETWORK"
                        handleNewLocation(loc, source)
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
            startLocationManagerFallback()
        }
    }

    @SuppressLint("MissingPermission")
    private fun startLocationManagerFallback() {
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val isGpsEnabled = locationManager?.isProviderEnabled(LocationManager.GPS_PROVIDER) == true
        val isNetEnabled = locationManager?.isProviderEnabled(LocationManager.NETWORK_PROVIDER) == true

        if (!isGpsEnabled && !isNetEnabled) {
            updateNotification(null, "Device location is turned off in Android Settings.")
            return
        }

        try {
            if (isGpsEnabled) {
                locationManager?.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    LOCATION_INTERVAL_MS,
                    LOCATION_MIN_DISTANCE_M,
                    this,
                    Looper.getMainLooper()
                )
            }
            if (isNetEnabled) {
                locationManager?.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    LOCATION_INTERVAL_MS + 2000L,
                    LOCATION_MIN_DISTANCE_M,
                    this,
                    Looper.getMainLooper()
                )
            }

            val lastGps = locationManager?.getLastKnownLocation(LocationManager.GPS_PROVIDER)
            val lastNet = locationManager?.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            val bestCandidate = when {
                lastGps != null && lastNet != null -> if (lastGps.time >= lastNet.time) lastGps else lastNet
                lastGps != null -> lastGps
                else -> lastNet
            }
            if (bestCandidate != null && lastLocation == null) {
                val ageMs = (SystemClock.elapsedRealtimeNanos() - bestCandidate.elapsedRealtimeNanos) / 1_000_000L
                if (ageMs <= 60_000L) {
                    handleNewLocation(bestCandidate, if (bestCandidate.provider == LocationManager.GPS_PROVIDER) "GPS" else "NETWORK")
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override fun onLocationChanged(location: Location) {
        val src = if (location.provider == LocationManager.GPS_PROVIDER) "GPS" else "NETWORK"
        handleNewLocation(location, src)
    }

    private fun handleNewLocation(location: Location, providerSource: String) {
        val prefs = DishaApplication.instance.prefs
        if (!prefs.isLoggedIn) {
            stopTracking()
            stopSelf()
            return
        }

        // 1. Mandatory Duty Window Enforcement (if legacy restricted hours are enabled)
        if (!DutyTimeHelper.isWithinDutyWindow()) {
            updateNotification(lastLocation, "Standby: Outside restricted duty window (07:00 AM – 10:00 PM IST)")
            return
        }

        // 2. Sanity check: Reject non-finite coordinates or (0,0)
        if (!location.latitude.isFinite() || !location.longitude.isFinite() ||
            (location.latitude == 0.0 && location.longitude == 0.0) ||
            Math.abs(location.latitude) > 90.0 || Math.abs(location.longitude) > 180.0
        ) {
            return
        }

        // 3. Freshness check: Reject stale cached fixes (> 60s elapsed age) if we already have a recent fix
        val ageMs = (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000L
        if (ageMs > 60_000L && lastLocation != null) {
            return
        }

        // 4. Out-of-order check: Reject fixes timestamped older than last known by > 5 seconds
        val prev = lastLocation
        if (prev != null && location.time < prev.time - 5000L) {
            return
        }

        // 5. Track GPS vs Network fix timestamp
        val isGpsFix = location.provider == LocationManager.GPS_PROVIDER || providerSource == "GPS"
        val fixTimestamp = if (location.time > 0L) location.time else System.currentTimeMillis()
        if (isGpsFix) {
            lastGpsLocationTime = fixTimestamp
            lastGpsElapsedRealtime = SystemClock.elapsedRealtime()
        }

        // 6. Quality Selection & Coarse Fix Dampening:
        // A location with accuracy <= 20.0m is VERIFIED.
        // A location with accuracy > 20.0m is COARSE (e.g. 69m cell tower bounce).
        // If we have a fresh verified fix (<= 20m) recorded within the last 60 seconds:
        // Do NOT let a coarse fix (> 20m) displace our verified location on the building!
        val isSos = prefs.isSosActive
        val prevVerified = lastVerifiedLocation
        if (location.hasAccuracy() && location.accuracy > 20f && prevVerified != null && !isSos) {
            val verifiedAgeMs = (SystemClock.elapsedRealtimeNanos() - prevVerified.elapsedRealtimeNanos) / 1_000_000L
            if (verifiedAgeMs < 60_000L) {
                // Keep the verified location as primary, do not let coarse cellular bounce displace it
                updateNotification(prevVerified, "GPS: ±${Math.round(prevVerified.accuracy)}m (Acquiring satellites...)")
                return
            }
        }

        // If the new fix is verified (<= 20m), store it as our verified anchor
        if (location.hasAccuracy() && location.accuracy <= 20f) {
            lastVerifiedLocation = location
        }

        lastLocation = location

        val batteryLevel = getBatteryPercentage()
        val networkState = getNetworkType()

        // Normalize source strictly to "GPS" or "NETWORK" for backend Prisma enum compatibility
        val normalizedSource = when {
            isGpsFix -> "GPS"
            location.provider == LocationManager.NETWORK_PROVIDER || providerSource == "NETWORK" -> "NETWORK"
            else -> "NETWORK"
        }

        // Always keep local notification and UI fresh with the latest real fix
        updateNotification(location)

        // 7. 30-Minute Historical Trail Recording & Live Map Telemetry Gate:
        // - Live Map: Update real-time position on the admin dashboard every ~30 seconds (or on SOS / first fix)
        // - Historical Trail: Persist historical trail point approximately every 30 minutes (1,800,000 ms)
        val nowElapsed = SystemClock.elapsedRealtime()
        val elapsedSinceLastTrail = nowElapsed - lastTrailRecordedElapsedRealtimeMs
        val isHistoricalDue = isSos || isFirstDutyPoint || (elapsedSinceLastTrail >= trailRecordingIntervalMs)

        val elapsedSinceLastLive = nowElapsed - lastLiveTransmittedElapsedRealtimeMs
        val isLiveDue = isSos || isFirstDutyPoint || (elapsedSinceLastLive >= LIVE_TRANSMISSION_INTERVAL_MS)

        if (!isLiveDue && !isHistoricalDue) {
            // Live map position transmitted recently and 30-minute historical interval has not elapsed yet.
            // Live notification and local state are already updated above.
            return
        }

        lastLiveTransmittedElapsedRealtimeMs = nowElapsed
        if (isHistoricalDue) {
            lastTrailRecordedElapsedRealtimeMs = nowElapsed
            isFirstDutyPoint = false
        }

        serviceScope.launch {
            DishaApplication.instance.repository.recordAndTransmitLocation(
                latitude = location.latitude,
                longitude = location.longitude,
                accuracy = location.accuracy,
                source = normalizedSource,
                locationTimestamp = fixTimestamp,
                batteryLevel = batteryLevel,
                networkState = networkState,
                isHistoricalScheduled = isHistoricalDue
            )
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

    override fun onProviderEnabled(provider: String) {
        if (provider == LocationManager.GPS_PROVIDER) {
            serviceScope.launch {
                DishaApplication.instance.repository.sendLocationEvent(
                    "LOCATION_RECOVERED",
                    mapOf("provider" to provider, "reason" to "GPS provider enabled")
                )
            }
        }
        startLocationUpdates()
    }

    override fun onProviderDisabled(provider: String) {
        if (provider == LocationManager.GPS_PROVIDER) {
            serviceScope.launch {
                DishaApplication.instance.repository.sendLocationEvent(
                    "LOCATION_UNAVAILABLE",
                    mapOf("provider" to provider, "reason" to "GPS provider disabled")
                )
            }
        }
        updateNotification(lastLocation, "Location provider ($provider) disabled on device")
    }

    private fun startPeriodicHeartbeats() {
        heartbeatJob = serviceScope.launch {
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                val prefs = DishaApplication.instance.prefs
                if (!prefs.isLoggedIn) {
                    stopTracking()
                    stopSelf()
                    break
                }
                val battery = getBatteryPercentage()
                val net = getNetworkType()
                val appVersion = "1.0.0"

                val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                val locEnabled = if (lm != null) LocationManagerCompat.isLocationEnabled(lm) else false
                val fineGranted = ContextCompat.checkSelfPermission(
                    this@LocationTrackingService,
                    android.Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                val coarseGranted = ContextCompat.checkSelfPermission(
                    this@LocationTrackingService,
                    android.Manifest.permission.ACCESS_COARSE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                val permState = when {
                    fineGranted -> "GRANTED"
                    coarseGranted -> "PARTIAL"
                    else -> "DENIED"
                }
                val isGpsAvail = lm?.isProviderEnabled(LocationManager.GPS_PROVIDER) == true &&
                        (SystemClock.elapsedRealtime() - lastGpsElapsedRealtime <= 60_000L || lastGpsElapsedRealtime == 0L)
                val lastGpsIso = if (lastGpsLocationTime > 0L) {
                    DishaApplication.instance.repository.getIsoTimestamp(Date(lastGpsLocationTime))
                } else null

                // Detect state transitions to emit audit event
                if (!locEnabled && wasLocationAvailable) {
                    wasLocationAvailable = false
                    DishaApplication.instance.repository.sendLocationEvent(
                        "LOCATION_UNAVAILABLE",
                        mapOf("reason" to "Location disabled in Android Settings")
                    )
                } else if (locEnabled && !wasLocationAvailable) {
                    wasLocationAvailable = true
                    DishaApplication.instance.repository.sendLocationEvent(
                        "LOCATION_RECOVERED",
                        mapOf("reason" to "Location restored in Android Settings")
                    )
                }

                DishaApplication.instance.repository.sendHeartbeat(
                    batteryLevel = battery,
                    networkState = net,
                    appVersion = appVersion,
                    locationEnabled = locEnabled,
                    permissionState = permState,
                    isTrackingRunning = isTrackingStarted,
                    gpsAvailable = isGpsAvail,
                    lastGpsFixTime = lastGpsIso
                )
            }
        }
    }

    private fun startPeriodicOfflineSync() {
        offlineSyncJob = serviceScope.launch {
            while (isActive) {
                delay(OFFLINE_SYNC_INTERVAL_MS)
                val prefs = DishaApplication.instance.prefs
                if (!prefs.isLoggedIn) break
                try {
                    DishaApplication.instance.repository.syncOfflineQueue()
                } catch (e: Exception) {
                    // Suppress transient offline exceptions
                }
            }
        }
    }

    private fun updateNotification(location: Location?, extraStatus: String? = null) {
        val prefs = DishaApplication.instance.prefs
        val statusText = when {
            extraStatus != null -> extraStatus
            prefs.isSosActive -> "EMERGENCY SOS BROADCASTING"
            !DutyTimeHelper.isWithinDutyWindow() -> "Standby: Outside restricted duty window (07:00 AM – 10:00 PM IST)"
            location != null -> {
                val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(location.time))
                val providerTag = if (location.provider == LocationManager.GPS_PROVIDER) "GPS" else "Network"
                val accRating = when {
                    location.accuracy <= 10.0f -> "Optimal (≤10m)"
                    location.accuracy <= 20.0f -> "Verified (≤20m)"
                    else -> "Low Accuracy (±${Math.round(location.accuracy)}m)"
                }
                String.format(
                    Locale.US,
                    "Lat: %.5f, Lng: %.5f (±%.0fm • %s • %s) • %s",
                    location.latitude,
                    location.longitude,
                    location.accuracy,
                    providerTag,
                    accRating,
                    timeStr
                )
            }
            else -> "Acquiring high-accuracy GPS fix..."
        }

        val notification = buildNotification(statusText)
        val notificationManager =
            getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        notificationManager.notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(contentText: String): Notification {
        val prefs = DishaApplication.instance.prefs
        val title = when {
            prefs.isSosActive -> "DISHA — EMERGENCY SOS ACTIVE"
            !DutyTimeHelper.isWithinDutyWindow() -> "DISHA — Standby"
            else -> "DISHA Field Tracker — 24×7 Tracking Active"
        }

        val openActivityIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val openActivityPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openActivityIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Action button to stop tracking safely from the notification
        val stopIntent = Intent(this, LocationTrackingService::class.java).apply {
            action = ACTION_STOP_TRACKING
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            1003,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, DishaApplication.CHANNEL_ID_TRACKING)
            .setContentTitle(title)
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_location)
            .setContentIntent(openActivityPendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(
                R.drawable.ic_location,
                "Stop Tracking",
                stopPendingIntent
            )

        return builder.build()
    }

    private fun hasLocationPermissions(): Boolean {
        val fine = ContextCompat.checkSelfPermission(
            this,
            android.Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            this,
            android.Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return fine || coarse
    }

    private fun getBatteryPercentage(): Float? {
        val batteryStatus: Intent? = registerReceiver(
            null,
            android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        )
        val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        return if (level >= 0 && scale > 0) {
            (level / scale.toFloat()) * 100f
        } else {
            null
        }
    }

    private fun getNetworkType(): String {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val activeNetwork = cm.activeNetwork ?: return "OFFLINE"
        val capabilities = cm.getNetworkCapabilities(activeNetwork) ?: return "OFFLINE"
        return when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WIFI"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "CELLULAR"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ETHERNET"
            else -> "OTHER"
        }
    }

    private fun stopTracking() {
        isTrackingStarted = false
        isFirstDutyPoint = true
        lastTrailRecordedElapsedRealtimeMs = 0L
        lastLiveTransmittedElapsedRealtimeMs = 0L
        try {
            locationCallback?.let { fusedLocationClient?.removeLocationUpdates(it) }
            locationCallback = null
            fusedLocationClient = null
            locationManager?.removeUpdates(this)
            locationManager = null
        } catch (e: Exception) {
            e.printStackTrace()
        }
        heartbeatJob?.cancel()
        offlineSyncJob?.cancel()
        serviceScope.cancel()

        wakeLock?.let {
            if (it.isHeld) {
                it.release()
            }
        }
        wakeLock = null

        DishaApplication.instance.prefs.isSosActive = false
    }

    override fun onDestroy() {
        stopTracking()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val NOTIFICATION_ID = 1001
        const val ACTION_START_TRACKING = "com.disha.action.START_TRACKING"
        const val ACTION_STOP_TRACKING = "com.disha.action.STOP_TRACKING"
        const val ACTION_TRIGGER_SOS = "com.disha.action.TRIGGER_SOS"

        // 30-minute trail recording interval (1,800,000 ms)
        const val DEFAULT_TRAIL_RECORDING_INTERVAL_MS = 30 * 60 * 1000L
        var trailRecordingIntervalMs: Long = DEFAULT_TRAIL_RECORDING_INTERVAL_MS

        // Live Map real-time transmission interval (30 seconds)
        const val LIVE_TRANSMISSION_INTERVAL_MS = 30_000L

        // Fused Location request interval: check location every 30 seconds to maintain warm GPS lock
        private const val LOCATION_INTERVAL_MS = 30_000L
        private const val LOCATION_FASTEST_INTERVAL_MS = 15_000L
        private const val LOCATION_MIN_DISTANCE_M = 0f
        private const val LOCATION_MAX_WAIT_MS = 60_000L

        private const val HEARTBEAT_INTERVAL_MS = 60_000L // 60 seconds
        private const val OFFLINE_SYNC_INTERVAL_MS = 30_000L // 30 seconds

        fun start(context: Context) {
            val intent = Intent(context, LocationTrackingService::class.java).apply {
                action = ACTION_START_TRACKING
            }
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, LocationTrackingService::class.java).apply {
                action = ACTION_STOP_TRACKING
            }
            context.startService(intent)
        }
    }
}
