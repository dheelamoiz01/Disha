package com.disha.locationtracker.service

import android.annotation.SuppressLint
import android.app.AlarmManager
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
import android.net.Network
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

    private var serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var wakeLock: PowerManager.WakeLock? = null

    // Google Play Services Fused Location
    private var fusedLocationClient: FusedLocationProviderClient? = null
    private var locationCallback: LocationCallback? = null

    // Fallback Android LocationManager
    private var locationManager: LocationManager? = null

    private var heartbeatJob: Job? = null
    private var offlineSyncJob: Job? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var lastLocation: Location? = null
    private var lastVerifiedLocation: Location? = null
    private var isTrackingStarted = false
    private var lastTrailRecordedElapsedRealtimeMs = 0L
    private var lastLiveTransmittedElapsedRealtimeMs = 0L
    private var lastTransmittedAccuracy: Float? = null
    private var lastTransmittedSource: String? = null
    private var isFirstDutyPoint = true
    private var lastGpsLocationTime: Long = 0L
    private var lastGpsElapsedRealtime: Long = 0L
    private var wasLocationAvailable: Boolean = true

    override fun onCreate() {
        super.onCreate()
        acquireWakeLock()
        startInForeground()
        registerNetworkCallback()
        startLocationUpdates()
        startPeriodicHeartbeats()
        startPeriodicOfflineSync()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = DishaApplication.instance.prefs
        if (!prefs.isLoggedIn) {
            stopTracking()
            stopSelf()
            return START_NOT_STICKY
        }

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
            ACTION_START_TRACKING, null -> {
                isFirstDutyPoint = true
                lastTrailRecordedElapsedRealtimeMs = 0L
                lastLiveTransmittedElapsedRealtimeMs = 0L
                // Idempotent: ensure updates are flowing and notification is current
                if (!isTrackingStarted) {
                    startLocationUpdates()
                }
                if (heartbeatJob == null || heartbeatJob?.isActive == false) {
                    startPeriodicHeartbeats()
                }
                if (offlineSyncJob == null || offlineSyncJob?.isActive == false) {
                    startPeriodicOfflineSync()
                }
                updateNotification(lastLocation)
            }
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        val prefs = DishaApplication.instance.prefs
        // When worker closes the app UI or removes Disha from Recent Apps, tracking MUST continue.
        // As a safeguard against aggressive OEM task killers, schedule an immediate restart alarm.
        if (prefs.isLoggedIn && DutyTimeHelper.isWithinDutyWindow()) {
            try {
                val restartIntent = Intent(applicationContext, LocationTrackingService::class.java).apply {
                    action = ACTION_START_TRACKING
                }
                val pendingIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    PendingIntent.getForegroundService(
                        applicationContext,
                        1001,
                        restartIntent,
                        PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
                    )
                } else {
                    PendingIntent.getService(
                        applicationContext,
                        1001,
                        restartIntent,
                        PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
                    )
                }
                val alarmManager = getSystemService(Context.ALARM_SERVICE) as? AlarmManager
                alarmManager?.set(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + 1000L,
                    pendingIntent
                )
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "DishaTracker::TrackingWakeLock"
        ).apply {
            setReferenceCounted(false)
            acquire(24 * 60 * 60 * 1000L) // Safe 24-hr max duration
        }
    }

    private var lastNetworkRestoreTriggerMs = 0L

    private fun registerNetworkCallback() {
        if (networkCallback != null) return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scheduleNetworkRestore()
            }

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                    scheduleNetworkRestore()
                }
            }
        }
        try {
            cm.registerDefaultNetworkCallback(networkCallback!!)
        } catch (_: Exception) {}
    }

    private fun scheduleNetworkRestore() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastNetworkRestoreTriggerMs < 3000L) return // Debounce rapid flapping
        lastNetworkRestoreTriggerMs = now

        serviceScope.launch {
            kotlinx.coroutines.delay(600) // Brief delay for socket/DNS routing to stabilize
            val prefs = DishaApplication.instance.prefs
            if (!prefs.isLoggedIn) return@launch

            // 1. Drain offline queue completely in batches
            try {
                DishaApplication.instance.repository.syncOfflineQueue()
            } catch (_: Exception) {}

            // 2. Immediately send Heartbeat so dashboard turns device ONLINE instantly
            try {
                val battery = getBatteryPercentage()
                val net = getNetworkType()
                val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                val locEnabled = if (lm != null) LocationManagerCompat.isLocationEnabled(lm) else false
                val fineGranted = ContextCompat.checkSelfPermission(
                    this@LocationTrackingService,
                    android.Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                DishaApplication.instance.repository.sendHeartbeat(
                    batteryLevel = battery,
                    networkState = net,
                    appVersion = "1.0.0",
                    locationEnabled = locEnabled,
                    permissionState = if (fineGranted) "GRANTED" else "PARTIAL",
                    isTrackingRunning = isTrackingStarted,
                    gpsAvailable = lm?.isProviderEnabled(LocationManager.GPS_PROVIDER) == true,
                    lastGpsFixTime = if (lastGpsLocationTime > 0L) DishaApplication.instance.repository.getIsoTimestamp(Date(lastGpsLocationTime)) else null
                )
            } catch (_: Exception) {}

            // 3. Immediately fetch and transmit fresh GPS location fix
            try {
                triggerImmediateLocationFetch()
            } catch (_: Exception) {}
        }
    }

    @SuppressLint("MissingPermission")
    fun triggerImmediateLocationFetch() {
        if (!hasLocationPermissions()) return
        try {
            fusedLocationClient?.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null)
                ?.addOnSuccessListener { loc ->
                    if (loc != null) {
                        handleNewLocation(loc, determineLocationSource(loc), forceTransmit = true)
                    } else {
                        fusedLocationClient?.lastLocation?.addOnSuccessListener { lastLoc ->
                            if (lastLoc != null) {
                                handleNewLocation(lastLoc, determineLocationSource(lastLoc), forceTransmit = true)
                            }
                        }
                    }
                }
        } catch (_: Exception) {}
    }

    private fun unregisterNetworkCallback() {
        networkCallback?.let {
            try {
                val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                cm?.unregisterNetworkCallback(it)
            } catch (_: Exception) {}
        }
        networkCallback = null
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

    /**
     * Determines whether a location fix should be categorized as GPS or NETWORK.
     * Google Play Services FusedLocationProviderClient sets location.provider = "fused".
     * A "fused" fix is satellite GNSS if:
     * - The provider is native GPS, OR
     * - The fix has satellite extras (satellites > 0), OR
     * - The fix has high-precision accuracy (<= 25m), typical of GNSS satellite lock.
     * Cellular tower and Wi-Fi triangulations without satellite locks typically exhibit accuracy > 30m.
     */
    private fun determineLocationSource(location: Location): String {
        if (location.provider == LocationManager.GPS_PROVIDER) {
            return "GPS"
        }
        if (location.provider == LocationManager.NETWORK_PROVIDER) {
            return "NETWORK"
        }
        val satellites = location.extras?.getInt("satellites", 0) ?: 0
        if (satellites > 0) {
            return "GPS"
        }
        if (location.hasAccuracy() && location.accuracy <= 25.0f) {
            return "GPS"
        }
        return "NETWORK"
    }

    @SuppressLint("MissingPermission")
    private fun startFusedLocationUpdates() {
        try {
            if (fusedLocationClient == null) {
                fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
            }
            locationCallback?.let {
                try { fusedLocationClient?.removeLocationUpdates(it) } catch (_: Exception) {}
            }

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
                    val source = determineLocationSource(location)
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
                        val source = determineLocationSource(loc)
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
                    handleNewLocation(bestCandidate, determineLocationSource(bestCandidate))
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override fun onLocationChanged(location: Location) {
        val src = determineLocationSource(location)
        handleNewLocation(location, src)
    }

    private fun handleNewLocation(location: Location, providerSource: String, forceTransmit: Boolean = false) {
        val prefs = DishaApplication.instance.prefs
        if (!prefs.isLoggedIn) {
            stopTracking()
            stopSelf()
            return
        }

        // 1. Mandatory Duty Window Enforcement: 07:00 AM – 07:00 PM IST
        if (!DutyTimeHelper.isWithinDutyWindow()) {
            updateNotification(lastLocation, "Standby: Outside authorised tracking window (07:00 AM – 07:00 PM IST)")
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
        if (ageMs > 60_000L && lastLocation != null && !forceTransmit) {
            return
        }

        // 4. Out-of-order check: Reject fixes timestamped older than last known by > 5 seconds
        val prev = lastLocation
        if (prev != null && location.time < prev.time - 5000L && !forceTransmit) {
            return
        }

        val determinedSource = if (providerSource == "GPS" || providerSource == "NETWORK") {
            providerSource
        } else {
            determineLocationSource(location)
        }

        // 5. Track GPS vs Network fix timestamp
        val isGpsFix = determinedSource == "GPS" || location.provider == LocationManager.GPS_PROVIDER
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
        if (location.hasAccuracy() && location.accuracy > 20f && prevVerified != null && !isSos && !forceTransmit) {
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
        val normalizedSource = if (isGpsFix) "GPS" else "NETWORK"

        // Always keep local notification and UI fresh with the latest real fix
        updateNotification(location)

        // 7. 10-Second Historical Trail Recording & Live Map Telemetry Gate:
        // - Live Map: Update real-time position on the admin dashboard every ~10 seconds (or on SOS / first fix / accuracy upgrade)
        // - Historical Trail: Persist historical trail point approximately every 10 seconds (10,000 ms)
        val nowElapsed = SystemClock.elapsedRealtime()
        val elapsedSinceLastTrail = nowElapsed - lastTrailRecordedElapsedRealtimeMs
        val isHistoricalDue = isSos || isFirstDutyPoint || (elapsedSinceLastTrail >= trailRecordingIntervalMs)

        val elapsedSinceLastLive = nowElapsed - lastLiveTransmittedElapsedRealtimeMs
        val lastAcc = lastTransmittedAccuracy
        val isAccuracyUpgrade = (lastAcc == null || lastAcc > 25.0f || lastTransmittedSource == "NETWORK") &&
                (location.hasAccuracy() && location.accuracy <= 20.0f && isGpsFix)

        val isLiveDue = forceTransmit || isSos || isFirstDutyPoint || isAccuracyUpgrade || (elapsedSinceLastLive >= LIVE_TRANSMISSION_INTERVAL_MS)

        android.util.Log.i(
            "DishaLocation",
            "Fix: lat=${location.latitude}, lon=${location.longitude}, acc=±${location.accuracy}m, rawProvider=${location.provider}, source=$normalizedSource, ageMs=$ageMs, isLiveDue=$isLiveDue, isUpgrade=$isAccuracyUpgrade, isHistorical=$isHistoricalDue"
        )

        if (!isLiveDue && !isHistoricalDue) {
            return
        }

        lastLiveTransmittedElapsedRealtimeMs = nowElapsed
        lastTransmittedAccuracy = location.accuracy
        lastTransmittedSource = normalizedSource

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
        if (heartbeatJob?.isActive == true) return
        heartbeatJob = serviceScope.launch {
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                val prefs = DishaApplication.instance.prefs
                if (!prefs.isLoggedIn) {
                    stopTracking()
                    stopSelf()
                    break
                }
                if (!DutyTimeHelper.isWithinDutyWindow()) {
                    updateNotification(lastLocation, "Standby: Outside authorised tracking window (07:00 AM – 07:00 PM IST)")
                    continue
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
        if (offlineSyncJob?.isActive == true) return
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
            !DutyTimeHelper.isWithinDutyWindow() -> "Standby: Outside authorised tracking window (07:00 AM – 07:00 PM IST)"
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
            else -> "DISHA Field Tracker — 24×7 Continuous Tracking Active"
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

        val builder = NotificationCompat.Builder(this, DishaApplication.CHANNEL_ID_TRACKING)
            .setContentTitle(title)
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_location)
            .setContentIntent(openActivityPendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)

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
        unregisterNetworkCallback()
        heartbeatJob?.cancel()
        heartbeatJob = null
        offlineSyncJob?.cancel()
        offlineSyncJob = null

        // Cancel running children without permanently killing the scope
        serviceScope.coroutineContext.cancelChildren()

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

        // 10-second trail recording interval (10,000 ms)
        const val DEFAULT_TRAIL_RECORDING_INTERVAL_MS = 10 * 1000L
        var trailRecordingIntervalMs: Long = DEFAULT_TRAIL_RECORDING_INTERVAL_MS

        // Live Map real-time transmission interval (10 seconds)
        const val LIVE_TRANSMISSION_INTERVAL_MS = 10_000L

        // Fused Location request intervals:
        // Request fresh location updates frequently enough to support strict 10-second telemetry & trail recording
        private const val LOCATION_INTERVAL_MS = 5_000L
        private const val LOCATION_FASTEST_INTERVAL_MS = 3_000L
        private const val LOCATION_MIN_DISTANCE_M = 0f
        private const val LOCATION_MAX_WAIT_MS = 4_000L

        // Heartbeat interval: strictly every 10 seconds
        private const val HEARTBEAT_INTERVAL_MS = 10_000L // 10 seconds
        // Fast retry for offline sync queue: every 10 seconds
        private const val OFFLINE_SYNC_INTERVAL_MS = 10_000L // 10 seconds fast retry

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
