package com.disha.locationtracker.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.widget.Toast
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import androidx.lifecycle.lifecycleScope
import com.disha.locationtracker.DishaApplication
import com.disha.locationtracker.R
import com.disha.locationtracker.data.model.LocationTelemetryPayload
import com.disha.locationtracker.databinding.ActivityMainBinding
import com.disha.locationtracker.databinding.DialogConsentBinding
import com.disha.locationtracker.databinding.DialogAppUpdateBinding
import com.disha.locationtracker.service.LocationTrackingService
import com.disha.locationtracker.update.DownloadProgressState
import com.disha.locationtracker.update.ReleaseInfo
import com.disha.locationtracker.util.DutyTimeHelper
import com.google.android.gms.common.api.ResolvableApiException
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.LocationSettingsRequest
import com.google.android.gms.location.Priority
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val prefs by lazy { DishaApplication.instance.prefs }
    private val repository by lazy { DishaApplication.instance.repository }
    private val apiClient by lazy { DishaApplication.instance.apiClient }
    private val updateManager by lazy { DishaApplication.instance.updateManager }

    private var hasReceivedLocationFix = false
    private var updateDialog: AlertDialog? = null
    private var isUpdateCheckInProgress = false
    private var lastUpdateCheckTime = 0L

    private val locationSettingsLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            startContinuousTrackingIfReady()
            updateOperationalState()
        }
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val fineGranted = permissions[Manifest.permission.ACCESS_FINE_LOCATION] == true
        val coarseGranted = permissions[Manifest.permission.ACCESS_COARSE_LOCATION] == true

        if (fineGranted) {
            checkBackgroundLocationPermission()
            checkDeviceLocationSettings()
            startContinuousTrackingIfReady()
        } else if (coarseGranted) {
            AlertDialog.Builder(this)
                .setTitle("Precise Location Required")
                .setMessage("Disha requires 'Precise Location' to achieve ≤20m GPS accuracy. Please enable 'Precise Location' in App Permissions.")
                .setPositiveButton("Configure") { _, _ ->
                    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = android.net.Uri.fromParts("package", packageName, null)
                    }
                    startActivity(intent)
                }
                .setNegativeButton("Continue") { _, _ ->
                    checkBackgroundLocationPermission()
                    checkDeviceLocationSettings()
                    startContinuousTrackingIfReady()
                }
                .show()
        } else {
            Toast.makeText(this, "Location permission is required for continuous tracking", Toast.LENGTH_LONG).show()
        }
        updateOperationalState()
    }

    private val backgroundPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        startContinuousTrackingIfReady()
        updateOperationalState()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!prefs.isLoggedIn) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupOfficerHeader()
        setupActionListeners()
        setupLocationObservers()
        checkTrackingDisclosure()
        requestInitialPermissions()
        checkForAppUpdate(isManual = false)
    }

    override fun onResume() {
        super.onResume()
        if (hasLocationPermissions()) {
            checkDeviceLocationSettings()
        }
        startContinuousTrackingIfReady()
        updateOperationalState()
        repository.refreshPendingCount()
        lifecycleScope.launch {
            try {
                repository.syncOfflineQueue()
            } catch (_: Exception) {}
        }
        ensureBackendDutyActive()

        if (System.currentTimeMillis() - lastUpdateCheckTime > 5 * 60 * 1000L) {
            checkForAppUpdate(isManual = false)
        }
    }

    private fun checkDeviceLocationSettings() {
        val locationRequest = LocationRequest.Builder(
            Priority.PRIORITY_HIGH_ACCURACY,
            5000L
        ).build()

        val builder = LocationSettingsRequest.Builder()
            .addLocationRequest(locationRequest)
            .setAlwaysShow(true)

        val client = LocationServices.getSettingsClient(this)
        client.checkLocationSettings(builder.build())
            .addOnFailureListener { exception ->
                if (exception is ResolvableApiException) {
                    try {
                        val intentSenderRequest = IntentSenderRequest.Builder(exception.resolution).build()
                        locationSettingsLauncher.launch(intentSenderRequest)
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                }
            }
    }

    private fun setupOfficerHeader() {
        binding.officerNameText.text = prefs.personnelName ?: prefs.username ?: "Field Officer"
        binding.officerDetailsText.text = "Personnel ID: ${prefs.personnelId ?: "N/A"} | Device: ${prefs.deviceIdentifier}"

        binding.logoutButton.setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("Sign Out")
                .setMessage("Signing out will cease 24/7 location tracking and disconnect this device. Continue?")
                .setPositiveButton("Sign Out") { _, _ ->
                    performSignOut()
                }
                .setNegativeButton("Cancel", null)
                .show()
        }
    }

    private fun setupActionListeners() {
        // GPS Settings Button (shown when device GPS is off)
        binding.btnEnableLocation.setOnClickListener {
            startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
        }

        // Permission Request Button (shown when permission is missing)
        binding.btnGrantPermission.setOnClickListener {
            requestInitialPermissions()
        }

        // Emergency SOS Button
        binding.sosButton.setOnClickListener {
            if (prefs.isSosActive) {
                confirmCancelSOS()
            } else {
                confirmTriggerSOS()
            }
        }

        // Enable Precise Location Button (shown when approximate/coarse-only permission is active)
        binding.btnEnablePreciseLocation.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                permissionLauncher.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                    )
                )
            } else {
                try {
                    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = android.net.Uri.fromParts("package", packageName, null)
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    requestInitialPermissions()
                }
            }
        }
    }

    private fun setupLocationObservers() {
        repository.lastLocation.observe(this) { loc ->
            loc?.let {
                hasReceivedLocationFix = true
                renderLocation(it)
                updateOperationalState()
            }
        }

        repository.pendingCount.observe(this) { count ->
            if (count > 0) {
                binding.offlineNoticeCard.visibility = View.VISIBLE
                binding.offlineNoticeText.text = "Offline cache: $count updates queued (Auto-syncing in background...)"
            } else {
                binding.offlineNoticeCard.visibility = View.GONE
            }
        }

        repository.lastSentTime.observe(this) { time ->
            binding.lastUpdatedText.text = time
        }
    }

    private fun renderLocation(loc: LocationTelemetryPayload) {
        val acc = loc.accuracy
        val statusLabel = when {
            acc <= 10.0f -> "Optimal (≤10m Target Met)"
            acc <= 20.0f -> "Verified (≤20m)"
            else -> "Low Accuracy (>20m Searching GPS...)"
        }
        val accColor = when {
            acc <= 10.0f -> ContextCompat.getColor(this, R.color.success)
            acc <= 20.0f -> ContextCompat.getColor(this, R.color.primary)
            else -> ContextCompat.getColor(this, R.color.warning)
        }

        binding.coordinatesText.text = String.format(Locale.US, "%.5f, %.5f", loc.latitude, loc.longitude)
        binding.accuracyText.text = String.format(Locale.US, "±%.1f m (%s) • %s", acc, loc.source, statusLabel)
        binding.accuracyText.setTextColor(accColor)
        val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        binding.lastUpdatedText.text = timeStr
    }

    /**
     * Starts continuous tracking whenever logged in and system requirements (GPS + permissions) are met.
     */
    private fun startContinuousTrackingIfReady() {
        if (!prefs.isLoggedIn) return

        if (hasLocationPermissions() && isLocationServiceEnabled()) {
            LocationTrackingService.start(this)
            ensureBackendDutyActive()
        }
    }

    /**
     * Registers active duty status on the backend so the control room overview shows the personnel as active.
     */
    private fun ensureBackendDutyActive() {
        val personnelId = prefs.personnelId
        val deviceId = prefs.deviceIdentifier
        if (prefs.dutySessionId.isNullOrBlank() && !personnelId.isNullOrBlank()) {
            lifecycleScope.launch {
                try {
                    val result = apiClient.startDuty(personnelId, deviceId)
                    if (result.isSuccess) {
                        val session = result.getOrNull()?.session
                        prefs.dutySessionId = session?.id
                        prefs.dutyStatus = "TRACKING_ACTIVE"
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
    }

    /**
     * Shows informed consent disclosure on first launch after sign in.
     */
    private fun checkTrackingDisclosure() {
        if (prefs.consentGivenAt == 0L) {
            val dialogBinding = DialogConsentBinding.inflate(LayoutInflater.from(this))
            val dialog = AlertDialog.Builder(this)
                .setView(dialogBinding.root)
                .setCancelable(false)
                .setPositiveButton(R.string.consent_agree, null)
                .setNegativeButton(R.string.consent_cancel) { _, _ ->
                    performSignOut()
                }
                .create()

            dialog.setOnShowListener {
                val positiveButton = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                positiveButton.isEnabled = false

                dialogBinding.consentCheckbox.setOnCheckedChangeListener { _, isChecked ->
                    positiveButton.isEnabled = isChecked
                }

                positiveButton.setOnClickListener {
                    prefs.consentGivenAt = System.currentTimeMillis()
                    dialog.dismiss()
                    startContinuousTrackingIfReady()
                    updateOperationalState()
                }
            }

            dialog.show()
        }
    }

    /**
     * Checks all operational parameters (Permissions, GPS hardware state, and Live Fix)
     * and updates the UI accurately without misleading states.
     */
    private fun updateOperationalState() {
        val isSos = prefs.isSosActive
        val hasPermissions = hasLocationPermissions()
        val isGpsEnabled = isLocationServiceEnabled()

        // 1. Update GPS hardware disabled banner
        binding.gpsDisabledCard.visibility = if (!isGpsEnabled) View.VISIBLE else View.GONE

        // 2. Update Permission banner (missing any location permission)
        binding.permissionCard.visibility = if (!hasPermissions) View.VISIBLE else View.GONE

        // 3. Update Approximate-only Warning banner (coarse granted, fine missing)
        val coarseOnly = hasCoarseOnlyPermission()
        binding.approximateLocationCard.visibility = if (isGpsEnabled && coarseOnly) View.VISIBLE else View.GONE

        val isDutyHours = DutyTimeHelper.isWithinDutyWindow()

        // 3. Update Tracking Status Badge & Text
        when {
            isSos -> {
                binding.trackingBadge.text = getString(R.string.status_sos_active)
                binding.trackingBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.danger_surface))
                binding.trackingBadge.setTextColor(ContextCompat.getColor(this, R.color.danger))

                binding.trackingStatusIcon.setColorFilter(ContextCompat.getColor(this, R.color.danger))
                binding.trackingStatusText.text = "EMERGENCY SOS ACTIVE • High-frequency transmission"
                binding.trackingStatusText.setTextColor(ContextCompat.getColor(this, R.color.danger))

                binding.sosButton.text = getString(R.string.cancel_sos)
                binding.sosButton.setBackgroundColor(ContextCompat.getColor(this, R.color.warning))
            }
            !isGpsEnabled -> {
                binding.trackingBadge.text = getString(R.string.status_location_off)
                binding.trackingBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.warning_surface))
                binding.trackingBadge.setTextColor(ContextCompat.getColor(this, R.color.warning))

                binding.trackingStatusIcon.setColorFilter(ContextCompat.getColor(this, R.color.warning))
                binding.trackingStatusText.text = "Location is OFF — Turn on GPS in Android settings"
                binding.trackingStatusText.setTextColor(ContextCompat.getColor(this, R.color.warning))

                binding.sosButton.text = getString(R.string.trigger_sos)
                binding.sosButton.setBackgroundColor(ContextCompat.getColor(this, R.color.danger))
            }
            !hasPermissions -> {
                binding.trackingBadge.text = getString(R.string.status_permission_required)
                binding.trackingBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.danger_surface))
                binding.trackingBadge.setTextColor(ContextCompat.getColor(this, R.color.danger))

                binding.trackingStatusIcon.setColorFilter(ContextCompat.getColor(this, R.color.danger))
                binding.trackingStatusText.text = "Permission Required — Location access missing"
                binding.trackingStatusText.setTextColor(ContextCompat.getColor(this, R.color.danger))

                binding.sosButton.text = getString(R.string.trigger_sos)
                binding.sosButton.setBackgroundColor(ContextCompat.getColor(this, R.color.danger))
            }
            !isDutyHours -> {
                binding.trackingBadge.text = "STANDBY"
                binding.trackingBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.primary_light))
                binding.trackingBadge.setTextColor(ContextCompat.getColor(this, R.color.primary_dark))

                binding.trackingStatusIcon.setColorFilter(ContextCompat.getColor(this, R.color.primary))
                binding.trackingStatusText.text = "Authorised tracking window (07:00 AM – 07:00 PM IST) • Resumes at 07:00 AM"
                binding.trackingStatusText.setTextColor(ContextCompat.getColor(this, R.color.primary))

                binding.sosButton.text = getString(R.string.trigger_sos)
                binding.sosButton.setBackgroundColor(ContextCompat.getColor(this, R.color.danger))
            }
            hasReceivedLocationFix -> {
                val lastSource = repository.lastLocation.value?.source
                val isNetworkFallback = lastSource == "NETWORK"
                val acc = repository.lastLocation.value?.accuracy ?: 0f

                if (isNetworkFallback) {
                    binding.trackingBadge.text = "NETWORK FALLBACK (±${Math.round(acc)}m)"
                    binding.trackingBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.primary_light))
                    binding.trackingBadge.setTextColor(ContextCompat.getColor(this, R.color.primary))

                    binding.trackingStatusIcon.setColorFilter(ContextCompat.getColor(this, R.color.primary))
                    binding.trackingStatusText.text = "Network Location Active • Cellular/Wi-Fi fallback"
                    binding.trackingStatusText.setTextColor(ContextCompat.getColor(this, R.color.primary))
                } else {
                    binding.trackingBadge.text = getString(R.string.status_tracking_active)
                    binding.trackingBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.success_surface))
                    binding.trackingBadge.setTextColor(ContextCompat.getColor(this, R.color.success))

                    binding.trackingStatusIcon.setColorFilter(ContextCompat.getColor(this, R.color.success))
                    binding.trackingStatusText.text = "24×7 GPS Tracking Active • ≤20m verified satellite fixes"
                    binding.trackingStatusText.setTextColor(ContextCompat.getColor(this, R.color.success))
                }

                binding.sosButton.text = getString(R.string.trigger_sos)
                binding.sosButton.setBackgroundColor(ContextCompat.getColor(this, R.color.danger))
            }
            else -> {
                binding.trackingBadge.text = getString(R.string.status_waiting_gps)
                binding.trackingBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.primary_light))
                binding.trackingBadge.setTextColor(ContextCompat.getColor(this, R.color.primary_dark))

                binding.trackingStatusIcon.setColorFilter(ContextCompat.getColor(this, R.color.primary))
                binding.trackingStatusText.text = "Acquiring GPS fix..."
                binding.trackingStatusText.setTextColor(ContextCompat.getColor(this, R.color.primary))

                binding.sosButton.text = getString(R.string.trigger_sos)
                binding.sosButton.setBackgroundColor(ContextCompat.getColor(this, R.color.danger))
            }
        }
    }

    private fun isLocationServiceEnabled(): Boolean {
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false
        return LocationManagerCompat.isLocationEnabled(lm)
    }

    private fun hasFineLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasCoarseOnlyPermission(): Boolean {
        val fine = hasFineLocationPermission()
        val coarse = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return !fine && coarse
    }

    private fun hasLocationPermissions(): Boolean {
        return hasFineLocationPermission() || hasCoarseOnlyPermission()
    }

    private fun confirmTriggerSOS() {
        AlertDialog.Builder(this)
            .setTitle("EMERGENCY SOS")
            .setMessage("This will immediately send an Emergency SOS distress alert to the DISHA Command Center with your real-time coordinates. Proceed?")
            .setPositiveButton("TRIGGER SOS") { _, _ ->
                lifecycleScope.launch {
                    val success = repository.triggerSOS()
                    updateOperationalState()
                    if (success) {
                        Toast.makeText(this@MainActivity, "EMERGENCY SOS BROADCAST ACTIVE!", Toast.LENGTH_LONG).show()
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun confirmCancelSOS() {
        AlertDialog.Builder(this)
            .setTitle("Cancel Emergency SOS")
            .setMessage("Are you sure you want to resolve and cancel the Emergency SOS broadcast?")
            .setPositiveButton("Cancel SOS") { _, _ ->
                lifecycleScope.launch {
                    repository.cancelSOS()
                    updateOperationalState()
                    Toast.makeText(this@MainActivity, "Emergency SOS cancelled.", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Keep Active", null)
            .show()
    }

    private fun performSignOut() {
        LocationTrackingService.stop(this)
        val personnelId = prefs.personnelId
        val deviceId = prefs.deviceIdentifier
        lifecycleScope.launch {
            if (!personnelId.isNullOrBlank()) {
                try {
                    apiClient.signOut(personnelId, deviceId)
                } catch (e: Exception) {
                    e.printStackTrace()
                }
                try {
                    apiClient.endDuty(personnelId)
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
            prefs.clearAuth()
            startActivity(Intent(this@MainActivity, LoginActivity::class.java))
            finish()
        }
    }

    private fun requestInitialPermissions() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        permissionLauncher.launch(perms.toTypedArray())
    }

    private fun checkBackgroundLocationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val bgGranted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ) == PackageManager.PERMISSION_GRANTED

            if (!bgGranted) {
                AlertDialog.Builder(this)
                    .setTitle("Continuous Background Tracking")
                    .setMessage(
                        "To ensure DISHA continues monitoring officer location when you switch to other apps (like WhatsApp or Calculator), press Home, or lock the screen, Android requires 'Allow all the time' location access.\n\n" +
                        "1. Tap 'Configure Permission'\n" +
                        "2. Select 'Permissions' -> 'Location'\n" +
                        "3. Select 'Allow all the time'"
                    )
                    .setPositiveButton("Configure Permission") { _, _ ->
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                            try {
                                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                    data = android.net.Uri.fromParts("package", packageName, null)
                                }
                                startActivity(intent)
                            } catch (e: Exception) {
                                backgroundPermissionLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                            }
                        } else {
                            backgroundPermissionLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                        }
                    }
                    .setNegativeButton("Later") { _, _ ->
                        checkBatteryOptimization()
                    }
                    .show()
            } else {
                checkBatteryOptimization()
            }
        } else {
            checkBatteryOptimization()
        }
    }

    private fun checkBatteryOptimization() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val powerManager = getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
            if (powerManager != null && !powerManager.isIgnoringBatteryOptimizations(packageName)) {
                AlertDialog.Builder(this)
                    .setTitle("Disable Battery Throttling")
                    .setMessage(
                        "To prevent Android and device manufacturers (Samsung, Xiaomi, OnePlus, Vivo) from freezing GPS tracking in the background:\n\n" +
                        "Please allow DISHA to run 'Unrestricted' in Battery Optimization settings."
                    )
                    .setPositiveButton("Open Settings") { _, _ ->
                        try {
                            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                                data = android.net.Uri.parse("package:$packageName")
                            }
                            startActivity(intent)
                        } catch (e: Exception) {
                            try {
                                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                            } catch (_: Exception) {}
                        }
                    }
                    .setNegativeButton("Dismiss", null)
                    .show()
            }
        }
    }

    private fun checkForAppUpdate(isManual: Boolean = false) {
        if (isUpdateCheckInProgress) return
        isUpdateCheckInProgress = true
        lastUpdateCheckTime = System.currentTimeMillis()

        lifecycleScope.launch {
            try {
                val result = updateManager.checkForUpdate()
                if (result.isSuccess) {
                    val update = result.getOrNull()
                    if (update != null && update.updateAvailable && update.latestRelease != null) {
                        showUpdateDialog(update.latestRelease)
                    } else if (isManual) {
                        Toast.makeText(
                            this@MainActivity,
                            "App is up to date (v${updateManager.getCurrentVersionName()})",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                } else if (isManual) {
                    val err = result.exceptionOrNull()?.message ?: "Check failed"
                    Toast.makeText(this@MainActivity, "Update check failed: $err", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                if (isManual) {
                    Toast.makeText(this@MainActivity, "Update error: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } finally {
                isUpdateCheckInProgress = false
            }
        }
    }

    private fun showUpdateDialog(release: ReleaseInfo) {
        if (isFinishing || isDestroyed) return
        if (updateDialog?.isShowing == true) return

        val dialogBinding = DialogAppUpdateBinding.inflate(layoutInflater)

        dialogBinding.updateTitle.text = "Software Update Available"
        dialogBinding.versionSubtitle.text = "Version ${release.versionName} (Code ${release.versionCode}) • Current: v${updateManager.getCurrentVersionName()}"
        dialogBinding.releaseNotesText.text = release.releaseNotes

        if (release.isMandatory) {
            dialogBinding.updatePolicyBadge.visibility = View.VISIBLE
            dialogBinding.updatePolicyBadge.text = "CRITICAL MANDATORY UPDATE"
            dialogBinding.laterButton.visibility = View.GONE
        } else {
            dialogBinding.updatePolicyBadge.visibility = View.GONE
            dialogBinding.laterButton.visibility = View.VISIBLE
        }

        val dialog = AlertDialog.Builder(this)
            .setView(dialogBinding.root)
            .setCancelable(!release.isMandatory)
            .create()

        if (release.isMandatory) {
            dialog.setCanceledOnTouchOutside(false)
        }

        dialogBinding.laterButton.setOnClickListener {
            dialog.dismiss()
        }

        dialogBinding.updateButton.setOnClickListener {
            dialogBinding.updateButton.isEnabled = false
            dialogBinding.laterButton.isEnabled = false
            dialogBinding.progressSection.visibility = View.VISIBLE
            dialogBinding.downloadProgressBar.isIndeterminate = false
            dialogBinding.downloadProgressBar.progress = 0
            dialogBinding.progressStatusText.text = "Connecting to server..."

            lifecycleScope.launch {
                val downloadResult = updateManager.downloadAndVerifyApk(release) { state ->
                    runOnUiThread {
                        when (state) {
                            is DownloadProgressState.Downloading -> {
                                if (state.totalBytes > 0) {
                                    dialogBinding.downloadProgressBar.isIndeterminate = false
                                    dialogBinding.downloadProgressBar.progress = state.progressPercent
                                    val downloadedMb = state.bytesDownloaded / (1024.0 * 1024.0)
                                    val totalMb = state.totalBytes / (1024.0 * 1024.0)
                                    dialogBinding.progressStatusText.text = "Downloading: ${state.progressPercent}% (%.1f MB / %.1f MB)".format(Locale.US, downloadedMb, totalMb)
                                } else {
                                    dialogBinding.downloadProgressBar.isIndeterminate = true
                                    val downloadedMb = state.bytesDownloaded / (1024.0 * 1024.0)
                                    dialogBinding.progressStatusText.text = "Downloading: %.1f MB".format(Locale.US, downloadedMb)
                                }
                            }
                            is DownloadProgressState.VerifyingChecksum -> {
                                dialogBinding.downloadProgressBar.isIndeterminate = true
                                dialogBinding.progressStatusText.text = "Verifying SHA-256 cryptographic checksum..."
                            }
                            is DownloadProgressState.ReadyToInstall -> {
                                dialogBinding.downloadProgressBar.isIndeterminate = false
                                dialogBinding.downloadProgressBar.progress = 100
                                dialogBinding.progressStatusText.text = "Verification passed! Launching installer..."
                            }
                            is DownloadProgressState.Error -> {
                                dialogBinding.downloadProgressBar.isIndeterminate = false
                                dialogBinding.progressStatusText.text = "Error: ${state.message}"
                                dialogBinding.updateButton.isEnabled = true
                                dialogBinding.updateButton.text = "Retry"
                                if (!release.isMandatory) {
                                    dialogBinding.laterButton.isEnabled = true
                                }
                            }
                            else -> Unit
                        }
                    }
                }

                if (downloadResult.isSuccess) {
                    val apkFile = downloadResult.getOrNull()
                    if (apkFile != null) {
                        if (!updateManager.canRequestPackageInstalls()) {
                            Toast.makeText(
                                this@MainActivity,
                                "Please grant permission to install updates",
                                Toast.LENGTH_LONG
                            ).show()
                            updateManager.requestInstallPermission(this@MainActivity)
                        } else {
                            updateManager.launchApkInstaller(this@MainActivity, apkFile)
                        }
                    }
                }
            }
        }

        updateDialog = dialog
        dialog.show()
    }
}
