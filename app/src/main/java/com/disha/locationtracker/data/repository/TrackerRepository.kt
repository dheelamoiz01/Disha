package com.disha.locationtracker.data.repository

import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import com.disha.locationtracker.DishaApplication
import com.disha.locationtracker.data.local.AppPreferences
import com.disha.locationtracker.data.local.OfflineLocationDbHelper
import com.disha.locationtracker.data.model.*
import com.disha.locationtracker.data.remote.ApiClient
import com.disha.locationtracker.service.LocationTrackingService
import com.disha.locationtracker.util.DutyTimeHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.*

class TrackerRepository(
    private val prefs: AppPreferences,
    private val dbHelper: OfflineLocationDbHelper,
    private val apiClient: ApiClient
) {

    private val _lastLocation = MutableLiveData<LocationTelemetryPayload?>()
    val lastLocation: LiveData<LocationTelemetryPayload?> = _lastLocation

    private val _pendingCount = MutableLiveData<Int>()
    val pendingCount: LiveData<Int> = _pendingCount

    private val _lastSentTime = MutableLiveData<String>()
    val lastSentTime: LiveData<String> = _lastSentTime

    private val isoDateFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    init {
        refreshPendingCount()
    }

    fun refreshPendingCount() {
        _pendingCount.postValue(dbHelper.getPendingCount())
    }

    fun getIsoTimestamp(date: Date = Date()): String {
        return synchronized(isoDateFormat) {
            isoDateFormat.format(date)
        }
    }

    suspend fun recordAndTransmitLocation(
        latitude: Double,
        longitude: Double,
        accuracy: Float,
        source: String,
        locationTimestamp: Long = System.currentTimeMillis(),
        batteryLevel: Float? = null,
        networkState: String? = null
    ): Boolean = withContext(Dispatchers.IO) {
        // Enforce duty window (07:00 AM - 10:00 PM IST):
        // Only location data collected during the permitted duty window may be uploaded to backend or persisted
        if (!DutyTimeHelper.isWithinDutyWindow(locationTimestamp)) {
            return@withContext false
        }

        val clientEventId = UUID.randomUUID().toString()
        val recordedAt = getIsoTimestamp(Date(locationTimestamp))
        val trackingMode = if (prefs.isSosActive) "SOS" else "NORMAL"

        val payload = LocationTelemetryPayload(
            clientEventId = clientEventId,
            latitude = latitude,
            longitude = longitude,
            accuracy = accuracy,
            recordedAt = recordedAt,
            source = source,
            trackingMode = trackingMode,
            batteryLevel = batteryLevel,
            networkState = networkState
        )

        _lastLocation.postValue(payload)

        // Try direct transmission if online
        val result = apiClient.sendLocation(payload)
        if (result.isSuccess) {
            val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
            _lastSentTime.postValue(timeStr)
            // Also attempt to drain offline queue
            syncOfflineQueueInternal()
            refreshPendingCount()
            true
        } else {
            val errorMsg = result.exceptionOrNull()?.message.orEmpty()
            if (errorMsg.contains("401") || errorMsg.contains("403")) {
                // Authorization revoked or session expired: stop duty tracking safely
                prefs.dutyStatus = "OFF_DUTY"
                prefs.isSosActive = false
                LocationTrackingService.stop(DishaApplication.instance)
            } else {
                // Buffer to SQLite on temporary network failure or server 5xx (only during duty window)
                if (DutyTimeHelper.isWithinDutyWindow(locationTimestamp)) {
                    val record = CachedLocationRecord(
                        clientEventId = clientEventId,
                        latitude = latitude,
                        longitude = longitude,
                        accuracy = accuracy,
                        recordedAt = recordedAt,
                        source = source,
                        trackingMode = trackingMode,
                        batteryLevel = batteryLevel,
                        networkState = networkState
                    )
                    dbHelper.insertLocation(record)
                    refreshPendingCount()
                }
            }
            false
        }
    }

    suspend fun syncOfflineQueue(): Int = withContext(Dispatchers.IO) {
        val synced = syncOfflineQueueInternal()
        refreshPendingCount()
        synced
    }

    private suspend fun syncOfflineQueueInternal(): Int {
        val pending = dbHelper.getPendingLocations(limit = 50)
        if (pending.isEmpty()) return 0

        // Prune any records that fall outside duty hours
        val validPending = pending.filter { item ->
            try {
                val parsed = synchronized(isoDateFormat) { isoDateFormat.parse(item.recordedAt) }
                if (parsed != null && !DutyTimeHelper.isWithinDutyWindow(parsed.time)) {
                    dbHelper.deleteLocationByEventId(item.clientEventId)
                    false
                } else {
                    true
                }
            } catch (_: Exception) {
                true
            }
        }

        if (validPending.isEmpty()) return 0

        val payloads = validPending.map { item ->
            LocationTelemetryPayload(
                clientEventId = item.clientEventId,
                latitude = item.latitude,
                longitude = item.longitude,
                accuracy = item.accuracy,
                recordedAt = item.recordedAt,
                source = item.source,
                trackingMode = item.trackingMode,
                batteryLevel = item.batteryLevel,
                networkState = item.networkState
            )
        }

        val request = BatchIngestionRequest(locations = payloads)
        val result = apiClient.sendBatch(request)

        if (result.isSuccess) {
            val response = result.getOrNull()
            var count = 0
            response?.locations?.forEach { item ->
                if (item.status == "accepted" || item.status == "deduplicated") {
                    dbHelper.deleteLocationByEventId(item.clientEventId)
                    count++
                }
            }
            if (count > 0) {
                val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                _lastSentTime.postValue("$timeStr (Synced $count offline)")
            }
            return count
        } else {
            val errorMsg = result.exceptionOrNull()?.message.orEmpty()
            if (errorMsg.contains("401") || errorMsg.contains("403")) {
                prefs.dutyStatus = "OFF_DUTY"
                LocationTrackingService.stop(DishaApplication.instance)
                return 0
            }
            // Fallback to sequential if batch fails
            var count = 0
            for (item in pending.take(10)) {
                val payload = LocationTelemetryPayload(
                    clientEventId = item.clientEventId,
                    latitude = item.latitude,
                    longitude = item.longitude,
                    accuracy = item.accuracy,
                    recordedAt = item.recordedAt,
                    source = item.source,
                    trackingMode = item.trackingMode,
                    batteryLevel = item.batteryLevel,
                    networkState = item.networkState
                )
                val singleResult = apiClient.sendLocation(payload)
                if (singleResult.isSuccess) {
                    dbHelper.deleteLocationByEventId(item.clientEventId)
                    count++
                } else {
                    break
                }
            }
            if (count > 0) {
                val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                _lastSentTime.postValue("$timeStr (Synced $count offline)")
            }
            return count
        }
    }

    suspend fun sendHeartbeat(
        batteryLevel: Float?,
        networkState: String?,
        appVersion: String?,
        locationEnabled: Boolean? = null,
        permissionState: String? = null,
        isTrackingRunning: Boolean? = null,
        gpsAvailable: Boolean? = null,
        lastGpsFixTime: String? = null
    ): Boolean = withContext(Dispatchers.IO) {
        val personnelId = prefs.personnelId ?: return@withContext false
        val payload = HeartbeatPayload(
            personnelId = personnelId,
            batteryLevel = batteryLevel,
            networkState = networkState,
            appVersion = appVersion,
            healthState = if (prefs.isSosActive) "SOS" else "HEALTHY",
            recordedAt = getIsoTimestamp(),
            locationEnabled = locationEnabled,
            permissionState = permissionState,
            isTrackingRunning = isTrackingRunning,
            gpsAvailable = gpsAvailable,
            lastGpsFixTime = lastGpsFixTime
        )
        val result = apiClient.sendHeartbeat(payload)
        if (result.isFailure) {
            val err = result.exceptionOrNull()?.message.orEmpty()
            if (err.contains("401") || err.contains("403")) {
                prefs.dutyStatus = "OFF_DUTY"
                LocationTrackingService.stop(DishaApplication.instance)
            }
        }
        result.isSuccess
    }

    suspend fun sendLocationEvent(
        eventType: String,
        metadata: Map<String, Any>? = null
    ): Boolean = withContext(Dispatchers.IO) {
        val payload = LocationEventPayload(
            clientEventId = UUID.randomUUID().toString(),
            eventType = eventType,
            recordedAt = getIsoTimestamp(),
            metadata = metadata
        )
        val result = apiClient.sendEvent(payload)
        result.isSuccess
    }

    suspend fun triggerSOS(): Boolean = withContext(Dispatchers.IO) {
        val clientEventId = UUID.randomUUID().toString()
        val result = apiClient.startSOS(clientEventId)
        if (result.isSuccess) {
            prefs.isSosActive = true
            prefs.dutyStatus = "SOS_ACTIVE"
            true
        } else {
            false
        }
    }

    suspend fun cancelSOS(): Boolean = withContext(Dispatchers.IO) {
        val clientEventId = UUID.randomUUID().toString()
        val result = apiClient.endSOS(clientEventId)
        if (result.isSuccess) {
            prefs.isSosActive = false
            prefs.dutyStatus = "TRACKING_ACTIVE"
            true
        } else {
            false
        }
    }
}
